// plugins/authCookieToBearer.js
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // já tem Authorization? respeita
    const already = req.headers.authorization || req.raw.headers['authorization'];
    if (already) return;

    // garante req.cookies (fallback manual)
    if (!req.cookies) {
      try { req.cookies = cookie.parse(req.headers.cookie || ''); } catch { req.cookies = {}; }
    }

    // 1) defaultAssert -> Bearer <jwt-assert>
    const jwtAssert = req.cookies?.defaultAssert;
    if (jwtAssert) {
      const v = `Bearer ${jwtAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
      return;
    }

    // 2) compat: se existir um cookie com padrão <uuid>.<64hex>, promove a Bearer
    const maybeBearer = req.cookies?.authToken;
    if (maybeBearer && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(maybeBearer)) {
      const v = `Bearer ${maybeBearer}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
