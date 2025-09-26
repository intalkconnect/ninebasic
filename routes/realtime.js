// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC =
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ||
    "";

  if (!HMAC) fastify.log.warn("[realtime] HMAC do Centrifugo ausente");

  // Extrai user/tenant de várias fontes (padronizado p/ X-Tenant e claim 'tenant')
  function getAuth(req) {
    let userId  = req.user?.id || req.user?.sub || "";
    let tenant  = (req.headers["x-tenant"] || "").toString().trim();

    // Authorization: Bearer <jwt> (se houver)
    if ((!userId || !tenant) && req.headers.authorization?.startsWith("Bearer ")) {
      try {
        const token   = req.headers.authorization.slice("Bearer ".length);
        const decoded = jwt.decode(token) || {};
        userId ||= decoded.sub || decoded.id || decoded.email || "";
        tenant ||= decoded.tenant || ""; // << importante: claim 'tenant'
      } catch {}
    }

    // Cookies (opcional)
    if ((!userId || !tenant) && req.cookies?.auth) {
      try {
        const decoded = jwt.decode(req.cookies.auth) || {};
        userId ||= decoded.sub || decoded.id || decoded.email || "";
        tenant ||= decoded.tenant || "";
      } catch {}
    }

    // Headers auxiliares
    userId ||= String(req.headers["x-user-id"] || "").trim();

    // Query de debug (opcional)
    if (!userId) userId = String(req.query?.userId || "");
    if (!tenant) tenant = String(req.query?.tenant || "");

    return { userId, tenant };
  }

  // --- PUBLIC: token de conexão do Centrifugo (sem Bearer) ---
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = String(req.headers["x-tenant"] || "").trim();
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!HMAC)   return reply.code(500).send({ error: "cent_secret_not_configured" });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + 60 * 5;

    // sub do usuário (se tiver guard), senão cai no header auxiliar
    const u   = req.user || {};
    const sub = String(u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous");

    const token = jwt.sign({ sub, exp }, HMAC, { algorithm: "HS256" });
    return reply.send({ token, exp, sub });
  });

  // --- PROTECTED (ou público, como preferir): subscribe token por canal ---
  // Se quiser protegido por Bearer, NÃO ponha config.public aqui.
  fastify.post("/subscribe", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent_secret_not_configured" });

      const { userId, tenant } = getAuth(req);
      if (!userId || !tenant) return reply.code(401).send({ error: "unauthenticated" });

      const { client, channel } = req.body || {};
      if (!client || !channel) return reply.code(400).send({ error: "bad_request" });

      // somente canais do tenant atual (ex.: conv:t:hmg:12345)
      const allowed =
        channel.startsWith("conv:") &&
        new RegExp(`^conv:t:${tenant}:`).test(channel);

      if (!allowed) return reply.code(403).send({ error: "forbidden_for_this_channel" });

      const exp   = Math.floor(Date.now() / 1000) + 120;
      const token = jwt.sign({ client, channel, exp }, HMAC, { algorithm: "HS256" });
      return reply.send({ token, exp });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
