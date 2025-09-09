// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function splitPresentedToken(raw) {
  const m = /^ntk_(?<id>[^.]+)\.(?<secret>.+)$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb(requiredScopes = []) {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return; // libera preflight

      // ✅ subdomain já resolvido pelo tenantPlugin
      const subdomain = req.tenant?.subdomain;
      if (!subdomain) {
        return reply.code(400).send({ error: 'missing_subdomain' });
      }

      const raw = parseBearer(req.headers);
      if (!raw) {
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer ntk_<id>.<secret>',
        });
      }

      const parts = splitPresentedToken(raw);
      if (!parts) {
        return reply.code(401).send({ error: 'bad_token_format' });
      }

      const { id: tokenId, secret: presentedSecret } = parts;

      const { rows } = await pool.query(
        `
        SELECT t.id          AS tenant_id,
               t.subdomain   AS subdomain,
               tt.id         AS token_id,
               tt.secret_hash,
               tt.is_default,
               tt.status,
               tt.scopes,
               tt.expires_at
          FROM public.tenants t
          JOIN public.tenant_tokens tt
            ON tt.tenant_id = t.id
         WHERE t.subdomain = $1
           AND tt.id = $2
         LIMIT 1
        `,
        [subdomain, tokenId]
      );

      const rec = rows[0];
      if (!rec) return reply.code(401).send({ error: 'invalid_token' });
      if (rec.status !== 'active')
        return reply.code(401).send({ error: 'token_revoked' });
      if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now())
        return reply.code(401).send({ error: 'token_expired' });

      const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
      if (!ok) return reply.code(401).send({ error: 'invalid_token' });

      if (requiredScopes.length > 0) {
        const got = new Set(
          String(rec.scopes || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        for (const s of requiredScopes) {
          if (!got.has(s)) {
            return reply
              .code(403)
              .send({ error: 'insufficient_scope', needed: requiredScopes });
          }
        }
      }

      // expõe no req
      req.tenantId = rec.tenant_id;
      req.tokenId = rec.token_id;
      req.tokenIsDefault = !!rec.is_default;
      req.tokenScopes = rec.scopes;

      pool
        .query(
          `UPDATE public.tenant_tokens SET last_used_at = NOW() WHERE tenant_id = $1 AND id = $2`,
          [rec.tenant_id, rec.token_id]
        )
        .catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply
        .code(500)
        .send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
