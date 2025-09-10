// /app/plugins/authCookieToBearer.js
import cookie from 'cookie'; // fallback caso req.cookies não exista

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // Se já veio Authorization, não altera
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // Usa @fastify/cookie se tiver; senão faz parse do header Cookie
    const cookies = req.cookies ?? cookie.parse(req.headers.cookie || '');

    // 1) defaultAssert (JWT curto emitido pelo AUTH)
    if (cookies.defaultAssert) {
      const v = `Bearer ${cookies.defaultAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // Fastify 4
      return;
    }

    // 2) Compat: <uuid>.<64hex> vira Bearer também
    const t = cookies.authToken;
    if (t && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(t)) {
      const v = `Bearer ${t}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
