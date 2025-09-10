// plugins/tenantBearerDb.js - trecho do requireTenantBearerDb()

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return; // preflight

      // tenant detectado pelo plugin tenant.js (subdomínio)
      const subdomain = req.tenant?.subdomain || req.headers['x-tenant'] || null;
      let tenantId = req.tenant?.id || null;

      if (!tenantId) {
        tenantId = await resolveTenantIdBySubdomain(subdomain);
        if (!tenantId) {
          return reply.code(400).send({ error: 'missing_tenant' });
        }
        if (!req.tenant) req.tenant = {};
        req.tenant.id = tenantId;
      }

      const raw = parseBearer(req.headers);
      
      // Debug melhorado
      if (!raw) {
        req.log?.warn({
          // Headers
          authHeader: req.headers.authorization || 'MISSING',
          host: req.headers.host,
          path: req.url,
          method: req.method,
          // Cookies
          hasCookieHeader: !!req.headers.cookie,
          rawCookieHeader: req.headers.cookie || 'MISSING',
          parsedCookies: req.cookies || {},
          cookieNames: Object.keys(req.cookies || {}),
          hasDefaultAssert: !!(req.cookies?.defaultAssert),
          // Tenant
          tenant: req.tenant,
          subdomain: subdomain
        }, 'MISSING_TOKEN_DEBUG');
        
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer <uuid>.<secret> (ou Bearer <jwt-assert>)',
          debug: {
            hasCookies: Object.keys(req.cookies || {}).length > 0,
            cookieNames: Object.keys(req.cookies || {}),
            hasAuthHeader: !!req.headers.authorization,
            path: req.url,
            tenant: !!tenantId
          }
        });
      }

      // resto da lógica de validação...
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
