// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  
  if (!HMAC) {
    fastify.log.error("[realtime] CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ausente");
    throw new Error("HMAC secret não configurado");
  }

  const getSub = (req) => {
    const u = req.user || {};
    // Garanta que sempre retorne um valor válido
    const sub = String(u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous");
    console.log("[realtime] getSub result:", sub); // DEBUG
    return sub;
  };

  // ---- CONNECT TOKEN ----
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

      const sub = getSub(req);
      const exp = Math.floor(Date.now()/1000) + (24 * 60 * 60);

      const token = jwt.sign({ sub, exp }, HMAC, { algorithm: "HS256" });

      console.log("[realtime] connect token generated for sub:", sub); // DEBUG
      return reply.send({ token });
    } catch (error) {
      console.error("[realtime] token error:", error);
      return reply.code(500).send({ error: "token_generation_failed" });
    }
  });

  // ---- SUBSCRIBE TOKEN ----
  fastify.post("/subscribe", async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

      const { client, channel } = req.body || {};
      if (!client || !channel) {
        return reply.code(400).send({ 
          error: "bad_request", 
          missing: { client: !client, channel: !channel } 
        });
      }

      // Restrição de canais
      const allowed =
        channel.startsWith(`conv:t:${tenant}:`) ||
        channel.startsWith("queue:");
      if (!allowed) return reply.code(403).send({ error: "forbidden_for_channel" });

      const sub = getSub(req);
      const exp = Math.floor(Date.now()/1000) + (24 * 60 * 60);

      // 🔥 CORREÇÃO PRINCIPAL: Inclua o campo 'user' no payload
      const payload = {
        user: sub,  // ← ESTE CAMPO É OBRIGATÓRIO
        channel,
        client,
        exp
      };

      console.log("[realtime] subscribe token payload:", payload); // DEBUG

      const token = jwt.sign(payload, HMAC, { algorithm: "HS256" });

      return reply.send({ 
        token,
        user: sub,
        channel,
        client
      });
    } catch (error) {
      console.error("[realtime] subscribe error:", error);
      return reply.code(500).send({ error: "subscribe_token_generation_failed" });
    }
  });
}
