// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const CONNECT_SECRET =
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;

  const SUBSCRIBE_SECRET = process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;

  if (!CONNECT_SECRET) fastify.log.warn("[realtime] CONNECT_SECRET ausente");
  if (!SUBSCRIBE_SECRET) fastify.log.warn("[realtime] SUBSCRIBE_SECRET ausente");

  // ---- CONNECT TOKEN (público, mas exige X-Tenant) ----
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!CONNECT_SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

    const u = req.user || {};
    const sub =
      String(u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous");

    const now = Math.floor(Date.now() / 1000);
    const payload = { sub, iat: now - 30, exp: now + 3600 }; // 1h
    const token = jwt.sign(payload, CONNECT_SECRET, { algorithm: "HS256" });

    return reply.send({ token, ...payload });
  });

  // ---- SUBSCRIBE TOKEN (privado; usa mesma identidade "sub") ----
  fastify.post("/subscribe", async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
      if (!SUBSCRIBE_SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

      const { client, channel } = req.body || {};
      if (!client || !channel) {
        return reply.code(400).send({
          error: "bad_request",
          missing: { client: !client, channel: !channel },
        });
      }

      // limita canais por tenant (ajuste se quiser queue pública)
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) || channel.startsWith("queue:");
      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      // >>> AQUI: defina 'sub' ANTES de usar
      const u = req.user || {};
      const sub =
        String(u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous");

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        client,
        channel,
        sub,            // o Centrifugo confere este sub com o sub do connect token
        iat: now - 30,
        exp: now + 3600 // 1h
      };

      // (debug opcional)
      // req.log.info({ payload }, "[realtime] subscribe-payload");

      const token = jwt.sign(payload, SUBSCRIBE_SECRET, { algorithm: "HS256" });
      return reply.send({ token, exp: payload.exp });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
