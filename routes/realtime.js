// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  
  if (!HMAC) {
    fastify.log.error("[realtime] CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ausente");
    throw new Error("HMAC secret não configurado");
  }

  console.log("[realtime] HMAC secret configured, length:", HMAC.length);

  const getSub = (req) => {
    const u = req.user || {};
    const headers = req.headers || {};
    
    console.log("[realtime] getSub - req.user:", u);
    console.log("[realtime] getSub - headers:", {
      'x-user-id': headers['x-user-id'],
      'x-user-email': headers['x-user-email'],
      authorization: headers['authorization'] ? 'present' : 'missing'
    });

    const sub = String(
      u.id || 
      u.sub || 
      u.email || 
      headers["x-user-id"] || 
      headers["x-user-email"] ||
      "agent:anonymous"
    );
    
    console.log("[realtime] getSub result:", sub);
    return sub;
  };

  // ---- CONNECT TOKEN ----
  fastify.get("/token", { config: { public: true } }, async (req, reply) => {
    try {
      console.log("[realtime] GET /token called, headers:", req.headers);
      
      const tenant = req.headers["x-tenant"];
      if (!tenant) return reply.code(400).send({ error: "missing_tenant" });

      const sub = getSub(req);
      const exp = Math.floor(Date.now()/1000) + (24 * 60 * 60);

      const tokenPayload = { sub, exp };
      console.log("[realtime] connect token payload:", tokenPayload);

      const token = jwt.sign(tokenPayload, HMAC, { algorithm: "HS256" });

      // Decodifique para verificar
      const decoded = jwt.verify(token, HMAC);
      console.log("[realtime] connect token decoded:", decoded);

      return reply.send({ 
        token,
        decoded: decoded // ← Incluir para debug
      });
    } catch (error) {
      console.error("[realtime] token error:", error);
      return reply.code(500).send({ error: "token_generation_failed", details: error.message });
    }
  });

  // ---- SUBSCRIBE TOKEN ----
  fastify.post("/subscribe", async (req, reply) => {
    try {
      console.log("[realtime] POST /subscribe called, headers:", req.headers);
      console.log("[realtime] POST /subscribe body:", req.body);

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

      // Payload do token de subscribe
      const payload = { sub, channel, client, exp };

      console.log("[realtime] subscribe token payload:", payload);

      const token = jwt.sign(payload, HMAC, { algorithm: "HS256" });

      // Verifique o token gerado
      const decoded = jwt.verify(token, HMAC);
      console.log("[realtime] subscribe token decoded:", decoded);

      return reply.send({ 
        token,
        sub,
        channel,
        client,
        decoded: decoded // ← Para debug
      });
    } catch (error) {
      console.error("[realtime] subscribe error:", error);
      return reply.code(500).send({ error: "subscribe_token_generation_failed", details: error.message });
    }
  });

  // Endpoint para debug do token
  fastify.post("/debug-verify", async (req, reply) => {
    try {
      const { token } = req.body;
      if (!token) return reply.code(400).send({ error: "token_required" });

      const decoded = jwt.verify(token, HMAC);
      return reply.send({ 
        decoded,
        valid: true,
        currentTime: Math.floor(Date.now()/1000)
      });
    } catch (error) {
      return reply.send({ 
        valid: false, 
        error: error.message,
        currentTime: Math.floor(Date.now()/1000)
      });
    }
  });
}
