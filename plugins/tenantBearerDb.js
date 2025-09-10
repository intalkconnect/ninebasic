// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../services/db.js';

function parseBearer(h = '') {
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  return m ? m[1] : null;
}
function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

async function resolveTenantIdBySubdomain(subdomain) {
  if (!subdomain) return null;
  try {
    const r = await pool.query('SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1', [subdomain]);
    if (r.rows[0]?.id) return r.rows[0].id;
  } catch {}
  try {
    const r = await pool.query('SELECT id FROM public.companies WHERE slug = $1 LIMIT 1', [subdomain]);
    if (r.rows[0]?.id) return r.rows[0].id;
  } catch {}
  return null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return;

      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;
      if (!tenantId) {
        tenantId = await resolveTenantIdBySubdomain(subdomain);
        if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
        req.tenant = { id: tenantId, subdomain };
      }

      const raw = parseBearer(req.headers.authorization || req.raw.headers['authorization'] || '');
      if (!raw) {
        // 🔎 LOG ÚTIL: mostra se o cookie veio e por que não transformou
        req.log?.warn({
          hasCookieHeader: !!req.headers.cookie,
          cookieNames: Object.keys(req.cookies || {}),
          path: req.url,
          host: req.headers.host
        }, 'missing_token_debug');
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer <uuid>.<secret> (ou Bearer <jwt-assert>)'
        });
      }

      // Caminho 1 — <uuid>.<secret>
      const parts = splitIdSecret(raw);
      if (parts) {
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
        return;
      }

      // Caminho 2 — JWT do defaultAssert
      let payload;
      try {
        payload = jwt.verify(raw, process.env.JWT_SECRET || 'dev-secret');
      } catch {
        return reply.code(401).send({ error: 'invalid_bearer', detail: 'jwt_verify_failed' });
      }
      if (payload.typ !== 'default-assert' || !payload.tokenId) {
        return reply.code(401).send({ error: 'invalid_bearer', detail: 'bad_payload' });
      }

      const { rows } = await pool.query(
        `SELECT id, is_default, status
           FROM public.tenant_tokens
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [payload.tokenId, tenantId]
      );
      const rec = rows[0];
      if (!rec) return reply.code(401).send({ error: 'default_token_not_found' });
      if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });
      if (!rec.is_default) return reply.code(401).send({ error: 'not_default_token' });

      req.tokenId = rec.id;
      req.tokenIsDefault = true;
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
