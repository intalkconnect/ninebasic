// plugins/authCookieToBearer.js (para Fastify 4)
import cookie from 'cookie';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.cookies) {
      req.cookies = cookie.parse(req.headers.cookie || '');
    }
    // já tem Authorization? deixa
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    const raw = req.cookies?.authToken; // mesmo nome setado no Auth
    if (!raw) return;

    // Validação leve de formato: "<uuid>.<64 hex>"
    const okFormat = /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(raw);
    if (!okFormat) return; // deixa o guard responder 401

    // injeta o Bearer nos DOIS lugares
    const v = `Bearer ${raw}`;
    req.headers.authorization = v;
    req.raw.headers['authorization'] = v;
  });
}
