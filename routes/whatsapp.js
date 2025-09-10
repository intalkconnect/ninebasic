// routes/waProfile.js
import { gget, gpost } from '../services/metaGraph.js';

async function whatsappRoutes(fastify) {
  const TOKEN =
    process.env.WHATSAPP_TOKEN ||
    process.env.SYSTEM_USER_TOKEN ||
    process.env.SYSTEM_USER_ADMIN_TOKEN;

  const requireToken = () => {
    if (!TOKEN) throw new Error('meta_token_missing');
    return TOKEN;
  };

  // ---------- helpers ----------
  function getSubdomain(req) {
    return (
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers['x-tenant-subdomain'] ||
      req?.query?.subdomain ||
      req?.body?.subdomain ||
      null
    );
  }

  async function resolveTenant(req) {
    const sub = getSubdomain(req);
    if (!sub) throw new Error('missing_subdomain');
    if (!req.db) throw new Error('db_not_available');

    const tRes = await req.db.query(
      `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
      [sub]
    );
    const t = tRes.rows[0];
    if (!t) throw new Error('tenant_not_found');
    return t;
  }

  // Pega o phone_number_id do canal WhatsApp/Meta do tenant.
  // Preferência: is_active = true; fallback: o mais recente.
  async function resolveActivePhone(req) {
    const tenant = await resolveTenant(req);
    const q = `
      SELECT external_id AS phone_id, settings, is_active
        FROM public.tenant_channel_connections
       WHERE tenant_id = $1
         AND channel   = 'whatsapp'
         AND provider  = 'meta'
       ORDER BY is_active DESC, updated_at DESC
       LIMIT 1
    `;
    const { rows } = await req.db.query(q, [tenant.id]);
    const row = rows[0];
    if (!row?.phone_id) throw new Error('no_whatsapp_connection');

    const waba_id =
      row?.settings?.waba_id ||
      (row?.settings && typeof row.settings === 'string'
        ? (() => {
            try { return JSON.parse(row.settings)?.waba_id; } catch { return null; }
          })()
        : null);

    return { tenant, phone_id: row.phone_id, waba_id };
  }

  const sanitizeWebsites = (raw) => {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
    return arr.map(String).map(s => s.trim()).filter(Boolean).slice(0, 2);
  };
  const sanitizeVertical = (v) => (v ? String(v).toUpperCase() : undefined);

  // ---------- ENDPOINTS ----------

  // GET /wa/profile -> phone + business profile
  fastify.get('/profile', async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolveActivePhone(req);

      const phoneFields = [
        'id',
        'display_phone_number',
        'verified_name',
        'quality_rating',
        'is_official_business_account',
        'account_mode',
        'code_verification_status'
      ].join(',');

      const profileFields = [
        'about',
        'address',
        'description',
        'email',
        'vertical',
        'websites',
        'profile_picture_url'
      ].join(',');

      const phone = await gget(`/${phone_id}`, {
        token: TOKEN,
        qs: { fields: phoneFields }
      });

      const prof = await gget(`/${phone_id}/whatsapp_business_profile`, {
        token: TOKEN,
        qs: { fields: profileFields }
      });

      const profile = prof?.data ? (prof.data[0] || {}) : prof || {};
      return reply.send({ ok: true, phone, profile });
    } catch (err) {
      fastify.log.error({ err }, '[GET /wa/profile]');
      const code =
        err?.message === 'meta_token_missing' ? 500 :
        err?.message === 'missing_subdomain' ? 400 :
        err?.message === 'db_not_available' ? 500 :
        err?.message === 'tenant_not_found' ? 404 :
        err?.message === 'no_whatsapp_connection' ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || 'unexpected_error' });
    }
  });

  // POST /wa/profile -> update about/address/description/email/vertical/websites
  fastify.post('/profile', async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolveActivePhone(req);
      const {
        about,
        address,
        description,
        email,
        vertical,
        websites
      } = req.body || {};

      const payload = {};
      if (about !== undefined)       payload.about = String(about).slice(0, 139);
      if (address !== undefined)     payload.address = String(address).slice(0, 256);
      if (description !== undefined) payload.description = String(description).slice(0, 512);
      if (email !== undefined)       payload.email = String(email).slice(0, 128);
      if (vertical !== undefined)    payload.vertical = sanitizeVertical(vertical);
      if (websites !== undefined)    payload.websites = sanitizeWebsites(websites);

      if (!Object.keys(payload).length) {
        return reply.code(400).send({ ok: false, error: 'no_allowed_fields' });
      }

      // gpost envia por padrão como form; Graph aceita form para esses campos
      const res = await gpost(`/${phone_id}/whatsapp_business_profile`, {
        token: TOKEN,
        form: payload
      });

      return reply.send({ ok: true, provider: res });
    } catch (err) {
      fastify.log.error({ err }, '[POST /wa/profile]');
      const code =
        err?.message === 'meta_token_missing' ? 500 :
        err?.message === 'missing_subdomain' ? 400 :
        err?.message === 'db_not_available' ? 500 :
        err?.message === 'tenant_not_found' ? 404 :
        err?.message === 'no_whatsapp_connection' ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || 'unexpected_error' });
    }
  });

  // POST /wa/profile/photo-from-url -> upload + aplicar foto
  // body: { file_url: string, type?: 'image/jpeg'|'image/png' }
  fastify.post('/photo-from-url', async (req, reply) => {
    try {
      requireToken();
      const { phone_id, waba_id } = await resolveActivePhone(req);
      const { file_url, type = 'image/jpeg' } = req.body || {};
      if (!file_url) return reply.code(400).send({ ok: false, error: 'missing_file_url' });

      // 1) sobe mídia na WABA
      const up = await gpost(`/${waba_id}/media`, {
        token: TOKEN,
        form: {
          messaging_product: 'whatsapp',
          type,
          link: file_url
        }
      });
      const handle = up?.id;
      if (!handle) return reply.code(502).send({ ok: false, error: 'upload_no_handle' });

      // 2) aplica como foto de perfil
      const res = await gpost(`/${phone_id}/whatsapp_business_profile`, {
        token: TOKEN,
        form: { profile_picture_handle: handle }
      });

      return reply.send({ ok: true, media_id: handle, provider: res });
    } catch (err) {
      fastify.log.error({ err }, '[POST /wa/profile/photo-from-url]');
      const code =
        err?.message === 'meta_token_missing' ? 500 :
        err?.message === 'missing_subdomain' ? 400 :
        err?.message === 'db_not_available' ? 500 :
        err?.message === 'tenant_not_found' ? 404 :
        err?.message === 'no_whatsapp_connection' ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || 'unexpected_error' });
    }
  });

  // DELETE /wa/profile/photo -> remove foto
  fastify.delete('/profile/photo', async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolveActivePhone(req);

      const res = await gpost(`/${phone_id}/whatsapp_business_profile`, {
        token: TOKEN,
        form: { profile_picture_handle: '' } // limpa
      });

      return reply.send({ ok: true, provider: res });
    } catch (err) {
      fastify.log.error({ err }, '[DELETE /wa/profile/photo]');
      const code =
        err?.message === 'meta_token_missing' ? 500 :
        err?.message === 'missing_subdomain' ? 400 :
        err?.message === 'db_not_available' ? 500 :
        err?.message === 'tenant_not_found' ? 404 :
        err?.message === 'no_whatsapp_connection' ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || 'unexpected_error' });
    }
  });

  // GET /wa/number -> metadados do número (UI)
  fastify.get('/number', async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolveActivePhone(req);

      const fields = [
        'id',
        'display_phone_number',
        'verified_name',
        'quality_rating',
        'is_official_business_account',
        'account_mode'
      ].join(',');

      const phone = await gget(`/${phone_id}`, { token: TOKEN, qs: { fields } });
      return reply.send({ ok: true, phone });
    } catch (err) {
      fastify.log.error({ err }, '[GET /wa/number]');
      const code =
        err?.message === 'meta_token_missing' ? 500 :
        err?.message === 'missing_subdomain' ? 400 :
        err?.message === 'db_not_available' ? 500 :
        err?.message === 'tenant_not_found' ? 404 :
        err?.message === 'no_whatsapp_connection' ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || 'unexpected_error' });
    }
  });

    // routes/waEmbedded.js (trecho)
fastify.post('/embedded/es/pick-number', async (req, reply) => {
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
  fastify.post('/embedded/es/finalize', async (req, reply) => {
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

export default whatsappRoutes;
