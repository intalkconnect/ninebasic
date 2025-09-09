// plugins/authCookieToDefault.js
import cookie from 'cookie';

export default async function authCookieToDefault(fastify) {
  fastify.addHook('onRequest', async (req) => {
    if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || '');
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    const j = req.cookies?.defaultAssert;
    if (!j) return;

    const v = `Default ${j}`;
    req.headers.authorization = v;
    req.raw.headers['authorization'] = v; // Fastify 4: injete nos dois
  });
}
