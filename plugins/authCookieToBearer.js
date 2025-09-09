// plugins/authCookieToBearer.js (compatível com Fastify 4)
import cookie from 'cookie';
import jwt from 'jsonwebtoken';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    // Parse simples de cookie
    if (!req.cookies) {
      const raw = req.headers.cookie || '';
      req.cookies = cookie.parse(raw);
    }

    // Já veio Authorization? não mexe
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    const token = req.cookies?.authToken; // MESMO nome usado no Auth
    if (!token) return; // sem cookie -> guard retornará 401

    try {
      // HS256 com a MESMA chave do Auth
      const payload = jwt.verify(token, process.env.JWT_SECRET);

      // (opcional) reforço de multitenant: token.tenant vs subdomínio
      // const host = (req.headers.host || '').toLowerCase();
      // const sub = host.split('.')[0];
      // if (payload.tenant && payload.tenant !== sub) return;

      // Disponibiliza p/ outros plugins
      req.user = payload;

      // ⚠️ Injetar nos DOIS lugares em Fastify 4:
      req.headers.authorization = `Bearer ${token}`;
      req.raw.headers['authorization'] = `Bearer ${token}`;
    } catch (e) {
      req.log.warn({ msg: 'invalid/expired auth cookie', err: e?.message });
      // não injeta -> guard vai responder 401
    }
  });
}
