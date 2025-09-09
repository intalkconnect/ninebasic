// routes/waProfile.js
import { gget, gpost } from '../services/metaGraph.js';

async function waProfileRoutes(fastify) {
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
  fastify.get('/', async (req, reply) => {
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
  fastify.post('/', async (req, reply) => {
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
  fastify.delete('/photo', async (req, reply) => {
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
}

export default waProfileRoutes;
