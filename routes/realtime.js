// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const CONNECT_SECRET =
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;

  const SUBSCRIBE_SECRET =
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;

  if (!CONNECT_SECRET) fastify.log.warn("[realtime] CONNECT_SECRET ausente");
  if (!SUBSCRIBE_SECRET) fastify.log.warn("[realtime] SUBSCRIBE_SECRET ausente");

  const EXP_SECONDS = 24 * 60 * 60; // 24h de validade

  function getSub(req) {
    const u = req.user || {};
    return String(
      u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
    );
  }

  // -------- CONNECT TOKEN --------
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!CONNECT_SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

    const sub = getSub(req);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + EXP_SECONDS;

    // sem iat/nbf: evita rejeição por skew de relógio
    const token = jwt.sign({ sub, exp }, CONNECT_SECRET, { algorithm: "HS256" });

    return reply.send({ token, sub, now, exp, ttl_sec: EXP_SECONDS, note: "connect-token" });
  });

  // -------- SUBSCRIBE TOKEN --------
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

      // restrição simples por tenant; ajuste conforme regra
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) ||
        channel.startsWith("queue:");
      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      const sub = getSub(req);
      const now = Math.floor(Date.now() / 1000);
      const exp = now + EXP_SECONDS;

      // Centrifugo compara 'sub' do subscribe com o do connect
      const token = jwt.sign({ sub, client, channel, exp }, SUBSCRIBE_SECRET, { algorithm: "HS256" });

      return reply.send({ token, sub, client, channel, now, exp, ttl_sec: EXP_SECONDS, note: "subscribe-token" });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
