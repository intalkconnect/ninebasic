// routes/waEmbedded.js
import { gget, gpost } from '../services/metaGraph.js';

async function waEmbeddedRoutes(fastify, options) {
  // Prefixo esperado: /api/v1/wa
  fastify.post('/es/finalize', async (req, reply) => {
    // subdomain: preferir do plugin; fallback do body
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||                 // caso seu plugin use outro nome
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
      // 0) Resolver tenant_id pelo subdomain
      const tRes = await req.db.query(
        `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenantRow = tRes.rows[0];
      if (!tenantRow) return reply.code(404).send({ error: 'tenant_not_found', subdomain });
      const tenantId = tenantRow.id;

      // 1) code -> user access_token
      const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
      if (META_REDIRECT_URI) qs.redirect_uri = META_REDIRECT_URI; // deve bater com o usado no front
      const tok = await gget('/oauth/access_token', { qs });
      const userToken = tok.access_token;

      // 2) Descobrir WABA_ID
      let wabaId = null;

      // 2a) tentar via /debug_token
      try {
        const dbg = await gget('/debug_token', {
          qs: {
            input_token: userToken,
            access_token: `${META_APP_ID}|${META_APP_SECRET}`
          }
        });
        const gs = dbg?.data?.granular_scopes || [];
        const mgmt = gs.find(
          s => s?.scope === 'whatsapp_business_management' && Array.isArray(s?.target_ids)
        );
        wabaId = mgmt?.target_ids?.[0] || null;
      } catch (e) {
        fastify.log.warn({ err: e }, '[wa/es/finalize] debug_token fallback');
      }

      // 2b) fallback: pegar WABA(s) compartilhada(s) com SEU business
      if (!wabaId) {
        const shared = await gget(`/${YOUR_BUSINESS_ID}/client_whatsapp_business_accounts`, {
          token: SYSTEM_USER_TOKEN
        });
        wabaId = shared?.data?.[0]?.id || null;
      }
      if (!wabaId) return reply.code(400).send({ error: 'no_waba_found' });

      // 3) Assinar webhooks do SEU app nessa WABA
      await gpost(`/${wabaId}/subscribed_apps`, { token: userToken });

      // 4) Adicionar seu System User (MANAGE) para operar com token fixo
      await gpost(`/${wabaId}/assigned_users`, {
        token: SYSTEM_USER_ADMIN_TOKEN || SYSTEM_USER_TOKEN,
        form: { user: SYSTEM_USER_ID, tasks: "['MANAGE']" }
      });

      // 5) Listar números (PHONE_NUMBER_IDs)
      const pn = await gget(`/${wabaId}/phone_numbers`, { token: SYSTEM_USER_TOKEN });
      const numbers = pn?.data || [];

      // 6) Persistir cada número como uma conexão do canal 'whatsapp'
      // external_id = phone_number_id, account_id = waba_id
      const qUpsert = `
        INSERT INTO public.tenant_channel_connections
          (tenant_id, subdomain, channel, provider, account_id, external_id, display_name, auth_mode, settings, is_active)
        VALUES
          ($1,        $2,        'whatsapp','meta',  $3,         $4,          $5,           'system_user', $6,       true)
        ON CONFLICT (tenant_id, channel, external_id)
        DO UPDATE SET
          account_id = EXCLUDED.account_id,
          display_name = EXCLUDED.display_name,
          settings = public.tenant_channel_connections.settings || EXCLUDED.settings,
          is_active = true,
          updated_at = now()
      `;

      for (const num of numbers) {
        const phoneId = num?.id;                 // phone_number_id
        const disp    = num?.display_phone_number || num?.verified_name || null;
        const settings = {
          waba_id: wabaId,
          raw: num                                // útil p/ debug/consulta
        };
        await req.db.query(qUpsert, [
          tenantId,
          subdomain,
          wabaId,
          phoneId,
          disp,
          JSON.stringify(settings)
        ]);
      }

      // (opcional) compat: manter campo antigo no tenants (se quiser)
      // if (numbers[0]?.id) {
      //   await req.db.query(
      //     `UPDATE public.tenants SET whatsapp_external_id=$1 WHERE id=$2`,
      //     [numbers[0].id, tenantId]
      //   );
      // }

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
}

export default waEmbeddedRoutes;
