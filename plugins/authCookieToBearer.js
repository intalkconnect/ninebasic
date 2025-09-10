// plugins/authCookieToBearer.js
export default async function authCookieToBearer(fastify) {
  fastify.addHook('onRequest', async (req) => {
    // Se já veio Authorization, não mexe
    if (req.headers.authorization) {
      req.log?.info({
        hasExistingAuth: true,
        authHeader: req.headers.authorization.substring(0, 20) + '...',
        path: req.url
      }, 'authCookieToBearer: Authorization header already exists');
      return;
    }

    // Debug completo dos cookies
    const rawCookieHeader = req.headers.cookie || '';
    const cookies = req.cookies || {};
    
    req.log?.info({
      hasRawCookieHeader: !!rawCookieHeader,
      rawCookieHeader: rawCookieHeader,
      parsedCookies: cookies,
      cookieNames: Object.keys(cookies),
      hasDefaultAssert: !!cookies.defaultAssert,
      defaultAssertValue: cookies.defaultAssert ? `${cookies.defaultAssert.substring(0, 30)}...` : null,
      path: req.url,
      host: req.headers.host,
    }, 'authCookieToBearer: cookie analysis');

    // Promove defaultAssert -> Authorization: Bearer <jwt-assert>
    const assert = cookies.defaultAssert;
    if (assert) {
      req.headers.authorization = `Bearer ${assert}`;
      req.log?.info({
        injectedAuth: true,
        tokenPreview: assert.substring(0, 30) + '...',
        path: req.url
      }, 'authCookieToBearer: injected Authorization header');
    } else {
      req.log?.warn({
        injectedAuth: false,
        reason: 'defaultAssert cookie not found',
        availableCookies: Object.keys(cookies),
        rawCookieExists: !!rawCookieHeader,
        path: req.url
      }, 'authCookieToBearer: NO TOKEN TO INJECT');
    }
  });
}
