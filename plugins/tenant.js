// plugins/tenant.js
import fp from 'fastify-plugin';
import {
  extractSubdomain,
  lookupSchemaBySubdomain,
  withTenant,
} from '../services/db.js';

// (opcional) habilitar rota /t/:tenant/... sem precisar do header nem subdomínio
function extractTenantFromPath(req) {
  const raw = req.raw?.url || req.url || '';
  const m = raw.match(/^\/t\/([a-z0-9][a-z0-9._-]*)($|\/)/i);
  if (!m) return null;

  const tenant = m[1].toLowerCase();
  // reescreve a URL removendo o prefixo /t/<tenant>
  const rewritten = raw.replace(`/t/${tenant}`, '') || '/';
  if (req.raw) req.raw.url = rewritten;
  req.url = rewritten;
  return tenant;
}

export default fp(async function tenantPlugin(fastify) {
  fastify.decorateRequest('tenant', null);
  fastify.decorateRequest('db', null);

  fastify.addHook('onRequest', async (req, reply) => {
    // bypass opcional
    if (req.url === '/healthz') return;

    // 1) tenta header x-tenant (case-insensitive)
    const headerTenant = String(req.headers['x-tenant'] || '').trim().toLowerCase();

    // 2) tenta query ?tenant=hmg (útil em testes locais, Postman etc.)
    const queryTenant = String(req.query?.tenant || '').trim().toLowerCase();

    // 3) tenta caminho /t/hmg/...
    const pathTenant = extractTenantFromPath(req);

    // 4) resolve do host: prioriza X-Forwarded-Host (Nginx), depois Host
    const forwardedHost = String(
      req.headers['x-forwarded-host'] ||
      req.headers['x-original-host'] ||
      req.headers['host'] ||
      ''
    );
    const hostTenant = extractSubdomain(forwardedHost);

    // ordem de precedência: header > query > path > host
    const sub = headerTenant || queryTenant || pathTenant || hostTenant;

    let schema;
    try {
      schema = await lookupSchemaBySubdomain(sub);
    } catch (err) {
      // 42P01 = relation does not exist (provável catálogo ausente)
      if (err && err.code === '42P01') {
        req.log.error({ err }, 'Catálogo global ausente: public.tenants');
        return reply.code(500).send({
          ok: false,
          error: 'catalog_missing',
          message: 'A tabela public.tenants não existe. Rode o bootstrap SQL antes de iniciar o app.',
        });
      }
      throw err;
    }

    if (!schema) {
      req.log.warn(
        { host: forwardedHost, sub, headerTenant, queryTenant, pathTenant },
        'tenant não encontrado'
      );
      return reply.code(404).send({ ok: false, error: 'tenant_not_found' });
    }

    // expõe informações do tenant na request
    req.tenant = { subdomain: sub, schema };

    // executores por request (sempre com search_path = <schema>, public)
    req.db = {
      /**
       * Transação no schema do tenant.
       * Uso: await req.db.tx(async (client) => { await client.query(...); })
       */
      tx: (fn) => withTenant(schema, fn),

      /**
       * Açúcar p/ uma única query no schema do tenant.
       * Uso: await req.db.query('SELECT ...', [params])
       */
      query: (text, params) => withTenant(schema, (c) => c.query(text, params)),
    };
  });
});
