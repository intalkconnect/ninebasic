// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../services/db.js';

function parseAuth(headers = {}) {
  const h = headers.authorization || '';
  const m = /^(Bearer|Default)\s+(.+)$/i.exec(h);
  return m ? { scheme: m[1], value: m[2] } : null;
}

function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return;

      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;
      if (!subdomain && !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const auth = parseAuth(req.headers);
      if (!auth) {
        return reply.code(401).send({
          error: 'missing_token',
          message: 'Use Authorization: Bearer <id>.<secret> ou Default <jwt>'
        });
      }

      // ===== NOVO: caminho "Default" (sem secret, usa token default do tenant) =====
      if (auth.scheme.toLowerCase() === 'default') {
        let payload;
        try {
          payload = jwt.verify(auth.value, process.env.JWT_SECRET); // HS256
        } catch (e) {
          return reply.code(401).send({ error: 'invalid_default_assert' });
        }

        if (payload.typ !== 'default-assert') {
          return reply.code(401).send({ error: 'invalid_default_assert_type' });
        }

        // reforço de multitenant: subdomínio deve bater
        if (payload.tenant && payload.tenant !== subdomain) {
          return reply.code(401).send({ error: 'tenant_mismatch' });
        }

        if (!tenantId) {
          const { rows: trows } = await pool.query(
            'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
            [subdomain]
          );
          tenantId = trows[0]?.id;
          if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
          req.tenant.id = tenantId;
        }

        // conferir no banco que o tokenId do JWT:
        // - pertence ao tenant
        // - está ACTIVE
        // - é DEFAULT
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

        // sucesso: contexto coerente com o caminho Bearer
        req.tokenId = rec.id;
        req.tokenIsDefault = true;
        // opcional: marcar uso
        pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});
        return; // autorizado
      }
      // ===== FIM do caminho "Default" =====

      // ===== Caminho existente (inalterado): Bearer <uuid>.<hexsecret> =====
      const parts = splitIdSecret(auth.value);
      if (!parts) {
        return reply.code(401).send({ error: 'bad_token_format' });
      }
      const { id: tokenId, secret: presentedSecret } = parts;

      if (!tenantId) {
        const { rows: trows } = await pool.query(
          'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
          [subdomain]
        );
        tenantId = trows[0]?.id;
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
      pool.query('SELECT public.touch_token_usage($1)', [rec.id]).catch(() => {});

    } catch (err) {
      req.log?.error({ err }, 'tenantBearerDb error');
      return reply.code(500).send({ error: 'auth_error', detail: err?.message || String(err) });
    }
  };
}
