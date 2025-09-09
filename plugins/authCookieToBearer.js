// plugins/authCookieToBearer.js
import jwt from 'jsonwebtoken';

export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    // Se já veio Authorization (ex.: testes), não mexe
    if (req.headers.authorization) return;

    const token = req.cookies?.authToken; // mesmo nome usado no Auth
    if (!token) return; // sem cookie -> guard responderá 401 depois

    try {
      // Verifica HS256 com a MESMA chave do Auth
      const payload = jwt.verify(token, process.env.JWT_SECRET);

      // (opcional) valida tenant do token vs subdomínio do Host, se você incluir 'tenant' no payload
      // const sub = (req.headers.host || '').toLowerCase().split('.')[0];
      // if (payload.tenant && payload.tenant !== sub) return;

      req.user = payload; // útil para plugins que leem req.user
      // Cria o header que seu guard atual espera
      req.headers.authorization = `Bearer ${token}`;
    } catch (e) {
      req.log.warn({ msg: 'invalid/expired auth cookie', err: e?.message });
      // não injeta header -> guard dará 401
    }
  });
}
