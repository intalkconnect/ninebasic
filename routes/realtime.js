// routes/realtime.js
import jwt from "jsonwebtoken";

/**
 * Rotas de realtime (PÚBLICAS):
 * - GET /api/v1/realtime/token         -> gera token de conexão (HS256) para o Centrifugo
 * - POST /api/v1/realtime/subscribe    -> gera subscribe token (HS256) p/ canal conv:t:<tenant>:<userId>
 */
export default async function realtimeRoutes(fastify) {
  const HMAC =
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;

  if (!HMAC) fastify.log.warn("[realtime] CENTRIFUGO_*_HMAC_SECRET_KEY ausente");

  // extrai user/tenant de cabeçalhos/cookies/query sem depender do bearer
  function getAuth(req) {
    let userId = String(req.headers["x-user-id"] || "").trim();
    let tenant = String(req.headers["x-tenant"]   || "").trim();

    // fallback via cookie defaultAssert (se existir)
    if ((!userId || !tenant) && req.cookies?.defaultAssert) {
      try {
        const decoded = jwt.decode(req.cookies.defaultAssert) || {};
        userId ||= decoded.email || decoded.sub || decoded.id || "";
        tenant ||= decoded.tenant || decoded.tenantId || decoded?.info?.tenantId || "";
      } catch {}
    }

    // fallback via query (debug)
    if (!userId) userId = String(req.query?.userId || "");
    if (!tenant) tenant = String(req.query?.tenant  || req.query?.tenantId || "");

    return { userId, tenant };
  }

  // === GET /realtime/token (PÚBLICO) ===
  fastify.get("/token", async (req, reply) => {
    const { userId, tenant } = getAuth(req);

    // exigimos pelo menos X-Tenant (e idealmente X-User-Id)
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + 60 * 5; // 5 min

    // sub padrão: userId se veio, senão "agent:anonymous"
    const sub = userId || "agent:anonymous";

    const token = jwt.sign({ sub, exp }, HMAC, { algorithm: "HS256" });
    return reply.send({ token, exp, sub });
  });

  // === POST /realtime/subscribe (PÚBLICO, mas verifica canal/tenant) ===
  fastify.post("/subscribe", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent_secret_not_configured" });

      const { userId, tenant } = getAuth(req);
      const { client, channel } = req.body || {};

      if (!client || !channel) return reply.code(400).send({ error: "bad_request" });
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
      if (!userId) return reply.code(401).send({ error: "missing_user" });

      // apenas canais conv:t:<tenant>:<algumId> são permitidos
      const ok = /^conv:/.test(channel) && channel.startsWith(`conv:t:${tenant}:`);
      if (!ok) return reply.code(403).send({ error: "forbidden_for_channel" });

      const exp = Math.floor(Date.now() / 1000) + 120; // 2 min
      const token = jwt.sign({ client, channel, exp }, HMAC, { algorithm: "HS256" });
      return reply.send({ token, exp });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
