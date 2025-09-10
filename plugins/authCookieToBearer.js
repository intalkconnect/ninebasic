// plugins/authCookieToDefault.js
import cookie from 'cookie';

export default async function authCookieToDefault(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // já deu Authorization? respeita
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // parse cookies (sem depender de @fastify/cookie)
    if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || '');

    const j = req.cookies?.defaultAssert;
    if (!j) return; // sem cookie, segue fluxo normal

    const v = `Default ${j}`;
    req.headers.authorization = v;
    req.raw.headers['authorization'] = v; // Fastify 4 precisa dos dois
  });
}
