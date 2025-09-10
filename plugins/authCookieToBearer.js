// /app/plugins/authCookieToBearer.js
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // se já veio Authorization, respeita
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // parse simples
    if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || '');

    // 1) Preferir defaultAssert -> Authorization: Default <jwt>
    const defaultAssert = req.cookies?.defaultAssert;
    if (defaultAssert) {
      const v = `Default ${defaultAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // Fastify 4
      return;
    }

    // 2) Compatibilidade: authToken no formato <uuid>.<64hex> -> Bearer
    const authToken = req.cookies?.authToken;
    if (authToken && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(authToken)) {
      const v = `Bearer ${authToken}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
