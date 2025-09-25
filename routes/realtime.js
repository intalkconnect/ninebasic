// routes/realtime.js
import jwt from "jsonwebtoken";

export default async function realtimeRoutes(fastify) {
  const HMAC = process.env.CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY;
  if (!HMAC) fastify.log.warn("[realtime] CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY ausente");

  // tenta extrair user/tenant de várias fontes
  function getAuth(req) {
    // 1) middleware de auth (ideal)
    let userId = req.user?.id || req.user?.sub || "";
    let tenantId = req.user?.tenantId || "";

    // 2) Authorization: Bearer <jwt>
    if ((!userId || !tenantId) && req.headers.authorization?.startsWith("Bearer ")) {
      try {
        const token = req.headers.authorization.slice("Bearer ".length);
        const decoded = jwt.decode(token) || {};
        userId ||= decoded.sub || decoded.id || "";
        tenantId ||= decoded.tenantId || decoded?.info?.tenantId || "";
      } catch {}
    }

    // 3) Cookies (se usar sessão/JWT em cookie)
    if ((!userId || !tenantId) && req.cookies?.auth) {
      try {
        const decoded = jwt.decode(req.cookies.auth) || {};
        userId ||= decoded.sub || decoded.id || "";
        tenantId ||= decoded.tenantId || decoded?.info?.tenantId || "";
      } catch {}
    }

    // 4) Headers de dev (útil agora)
    userId ||= String(req.headers["x-user-id"] || "").trim();
    tenantId ||= String(req.headers["x-tenant-id"] || "").trim();

    // 5) (opcional) Query string para debug: ?userId=&tenantId=
    if (!userId) userId = String(req.query?.userId || "");
    if (!tenantId) tenantId = String(req.query?.tenantId || "");

    const name = req.user?.name || req.headers["x-user-name"] || "";
    return { userId, tenantId, name };
  }

  fastify.get("/token", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent secret not configured" });

      const { userId, tenantId, name } = getAuth(req);
      if (!userId || !tenantId) {
        return reply.code(401).send({ error: "unauthenticated", hint: "missing userId/tenantId" });
      }

      const exp = Math.floor(Date.now()/1000) + 60 * 60; // 1h
      const token = jwt.sign({ sub: userId, info: { tenantId, name }, exp }, HMAC, { algorithm: "HS256" });
      return reply.send({ token, exp, sub: userId });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "erro ao gerar token" });
    }
  });

  // mantém também a rota de subscribe se ainda não adicionou:
  fastify.post("/centrifugo/subscribe", async (req, reply) => {
    try {
      if (!HMAC) return reply.code(500).send({ error: "cent secret not configured" });
      const { userId, tenantId } = getAuth(req);
      if (!userId || !tenantId) return reply.code(401).send({ error: "unauthenticated" });

      const { client, channel } = req.body || {};
      if (!client || !channel) return reply.code(400).send({ error: "bad_request" });

      const allowed = /^conv:/.test(channel) && new RegExp(`^conv:t:${tenantId}:`).test(channel);
      if (!allowed) return reply.code(403).send({ error: "forbidden for this channel" });

      const exp = Math.floor(Date.now()/1000) + 120;
      const token = jwt.sign({ client, channel, exp }, HMAC, { algorithm: "HS256" });
      return reply.send({ token, exp });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: "erro ao gerar subscribe token" });
    }
  });
}
