// routes/realtime.js
import jwt from "jsonwebtoken";

/**
 * Rotas de realtime (Centrifugo):
 * - GET  /realtime/token        -> token de conexão
 * - POST /centrifugo/subscribe  -> token de subscribe (canais protegidos)
 */
export default async function realtimeRoutes(fastify) {
  const HMAC = process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY; // <— padronize este nome!
  if (!HMAC) {
    fastify.log.warn("[realtime] CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ausente no env");
  }

  // Util: extrai user/tenant do seu auth (ajuste conforme seu sistema)
  function getAuth(req) {
    // Exemplos de onde pegar:
    const userId =
      String(req.user?.id || req.user?.sub || req.headers["x-user-id"] || "").trim();
    const tenantId =
      String(req.user?.tenantId || req.headers["x-tenant-id"] || "").trim();
    const name = (req.user?.name || req.headers["x-user-name"] || "").trim();
    return { userId, tenantId, name };
  }

  // GET /realtime/token
  fastify.get("/token", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent secret not configured" });

      const { userId, tenantId, name } = getAuth(req);
      if (!userId || !tenantId) {
        return reply.code(401).send({ error: "unauthenticated", hint: "missing userId/tenantId" });
      }

      const now = Math.floor(Date.now() / 1000);
      const exp = now + 60 * 60; // 1h

      const token = jwt.sign(
        {
          sub: userId,
          info: { tenantId, name },
          exp
        },
        HMAC,
        { algorithm: "HS256" }
      );

      return reply.send({ token, exp, sub: userId });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "erro ao gerar token" });
    }
  });

  // POST /centrifugo/subscribe (para canais PROTEGIDOS, ex.: conv:*)
  fastify.post("/centrifugo/subscribe", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent secret not configured" });

      const { userId, tenantId } = getAuth(req);
      if (!userId || !tenantId) {
        return reply.code(401).send({ error: "unauthenticated" });
      }

      const { client, channel } = req.body || {};
      if (!client || !channel) {
        return reply.code(400).send({ error: "bad_request", hint: "client/channel required" });
      }

      // 🔐 Só emitimos subscribe token para canais do TENANT do usuário.
      // Ex.: conv:t:{tenantId}:{waNumber}
      const allowed =
        /^conv:/.test(channel) &&
        new RegExp(`^conv:t:${tenantId}:`).test(channel);

      if (!allowed) {
        return reply.code(403).send({ error: "forbidden for this channel" });
      }

      // Token curtíssimo: 2 minutos é o suficiente
      const exp = Math.floor(Date.now() / 1000) + 120;

      const token = jwt.sign(
        { client, channel, exp },
        HMAC,
        { algorithm: "HS256" }
      );

      return reply.send({ token, exp });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "erro ao gerar subscribe token" });
    }
  });
}
