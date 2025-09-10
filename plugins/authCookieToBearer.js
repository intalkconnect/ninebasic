// /app/plugins/authCookieToBearer.js
// Converte cookies httpOnly setados pelo AUTH em Authorization: Bearer <...>
export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // se já veio Authorization do cliente ou de proxy, mantém
    if (req.headers.authorization || req.raw.headers['authorization']) return;

    const cookies = req.cookies || {};

    // PRIORIDADE: defaultAssert (JWT curto emitido pelo AUTH, httpOnly)
    const defaultAssert = cookies.defaultAssert;
    if (defaultAssert) {
      const v = `Bearer ${defaultAssert}`; // SEMPRE Bearer
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v; // compat Fastify 4
      return;
    }

    // Compatibilidade: se existir cookie no formato <uuid>.<64hex>, também usa como Bearer
    const maybeBearer = cookies.authToken;
    if (maybeBearer && /^[0-9a-fA-F-]{36}\.[0-9a-fA-F]{64}$/.test(maybeBearer)) {
      const v = `Bearer ${maybeBearer}`;
      req.headers.authorization = v;
      req.raw.headers['authorization'] = v;
    }
  });
}
