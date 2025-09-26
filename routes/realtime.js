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

  // Helpers
  function getSub(req) {
    const u = req.user || {};
    return String(
      u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
    );
  }

  // Janela grande pra descartar skew entre relógios
  const EXP_SECONDS = 24 * 60 * 60; // 24h
  const LEEWAY = 60; // 60s

  // -------- CONNECT TOKEN (público mas exige X-Tenant) --------
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!CONNECT_SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

    const sub = getSub(req);
    const now = Math.floor(Date.now() / 1000);

    const payload = {
      sub,
      iat: now - LEEWAY, // tolerância
      nbf: now - LEEWAY,
      exp: now + EXP_SECONDS,
    };

    const token = jwt.sign(payload, CONNECT_SECRET, { algorithm: "HS256" });

    // DEBUG útil pra comparar relógios
    return reply.send({
      token,
      sub,
      now,
      exp: payload.exp,
      leeway: LEEWAY,
      ttl_sec: EXP_SECONDS,
      note: "connect-token",
    });
  });

  // -------- SUBSCRIBE TOKEN (privado) --------
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

      // restrição de canais (ajuste conforme regra)
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) ||
        channel.startsWith("queue:");
      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      const sub = getSub(req);
      const now = Math.floor(Date.now() / 1000);

      // IMPORTANTE: Centrifugo confere que o 'sub' do subscribe token == 'sub' do connect token
      const payload = {
        sub,
        client,
        channel,
        iat: now - LEEWAY,
        nbf: now - LEEWAY,
        exp: now + EXP_SECONDS,
      };

      const token = jwt.sign(payload, SUBSCRIBE_SECRET, { algorithm: "HS256" });

      // DEBUG útil
      return reply.send({
        token,
        sub,
        client,
        channel,
        now,
        exp: payload.exp,
        leeway: LEEWAY,
        ttl_sec: EXP_SECONDS,
        note: "subscribe-token",
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
