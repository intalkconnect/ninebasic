// plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../services/db.js';

// 🔐 NADA de env aqui: segredo fixo e igual no AUTH e no ENDPOINTS
// Use exatamente o mesmo valor no AUTH (index.js).
const JWT_SECRET = 'ninechat-default-secret-v1';

function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Formato do token de API: "<uuid>.<hexsecret>"
function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

async function resolveTenantIdBySubdomain(subdomain) {
  if (!subdomain) return null;

  // tenta em public.tenants (subdomain)
  try {
    const q = await pool.query(
      'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
      [subdomain]
    );
    if (q.rows[0]?.id) return q.rows[0].id;
  } catch {}

  // fallback: public.companies (slug)
  try {
    const q = await pool.query(
      'SELECT id FROM public.companies WHERE slug = $1 LIMIT 1',
      [subdomain]
    );
    if (q.rows[0]?.id) return q.rows[0].id;
  } catch {}

  return null;
}

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
      if (!raw) {
        req.log?.info(
          {
            hasCookieHeader: !!req.headers.cookie,
            cookieNames: req.headers.cookie
              ? Object.keys((req.cookies || {}))
              : [],
            path: req.url,
            host: req.headers.host,
          },
          'missing_token_debug'
        );
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer <uuid>.<secret> (ou Bearer <jwt-assert>)'
        });
      }

      // 1) Se não for "<uuid>.<secret>", tratamos como JWT "assert" do default
      const parts = splitIdSecret(raw);
      if (!parts) {
        // JWT assert do cookie defaultAssert
        let payload;
        try {
          payload = jwt.verify(raw, JWT_SECRET); // HS256
        } catch (e) {
          return reply.code(401).send({ error: 'invalid_bearer' });
        }

        if (payload?.typ !== 'default-assert' || !payload?.tokenId) {
          return reply.code(401).send({ error: 'invalid_bearer' });
        }

        // Confere se tokenId existe, é do tenant e é default + ativo
        const { rows } = await pool.query(
          `SELECT id, is_default, status
             FROM public.tenant_tokens
            WHERE id = $1 AND tenant_id = $2
            LIMIT 1`,
          [payload.tokenId, tenantId]
        );
        const rec = rows[0];
        if (!rec) return reply.code(401).send({ error: 'invalid_token' });
        if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });
        if (!rec.is_default) return reply.code(401).send({ error: 'not_default_token' });

        req.tokenId = rec.id;
        req.tokenIsDefault = true;
        // marca uso (não bloqueante)
        pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});
        return; // autorizado
      }

      // 2) Caminho tradicional: <uuid>.<secret>
      const { id: tokenId, secret: presentedSecret } = parts;

      const { rows } = await pool.query(
        `SELECT id, secret_hash, is_default, status
           FROM public.tenant_tokens
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [tokenId, tenantId]
      );
      const rec = rows[0];
      if (!rec) return reply.code(401).send({ error: 'invalid_token' });
      if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });

      const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
      if (!ok) return reply.code(401).send({ error: 'invalid_token' });

      req.tokenId = rec.id;
      req.tokenIsDefault = !!rec.is_default;
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
