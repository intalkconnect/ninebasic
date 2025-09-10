// plugins/authCookieToBearer.js
export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // Se já veio Authorization, não mexe
    if (req.headers.authorization) return;

    // Usa o req.cookies que já foi processado pelo @fastify/cookie
    const cookies = req.cookies || {};
    
    // Debug: log dos cookies disponíveis
    req.log?.info({
      cookiesAvailable: Object.keys(cookies),
      defaultAssertExists: !!cookies.defaultAssert,
      defaultAssertValue: cookies.defaultAssert ? `${cookies.defaultAssert.substring(0, 10)}...` : null,
      path: req.url,
      host: req.headers.host,
    }, 'authCookieToBearer: checking cookies');

    // Promove defaultAssert -> Authorization: Bearer <jwt-assert>
    const assert = cookies.defaultAssert;
    if (assert) {
      req.headers.authorization = `Bearer ${assert}`;
      req.log?.info({
        injectedAuth: true,
        path: req.url
      }, 'authCookieToBearer: injected Authorization header');
    } else {
      req.log?.info({
        injectedAuth: false,
        reason: 'defaultAssert cookie not found',
        availableCookies: Object.keys(cookies)
      }, 'authCookieToBearer: no token to inject');
    }
  });
}
