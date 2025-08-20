// routes/waEmbedded.js  (Fastify plugin)
'use strict';
const { gget, gpost } = require('../services/metaGraph');

module.exports = async function (fastify) {
  fastify.post('/wa/es/finalize', async (req, reply) => {
    const { code, tenant } = req.body || {};
    if (!code || !tenant) return reply.code(400).send({ error: 'missing_code_or_tenant' });

    // 1) code -> user access_token (fluxo Embedded Signup usa response_type=code)
    // Doc: Embedded Signup + Implementation (usa JS SDK + OAuth exchange) :contentReference[oaicite:1]{index=1}
    const qs = {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      code
    };
    if (process.env.META_REDIRECT_URI) qs.redirect_uri = process.env.META_REDIRECT_URI; // deve ser idêntico ao usado no front durante o login. :contentReference[oaicite:2]{index=2}
    const tok = await gget('/oauth/access_token', { qs });
    const userToken = tok.access_token;

    // 2) (opção A) detectar WABA via /debug_token granular_scopes; (opção B) pegar WABA compartilhada com seu Business
    // Ref. geral de WABA e Webhooks: subscribed_apps; webhooks para WABA. :contentReference[oaicite:3]{index=3}
    let wabaId = null;

    try {
      const dbg = await gget('/debug_token', {
        qs: { input_token: userToken, access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` }
      });
      const gs = dbg?.data?.granular_scopes || [];
      const mgmt = gs.find(s => s?.scope === 'whatsapp_business_management' && Array.isArray(s?.target_ids));
      wabaId = mgmt?.target_ids?.[0] || null;
    } catch {}

    if (!wabaId) {
      // pega WABAs do cliente compartilhadas com seu Business (após Embedded ou share-with-partner)
      const shared = await gget(`/${process.env.YOUR_BUSINESS_ID}/client_whatsapp_business_accounts`, {
        token: process.env.SYSTEM_USER_TOKEN
      });
      wabaId = shared?.data?.[0]?.id || null; // se houver várias, você pode aplicar uma heurística própria aqui
    }
    if (!wabaId) return reply.code(400).send({ error: 'no_waba_found' });

    // 3) Assinar webhooks do SEU app nessa WABA (liga a WABA ao teu callback)
    // POST /{WABA_ID}/subscribed_apps (pode usar o token do cliente ou do SU se já houver permissão) :contentReference[oaicite:4]{index=4}
    await gpost(`/${wabaId}/subscribed_apps`, { token: userToken });

    // 4) Adicionar seu System User com MANAGE à WABA (para usar token fixo do negócio) :contentReference[oaicite:5]{index=5}
    await gpost(`/${wabaId}/assigned_users`, {
      token: process.env.SYSTEM_USER_ADMIN_TOKEN || process.env.SYSTEM_USER_TOKEN,
      form: { user: process.env.SYSTEM_USER_ID, "tasks": "['MANAGE']" }
    });

    // 5) Listar números da WABA com o token do System User (operacional fixo) :contentReference[oaicite:6]{index=6}
    const pn = await gget(`/${wabaId}/phone_numbers`, { token: process.env.SYSTEM_USER_TOKEN });

    // TODO: aqui você pode persistir waba + números vinculados ao tenant
    // ex.: await fastify.someRepo.upsertWaba(tenant, wabaId, pn.data)

    return reply.send({ waba_id: wabaId, numbers: pn?.data || [], tenant });
  });
};
