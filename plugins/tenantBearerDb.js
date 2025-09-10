// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../services/db.js';

function parseBearer(h = '') {
  // espera "Bearer <token>"
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  return m ? m[1] : null;
}

function splitIdSecret(raw) {
  // formato clássico do seu guard
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return; // preflight

      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;
      if (!subdomain && !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const raw = parseBearer(req.headers.authorization || req.raw.headers['authorization'] || '');
      if (!raw) {
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer <uuid>.<secret> (ou Bearer <jwt-assert>)'
        });
      }

      // 1) Caminho antigo: Bearer <uuid>.<hexsecret>
      const parts = splitIdSecret(raw);
      if (parts) {
        const { id: tokenId, secret: presentedSecret } = parts;

        if (!tenantId) {
          const t = await pool.query(
            'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
            [subdomain]
          );
          tenantId = t.rows[0]?.id;
          if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
          req.tenant.id = tenantId;
        }

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
        pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(()=>{});
        return; // autorizado
      }

      // 2) NOVO: Bearer <jwt-assert> (defaultAssert do AUTH), mantendo esquema Bearer
      let payload;
      try {
        payload = jwt.verify(raw, process.env.JWT_SECRET || 'dev-secret');
      } catch (e) {
        return reply.code(401).send({ error: 'invalid_bearer', detail: 'jwt_verify_failed' });
      }

      if (payload.typ !== 'default-assert' || !payload.tokenId || !payload.tenant) {
        return reply.code(401).send({ error: 'invalid_bearer', detail: 'bad_payload' });
      }

      // tenant do subdomínio precisa bater
      if (!tenantId) {
        const t = await pool.query(
          'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
          [subdomain]
        );
        tenantId = t.rows[0]?.id;
        if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
        req.tenant.id = tenantId;
      }

      // tokenId do payload precisa ser o DEFAULT & ACTIVE do tenant
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
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(()=>{});
      // autorizado
    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
