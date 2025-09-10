// /app/plugins/authCookieToBearer.js
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // já tem Authorization? respeita
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    // parse simples dos cookies
    if (!req.cookies) req.cookies = cookie.parse(req.headers.cookie || '');

    // PRIORIDADE: usar o assert curto do AUTH (httpOnly)
    const defaultAssert = req.cookies?.defaultAssert;
    if (defaultAssert) {
      const v = `Bearer ${defaultAssert}`;    // <- sempre "Bearer"
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;   // Fastify 4
      return;
    }

    // Compat: se existir um cookie que já seja <uuid>.<64hex>, também vira Bearer
    const maybeBearer = req.cookies?.authToken; // só funciona se estiver no formato id.secret
    if (maybeBearer && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(maybeBearer)) {
      const v = `Bearer ${maybeBearer}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
