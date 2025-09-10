// /app/plugins/authCookieToBearer.js
import cookie from 'cookie'; // fallback, caso req.cookies não exista

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // Já tem Authorization? Não mexe.
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // Se @fastify/cookie populou, ótimo. Senão, parse manual do header Cookie.
    const cookies = req.cookies ?? cookie.parse(req.headers.cookie || '');

    // 1) Preferir defaultAssert (JWT curto httpOnly emitido pelo AUTH)
    if (cookies.defaultAssert) {
      const v = `Bearer ${cookies.defaultAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // Fastify 4
      return;
    }

    // 2) Compat: se tiver <uuid>.<64hex>, também vira Bearer
    const t = cookies.authToken;
    if (t && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(t)) {
      const v = `Bearer ${t}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
