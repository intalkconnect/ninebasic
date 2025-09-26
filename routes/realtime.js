// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC =
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;

  if (!HMAC) fastify.log.warn("[realtime] HMAC secret ausente");
  const EXP_SECONDS = 24 * 60 * 60; // 24h

  const getSub = (req) => {
    const u = req.user || {};
    return String(
      u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
    );
  };

  // ---- CONNECT TOKEN (usa `sub`) ----
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!HMAC)   return reply.code(500).send({ error: "cent_secret_not_configured" });

    const sub = getSub(req);
    const now = Math.floor(Date.now()/1000);
    const exp = now + EXP_SECONDS;

    const token = jwt.sign({ sub, exp }, HMAC, { algorithm: "HS256", noTimestamp: true });
    return reply.send({ token, sub, now, exp, ttl_sec: EXP_SECONDS, note: "connect-token" });
  });

  // ---- SUBSCRIBE TOKEN (usa `user`) ----
  fastify.post("/subscribe", async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!HMAC)   return reply.code(500).send({ error: "cent_secret_not_configured" });

    const { client, channel } = req.body || {};
    if (!client || !channel) {
      return reply.code(400).send({ error: "bad_request", missing: { client: !client, channel: !channel } });
    }

    // restrição simples por tenant
    const allowed =
      channel.startsWith(`conv:t:${tenant}:`) ||
      channel.startsWith("queue:");
    if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

    const sub = getSub(req);        // usuário atual
    const now = Math.floor(Date.now()/1000);
    const exp = now + EXP_SECONDS;

    // ⚠️ Centrifugo espera `user` no subscribe token (não `sub`).
    const token = jwt.sign(
      { user: sub, client, channel, exp },
      HMAC,
      { algorithm: "HS256", noTimestamp: true }
    );

    return reply.send({ token, sub, client, channel, now, exp, ttl_sec: EXP_SECONDS, note: "subscribe-token" });
  });
}
