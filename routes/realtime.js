// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC = process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;
  if (!HMAC) fastify.log.warn("[realtime] CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ausente");

  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

    const secret =
      process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
      process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;

    if (!secret) return reply.code(500).send({ error: "cent_secret_not_configured" });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + 60 * 10; // ↑ 10 minutos para tolerar skew

    const u = req.user || {};
    const sub = String(
      u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
    );

    const token = jwt.sign({ sub, exp }, secret, { algorithm: "HS256" });
    return reply.send({ token, exp, sub });
  });

  fastify.post("/subscribe", async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

      const { client, channel } = req.body || {};
      if (!client || !channel) {
        return reply.code(400).send({ error: "bad_request", missing: { client: !client, channel: !channel } });
      }

      // (opcional) restrinja por tenant se o canal for conv:t:<tenant>:*
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) ||
        channel.startsWith(`queue:`); // ajuste se quiser queue privada por tenant

      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      // Pegue o mesmo "sub" que foi usado no token de conexão:
      const u = req.user || {};
      const sub = String(
        u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
      );

      // IMPORTANTÍSSIMO: inclua "user" no token de subscribe
      const exp = Math.floor(Date.now() / 1000) + 60 * 10; // ↑ 10 minutos
      const token = jwt.sign(
        { client, channel, user: sub, exp },
        HMAC,
        { algorithm: "HS256" }
      );

      return reply.send({ token, exp });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
