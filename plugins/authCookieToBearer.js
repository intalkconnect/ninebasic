// plugins/authCookieToBearer.js
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // Se já veio Authorization, não mexe.
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    const rawCookie = req.headers.cookie || '';
    const cookies = rawCookie ? cookie.parse(rawCookie) : {};
    req.cookies = req.cookies || cookies;

    // ⚠️ SEMPRE promove defaultAssert -> Authorization: Bearer <jwt-assert>
    const assert = cookies.defaultAssert;
    if (assert) {
      const v = `Bearer ${assert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // compat Fastify 4
      req.log?.info(
        {
          hasCookieHeader: !!rawCookie,
          cookieNames: Object.keys(cookies),
          path: req.url,
          host: req.headers.host,
        },
        'authCookieToBearer: injected Authorization'
      );
    }
  });
}
