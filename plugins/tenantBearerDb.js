// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

/**
 * Extrai o token do header Authorization.
 * Ex.: "Authorization: Bearer ntk_tkn_abc123.SECRET"
 */
function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Token público no formato: ntk_<tkn_id>.<secret>
 * Retorna { id: 'tkn_xxx', secret: '...' } ou null.
 */
function splitPresentedToken(raw) {
  const m = /^ntk_(?<id>[^.]+)\.(?<secret>.+)$/.exec(raw || '');
  return m?.groups || null;
}

/**
 * Resolve o subdomínio do tenant a partir do request.
 * Você pode padronizar por header `x-tenant` OU query `?subdomain=`.
 */
function resolveSubdomain(req) {
  return (
    req.headers['x-tenant'] ||
    req.query?.subdomain ||
    req.params?.subdomain ||
    req.body?.subdomain ||
    null
  );
}

/**
 * Guard de Bearer por tenant (Fastify preHandler).
 * - Valida o "ntk_<id>.<secret>" contra public.tenant_tokens
 * - Exige também o subdomínio do tenant (x-tenant ou ?subdomain=)
 * - Opcionalmente checa escopos (CSV em tenant_tokens.scopes)
 *
 * Uso:
 * fastify.register(minhasRotas, { prefix: '/api/v1/x', preHandler: requireTenantBearerDb(['scope:a']) })
 */
export function requireTenantBearerDb(requiredScopes = []) {
  return async function (req, reply) {
    try {
      // 1) Tenant (subdomain)
      const subdomain = resolveSubdomain(req);
      if (!subdomain) {
        return reply.code(400).send({ error: 'missing_subdomain' });
      }

      // 2) Bearer
      const raw = parseBearer(req.headers);
      if (!raw) {
        return reply.code(401).send({ error: 'missing_token', message: 'Use Authorization: Bearer ntk_<id>.<secret>' });
      }

      const parts = splitPresentedToken(raw);
      if (!parts) {
        return reply.code(401).send({ error: 'bad_token_format' });
      }

      const { id: tokenId, secret: presentedSecret } = parts;

      // 3) Lookup: tenant + token
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
      if (!rec) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
      if (rec.status !== 'active') {
        return reply.code(401).send({ error: 'token_revoked' });
      }
      if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
        return reply.code(401).send({ error: 'token_expired' });
      }

      // 4) Verifica segredo (bcryptjs)
      const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
      if (!ok) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      // 5) Escopos (opcional)
      if (requiredScopes.length > 0) {
        const got = new Set(
          String(rec.scopes || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        );
        for (const s of requiredScopes) {
          if (!got.has(s)) {
            return reply.code(403).send({ error: 'insufficient_scope', needed: requiredScopes });
          }
        }
      }

      // 6) Contexto para handlers
      req.tenantId = rec.tenant_id;
      req.subdomain = rec.subdomain;
      req.tokenId = rec.token_id;
      req.tokenIsDefault = !!rec.is_default;
      req.tokenScopes = rec.scopes;

      // 7) Marca last_used_at (não bloqueia a resposta)
      pool
        .query(`UPDATE public.tenant_tokens SET last_used_at = NOW() WHERE tenant_id = $1 AND id = $2`, [
          rec.tenant_id,
          rec.token_id,
        ])
        .catch(() => {});

      // segue para o handler
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
