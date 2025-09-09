// plugins/tenantBearerDb.js
const bcrypt = require('bcrypt');
const db = require('../services/db'); // seu client pg/knex/pool

function parseBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// token formato: ntk_<id>.<secret>
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

function requireTenantBearerDb(requiredScopes = []) {
  return async (req, res, next) => {
    try {
      const subdomain = resolveSubdomain(req);
      if (!subdomain) return res.status(400).json({ error: 'missing_subdomain' });

      const raw = parseBearer(req);
      if (!raw) return res.status(401).json({ error: 'missing_token', message: 'Use Authorization: Bearer <token>' });

      const parts = splitPresentedToken(raw);
      if (!parts) return res.status(401).json({ error: 'bad_token_format' });

      const { id: tokenId, secret: presentedSecret } = parts;

      // 1 consulta: resolve tenant_id e token record
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
      if (!rec) return res.status(401).json({ error: 'invalid_token' });
      if (rec.status !== 'active') return res.status(401).json({ error: 'token_revoked' });
      if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ error: 'token_expired' });
      }

      const ok = await bcrypt.compare(presentedSecret, rec.secret_hash);
      if (!ok) return res.status(401).json({ error: 'invalid_token' });

      // escopos (opcional)
      if (requiredScopes.length > 0) {
        const got = new Set((rec.scopes || '').split(',').map(s => s.trim()).filter(Boolean));
        for (const s of requiredScopes) {
          if (!got.has(s)) return res.status(403).json({ error: 'insufficient_scope', needed: requiredScopes });
        }
      }

      req.tenantId = rec.tenant_id;
      req.subdomain = rec.subdomain;
      req.tokenId = rec.token_id;
      req.tokenIsDefault = !!rec.is_default;
      req.tokenScopes = rec.scopes;

      // (assíncrono, sem bloquear)
      db.query(`SELECT public.touch_token_usage($1, $2)`, [rec.tenant_id, rec.token_id]).catch(()=>{});

      return next();
    } catch (e) {
      return res.status(500).json({ error: 'auth_error', detail: e.message });
    }
  };
}

module.exports = { requireTenantBearerDb };
