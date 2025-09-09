// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Formato: "<uuid>.<hexsecret>"
function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return; // preflight CORS

      // tenant.js deve ter resolvido pelo host:
      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;

      if (!subdomain && !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const raw = parseBearer(req.headers);
      if (!raw) {
        return reply.code(401).send({ error: 'missing_token', message: 'Use Authorization: Bearer <id>.<secret>' });
      }

      const parts = splitIdSecret(raw);
      if (!parts) {
        return reply.code(401).send({ error: 'bad_token_format' });
      }

      const { id: tokenId, secret: presentedSecret } = parts;

      // garante tenantId (1 query) caso o plugin não tenha preenchido
      if (!tenantId) {
        const { rows: trows } = await pool.query(
          'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
          [subdomain]
        );
        tenantId = trows[0]?.id;
        if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
        req.tenant.id = tenantId; // guarda pra frente
      }

      // busca APENAS o token pelo id, vinculado ao tenant
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

      // contexto útil
      req.tokenId = rec.id;
      req.tokenIsDefault = !!rec.is_default;

      // marca uso (não bloqueia)
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
