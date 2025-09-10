import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // usa req.cookies; se não existir, parse manual do header
    const cookies = req.cookies ?? cookie.parse(req.headers.cookie || '');

    if (cookies.defaultAssert) {
      const v = `Bearer ${cookies.defaultAssert}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
      return;
    }

    const t = cookies.authToken;
    if (t && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(t)) {
      const v = `Bearer ${t}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
