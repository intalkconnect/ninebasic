// plugins/authCookieToBearer.js
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // já tem Authorization? respeita
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // parse cookies sem depender de @fastify/cookie
    if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || '');

    // 1) Preferência: usar defaultAssert -> Authorization: Default <jwt>
    const defaultAssert = req.cookies?.defaultAssert;
    if (defaultAssert) {
      const v = `Default ${defaultAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // Fastify 4
      return;
    }

    // 2) Compatibilidade: se houver um bearer <uuid>.<hex> em cookie authToken
    const authToken = req.cookies?.authToken;
    if (authToken && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(authToken)) {
      const v = `Bearer ${authToken}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
