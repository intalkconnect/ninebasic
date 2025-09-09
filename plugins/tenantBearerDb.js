import bcrypt from 'bcryptjs';
import db from '../services/db.js';

function parseBearer(headers) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function splitPresentedToken(raw) {
  const m = /^ntk_(?<id>[^.]+)\.(?<secret>.+)$/.exec(raw || '');
  return m?.groups || null;
}

function resolveSubdomain(req) {
  return (
    req.headers['x-tenant'] ||
    req.query.subdomain ||
    req.params.subdomain ||
    req.body?.subdomain ||
    null
  );
}

// retorna um hook fastify (preHandler)
export function requireTenantBearerDb(requiredScopes = []) {
  return async function (req, reply) {
    const subdomain = resolveSubdomain(req);
    if (!subdomain) {
      return reply.code(400).send({ error: 'missing_subdomain' });
    }

    const raw = parseBearer(req.headers);
    if (!raw) {
      return reply.code(401).send({ error: 'missing_token' });
    }

    const parts = splitPresentedToken(raw);
    if (!parts) {
      return reply.code(401).send({ error: 'bad_token_format' });
    }

    const { id: tokenId, secret: presentedSecret } = parts;

    const { rows } = await db.query(
      `
      SELECT t.id AS tenant_id,
             t.subdomain,
             tt.id AS token_id,
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
    if (rec.status !== 'active') return reply.code(401).send({ error: 'token_revoked' });
    if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
      return reply.code(401).send({ error: 'token_expired' });
    }

    const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_token' });

    // escopos
    if (requiredScopes.length > 0) {
      const got = new Set((rec.scopes || '').split(',').map(s => s.trim()).filter(Boolean));
      for (const s of requiredScopes) {
        if (!got.has(s)) {
          return reply.code(403).send({ error: 'insufficient_scope', needed: requiredScopes });
        }
      }
    }

    // anexa infos no request
    req.tenantId = rec.tenant_id;
    req.subdomain = rec.subdomain;
    req.tokenId = rec.token_id;
    req.tokenIsDefault = !!rec.is_default;
    req.tokenScopes = rec.scopes;

    // toca uso (fire and forget)
    db.query(`SELECT public.touch_token_usage($1, $2)`, [rec.tenant_id, rec.token_id]).catch(() => {});
  };
}
