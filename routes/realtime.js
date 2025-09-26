// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  // ✅ use SEMPRE o mesmo segredo que o Centrifugo usa
  const SECRET = process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;
  if (!SECRET) fastify.log.warn("[realtime] CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ausente");

  // ---------- CONNECT TOKEN ----------
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    const tenant = req.headers["x-tenant"];
    if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
    if (!SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

    const now = Math.floor(Date.now() / 1000);
    const payloadUser =
      req.user?.id || req.user?.sub || req.user?.email || req.headers["x-user-id"] || "agent:anonymous";

    // ⚠️ Centrifugo valida só pelo próprio relógio → dê folga
    const token = jwt.sign(
      { sub: String(payloadUser), iat: now - 30, exp: now + 3600 }, // 1h
      SECRET,
      { algorithm: "HS256" }
    );
    return reply.send({ token, exp: now + 3600, sub: String(payloadUser) });
  });

  // ---------- SUBSCRIBE TOKEN ----------
  fastify.post("/subscribe", async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });
      if (!SECRET) return reply.code(500).send({ error: "cent_secret_not_configured" });

      const { client, channel } = req.body || {};
      if (!client || !channel) {
        return reply.code(400).send({ error: "bad_request", missing: { client: !client, channel: !channel } });
      }

      // restrição por tenant nos canais conv:t:<tenant>:*
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) ||
        channel.startsWith("queue:"); // se quiser, remova queue: daqui p/ deixar pública

      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      // o "user" do subscribe token DEVE ser o mesmo "sub" do connect token:
      const user =
        req.user?.id || req.user?.sub || req.user?.email || req.headers["x-user-id"] || "agent:anonymous";

      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign({ client, channel, sub: String(sub),  iat: now - 30, exp: now + 3600 }, SECRET, { algorithm: "HS256" });

      return reply.send({ token, exp: now + 3600 });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "subscribe_token_error" });
    }
  });
}
