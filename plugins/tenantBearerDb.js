import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export function requireTenantBearerDb(requiredScopes = []) {
  return async function (req, reply) {
    try {
      const subdomain = req.tenant?.subdomain;  // já resolvido pelo tenant.js
      const tenantId = req.tenant?.id;
      if (!subdomain || !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const rawToken = parseBearer(req.headers);
      if (!rawToken) {
        return reply.code(401).send({ error: 'missing_token' });
      }

      // busca tokens ativos do tenant
      const { rows } = await pool.query(
        `SELECT id, token_hash, is_default, scopes, expires_at
           FROM public.tenant_tokens
          WHERE tenant_id = $1
            AND status = 'active'`,
        [tenantId]
      );

      let rec = null;
      for (const row of rows) {
        if (await bcrypt.compare(rawToken, row.token_hash)) {
          rec = row;
          break;
        }
      }

      if (!rec) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
      if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
        return reply.code(401).send({ error: 'token_expired' });
      }

      // escopos opcionais
      if (requiredScopes.length > 0) {
        const got = new Set(
          String(rec.scopes || '').split(',').map(s => s.trim()).filter(Boolean)
        );
        for (const s of requiredScopes) {
          if (!got.has(s)) {
            return reply.code(403).send({ error: 'insufficient_scope', needed: requiredScopes });
          }
        }
      }

      req.tokenId = rec.id;
      req.tokenIsDefault = !!rec.is_default;
      req.tokenScopes = rec.scopes;

      // marca uso
      pool.query(
        `UPDATE public.tenant_tokens SET last_used_at = now() WHERE id = $1`,
        [rec.id]
      ).catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
