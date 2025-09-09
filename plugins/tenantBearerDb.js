// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

function parseBearer(headers = {}) {
  const h = headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return; // libera preflight

      // tenant.js já deve ter resolvido o subdomínio e, idealmente, o id
      const tenantId = req.tenant?.id;
      const subdomain = req.tenant?.subdomain;

      if (!tenantId && !subdomain) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const rawToken = parseBearer(req.headers);
      if (!rawToken) {
        return reply.code(401).send({ error: 'missing_token', message: 'Use Authorization: Bearer <uuid>' });
      }

      // garante tenantId (se o plugin não tiver preenchido)
      let tId = tenantId;
      if (!tId) {
        const { rows } = await pool.query(
          'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
          [subdomain]
        );
        tId = rows[0]?.id;
        if (!tId) return reply.code(404).send({ error: 'tenant_not_found' });
        req.tenant.id = tId; // cacheia
      }

      // busca tokens ativos do tenant (sem scopes/expiração)
      const { rows: toks } = await pool.query(
        `SELECT id, token_hash, is_default
           FROM public.tenant_tokens
          WHERE tenant_id = $1 AND status = 'active'`,
        [tId]
      );

      let rec = null;
      for (const r of toks) {
        if (await bcrypt.compare(rawToken, r.token_hash)) { rec = r; break; }
      }

      if (!rec) return reply.code(401).send({ error: 'invalid_token' });

      // contexto útil ao handler
      req.tokenId = rec.id;
      req.tokenIsDefault = !!rec.is_default;

      // marca uso (assíncrono)
      pool.query(`UPDATE public.tenant_tokens SET last_used_at = now() WHERE id = $1`, [rec.id]).catch(() => {});
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
