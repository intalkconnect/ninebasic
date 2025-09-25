// routes/realtime.js
import jwt from "jsonwebtoken";

/**
 * Gera o token de conexão do Centrifugo (HS256).
 * Retorna: { token, exp, sub }
 */
export default async function realtimeRoutes(fastify) {
  const CENT_SECRET = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  if (!CENT_SECRET) {
    fastify.log.warn("[realtime] CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ausente no env");
  }

  // GET /realtime/token
  fastify.get("/token", async (req, reply) => {
    try {
      // Identifique o usuário logado do seu sistema.
      // Ajuste conforme seu middleware de auth:
      // - se usa fastify-jwt: const userId = String(req.user?.id || req.user?.sub || "agent:anonymous");
      // - se usa header: const userId = req.headers["x-user-id"] || ...
      const userId =
        String(req.user?.id || req.user?.sub || req.headers["x-user-id"] || "agent:anonymous");

      if (!CENT_SECRET) {
        return reply.code(500).send({ error: "cent secret not configured" });
      }

      const now = Math.floor(Date.now() / 1000);
      const exp = now + 60 * 5; // 5 minutos (ajuste se quiser)

      // Payload mínimo exigido pelo Centrifugo: "sub"
      const token = jwt.sign({ sub: userId, exp }, CENT_SECRET, { algorithm: "HS256" });

      return reply.send({ token, exp, sub: userId });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "erro ao gerar token" });
    }
  });
}
