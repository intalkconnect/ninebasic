// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  // Use a variável de ambiente correta
  const HMAC = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  
  if (!HMAC) {
    fastify.log.error("[realtime] CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ausente");
    throw new Error("HMAC secret não configurado");
  }
  
  const EXP_SECONDS = 24 * 60 * 60; // 24h

  const getSub = (req) => {
    const u = req.user || {};
    return String(
      u.id || u.sub || u.email || req.headers["x-user-id"] || "agent:anonymous"
    );
  };

  // ---- CONNECT TOKEN (usa `sub` conforme documentação do Centrifugo) ----
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    try {
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

      const sub = getSub(req);
      const now = Math.floor(Date.now()/1000);
      const exp = now + EXP_SECONDS;

      // Token de conexão deve conter `sub`
      const token = jwt.sign({ 
        sub, 
        exp 
      }, HMAC, { 
        algorithm: "HS256", 
        noTimestamp: true 
      });

      return reply.send({ 
        token, 
        sub, 
        now, 
        exp, 
        ttl_sec: EXP_SECONDS 
      });
    } catch (error) {
      fastify.log.error("[realtime] token error:", error);
      return reply.code(500).send({ error: "token_generation_failed" });
    }
  });

  // ---- SUBSCRIBE TOKEN (usa `user` conforme documentação) ----
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
      const now = Math.floor(Date.now()/1000);
      const exp = now + EXP_SECONDS;

      // Token de subscribe deve conter `user`
      const token = jwt.sign(
        { 
          user: sub,  // ← IMPORTANTE: usar 'user' para subscribe tokens
          client, 
          channel, 
          exp 
        },
        HMAC,
        { 
          algorithm: "HS256", 
          noTimestamp: true 
        }
      );

      return reply.send({ 
        token, 
        user: sub,  // ← Retornar como 'user' para consistência
        client, 
        channel, 
        now, 
        exp, 
        ttl_sec: EXP_SECONDS 
      });
    } catch (error) {
      fastify.log.error("[realtime] subscribe error:", error);
      return reply.code(500).send({ error: "subscribe_token_generation_failed" });
    }
  });
}
