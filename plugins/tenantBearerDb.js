// plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../services/db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET ausente (ENDPOINTS). Use a MESMA chave do AUTH.');
}

function parseBearer(h = '') {
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  return m ? m[1] : null;
}

function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return;

      // tenant vindo do plugin (subdomínio)
      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;
      if (!subdomain && !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      // Authorization OU cookie promovido
      const authHeader = req.headers.authorization || req.raw.headers['authorization'] || '';
      const tokenStr = parseBearer(authHeader);

      if (!tokenStr) {
        req.log?.info({ hasCookieHeader: !!req.headers.cookie, cookieNames: Object.keys(req.cookies || {}), path: req.url, host: req.headers.host }, 'missing_token_debug');
        return reply.code(401).send({ error: 'missing_token', message: 'Use Authorization: Bearer <uuid>.<secret> (ou Bearer <jwt-assert>)' });
      }

      // Garantir tenantId pelo subdomínio (se não veio resolvido)
      async function ensureTenantId() {
        if (tenantId) return tenantId;
        // tenta tenants.subdomain
        const t1 = await pool.query('SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1', [subdomain]);
        tenantId = t1.rows[0]?.id || null;
        if (tenantId) { req.tenant.id = tenantId; return tenantId; }
        // fallback: companies.slug
        const t2 = await pool.query('SELECT id FROM public.companies WHERE slug = $1 LIMIT 1', [subdomain]);
        tenantId = t2.rows[0]?.id || null;
        if (tenantId) { req.tenant.id = tenantId; return tenantId; }
        return null;
      }

      // Caminho 1: <uuid>.<secret>
      const parts = splitIdSecret(tokenStr);
      if (parts) {
        const { id: tokenId, secret: presentedSecret } = parts;
        const resolved = await ensureTenantId();
        if (!resolved) return reply.code(404).send({ error: 'tenant_not_found' });

        const { rows } = await pool.query(
          `SELECT id, secret_hash, is_default, status
             FROM public.tenant_tokens
            WHERE id = $1 AND tenant_id = $2
            LIMIT 1`,
          [tokenId, resolved]
        );
        const rec = rows[0];
        if (!rec) return reply.code(401).send({ error: 'invalid_token' });
        if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });

        const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
        if (!ok) return reply.code(401).send({ error: 'invalid_token' });

        req.tokenId = rec.id;
        req.tokenIsDefault = !!rec.is_default;
        pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(()=>{});
        return; // autorizado
      }

      // Caminho 2: JWT assert do default
      let payload;
      try {
        payload = jwt.verify(tokenStr, JWT_SECRET);
      } catch (e) {
        return reply.code(401).send({ error: 'invalid_bearer', reason: 'jwt_verify_failed' });
      }
      if (payload?.typ !== 'default-assert' || !payload?.tokenId) {
        return reply.code(401).send({ error: 'invalid_bearer', reason: 'bad_payload' });
      }

      const resolved = await ensureTenantId();
      if (!resolved) return reply.code(404).send({ error: 'tenant_not_found' });

      // verifica se o tokenId é DEFAULT & ACTIVE para esse tenant
      const { rows } = await pool.query(
        `SELECT id, is_default, status
           FROM public.tenant_tokens
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [payload.tokenId, resolved]
      );
      const rec = rows[0];
      if (!rec) return reply.code(401).send({ error: 'default_token_not_found' });
      if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });
      if (!rec.is_default) return reply.code(401).send({ error: 'not_default_token' });

      req.tokenId = rec.id;
      req.tokenIsDefault = true;
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(()=>{});
      return; // autorizado
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
