// routes/waEmbedded.js
import { gget, gpost } from '../services/metaGraph.js';

async function waEmbeddedRoutes(fastify) {

  // routes/waEmbedded.js (trecho)
fastify.post('/es/pick-number', async (req, reply) => {
  const { subdomain, phone_number_id } = req.body || {};
  if (!subdomain || !phone_number_id) {
    return reply.code(400).send({ error: 'missing_params' });
  }
  if (!req.db) return reply.code(500).send({ error: 'db_not_available' });

  // resolve tenant
  const tRes = await req.db.query(
    `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
    [subdomain]
  );
  const tenant = tRes.rows[0];
  if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });

  // ✅ ativa só o escolhido; NÃO mexe nos demais
  await req.db.query(`
    UPDATE public.tenant_channel_connections
       SET is_active = true,
           updated_at = now()
     WHERE tenant_id = $1
       AND channel   = 'whatsapp'
       AND provider  = 'meta'
       AND external_id = $2
  `, [tenant.id, phone_number_id]);

  return reply.send({ ok: true, tenant_id: tenant.id, phone_number_id });
});


  // ============ FINALIZE (Embedded Signup) ============
  // POST /api/v1/wa/es/finalize
  fastify.post('/es/finalize', async (req, reply) => {
    // subdomain: preferir do plugin; fallback do body/header
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers['x-tenant-subdomain'] ||
      req?.body?.subdomain;

    const { code } = req.body || {};
    if (!code || !subdomain) {
      return reply.code(400).send({ error: 'missing_code_or_subdomain' });
    }

    const {
      META_APP_ID,
      META_APP_SECRET,
      META_REDIRECT_URI,
      YOUR_BUSINESS_ID,
      SYSTEM_USER_ID,
      SYSTEM_USER_TOKEN,
      SYSTEM_USER_ADMIN_TOKEN
    } = process.env;

    if (!META_APP_ID || !META_APP_SECRET) {
      return reply.code(500).send({ error: 'meta_app_credentials_missing' });
    }
    if (!YOUR_BUSINESS_ID || !SYSTEM_USER_ID || !SYSTEM_USER_TOKEN) {
      return reply.code(500).send({ error: 'system_user_or_business_env_missing' });
    }
    if (!req.db) {
      return reply.code(500).send({ error: 'db_not_available' });
    }

    try {
      // 0) resolver tenant_id
      const tRes = await req.db.query(
        `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenantRow = tRes.rows[0];
      if (!tenantRow) return reply.code(404).send({ error: 'tenant_not_found', subdomain });
      const tenantId = tenantRow.id;

      // 1) exchange code -> user access_token
      const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
      if (META_REDIRECT_URI) qs.redirect_uri = META_REDIRECT_URI;
      const tok = await gget('/oauth/access_token', { qs });
      const userToken = tok.access_token;

      // 2) descobrir WABA_ID
      let wabaId = null;

      // 2a) via /debug_token (granular_scopes)
      try {
        const dbg = await gget('/debug_token', {
          qs: {
            input_token: userToken,
            access_token: `${META_APP_ID}|${META_APP_SECRET}`
          }
        });
        const gs = dbg?.data?.granular_scopes || [];
        const mgmt = gs.find(s =>
          s?.scope === 'whatsapp_business_management' && Array.isArray(s?.target_ids)
        );
        wabaId = mgmt?.target_ids?.[0] || null;
      } catch (e) {
        fastify.log.warn({ err: e }, '[wa/es/finalize] debug_token fallback');
      }

      // 2b) fallback: WABA(s) compartilhadas com seu Business
      if (!wabaId) {
        const shared = await gget(`/${YOUR_BUSINESS_ID}/client_whatsapp_business_accounts`, {
          token: SYSTEM_USER_TOKEN
        });
        wabaId = shared?.data?.[0]?.id || null;
      }
      if (!wabaId) return reply.code(400).send({ error: 'no_waba_found' });

      // 3) assinar webhooks do seu app na WABA
      await gpost(`/${wabaId}/subscribed_apps`, { token: userToken });

      // 4) dar MANAGE ao seu System User
      await gpost(`/${wabaId}/assigned_users`, {
        token: SYSTEM_USER_ADMIN_TOKEN || SYSTEM_USER_TOKEN,
        // Graph aceita tasks como string "['MANAGE']" em x-www-form-urlencoded
        form: { user: SYSTEM_USER_ID, tasks: "['MANAGE']" }
      });

      // 5) listar números
      const pn = await gget(`/${wabaId}/phone_numbers`, { token: SYSTEM_USER_TOKEN });
      const numbers = Array.isArray(pn?.data) ? pn.data : [];

      // 6) persistir conexões — insere como INATIVO; não tocar no is_active no upsert
      const qUpsert = `
        INSERT INTO public.tenant_channel_connections
          (tenant_id, subdomain, channel, provider, account_id, external_id, display_name, auth_mode, settings, is_active)
        VALUES
          ($1,        $2,        'whatsapp','meta',  $3,         $4,          $5,           'system_user', $6,       true)
        ON CONFLICT (tenant_id, channel, external_id)
        DO UPDATE SET
          account_id  = EXCLUDED.account_id,
          display_name= EXCLUDED.display_name,
          settings    = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
          updated_at  = now()
      `;

      for (const num of numbers) {
        const phoneId  = num?.id;
        if (!phoneId) continue;
        const disp     = num?.display_phone_number || num?.verified_name || null;
        const settings = { waba_id: wabaId, raw: num };
        await req.db.query(qUpsert, [
          tenantId,
          subdomain,
          wabaId,
          phoneId,
          disp,
          JSON.stringify(settings)
        ]);
      }

      return reply.send({
        subdomain,
        tenant_id: tenantId,
        waba_id: wabaId,
        numbers
      });
    } catch (err) {
      fastify.log.error(err, '[wa/es/finalize] falha no onboarding');
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return reply.code(status).send({
        error: 'wa_embedded_finalize_failed',
        message: err?.message || 'Erro inesperado',
        details: err?.details
      });
    }
  });

  fastify.get('/status', async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers['x-tenant-subdomain'] ||
      req?.query?.subdomain;

    if (!subdomain) {
      return reply.code(400).send({ ok: false, error: 'missing_subdomain' });
    }
    if (!req.db) {
      return reply.code(500).send({ ok: false, error: 'db_not_available' });
    }

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.send({ ok: true, connected: false });

      // Todas as conexões WA/Meta do tenant
      const q = `
        SELECT external_id, display_name, is_active, settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'whatsapp'
           AND provider  = 'meta'
      `;
      const { rows } = await req.db.query(q, [tenant.id]);

      if (!rows.length) {
        return reply.send({ ok: true, connected: false, waba_id: null, numbers: [] });
      }

      // waba_id do primeiro registro que tiver essa info
      const waba_id =
        rows.find(r => r?.settings?.waba_id)?.settings?.waba_id ||
        rows[0]?.settings?.waba_id ||
        null;

      const numbers = rows.map(r => {
        const raw = r?.settings?.raw || {};
        return {
          id: r.external_id,
          display_phone_number: raw.display_phone_number || r.display_name || null,
          verified_name: raw.verified_name || null,
          is_active: !!r.is_active,
        };
      });

      return reply.send({
        ok: true,
        connected: true,   // existe pelo menos uma conexão salva
        waba_id,
        numbers
      });
    } catch (err) {
      fastify.log.error({ err }, '[wa/status] failed');
      return reply.code(500).send({ ok: false, error: 'wa_status_failed' });
    }
  });
  
}

export default waEmbeddedRoutes;
