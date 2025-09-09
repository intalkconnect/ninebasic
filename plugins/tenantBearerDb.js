// /app/plugins/tenantBearerDb.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken'; // <-- add
import { pool } from '../services/db.js';

function parseAuth(headers = {}) {
  const h = headers.authorization || '';
  const m = /^(Bearer|Session)\s+(.+)$/i.exec(h);
  if (!m) return null;
  return { scheme: m[1], value: m[2] };
}

// Formato de api-key: "<uuid>.<hexsecret>"
function splitIdSecret(raw) {
  const m = /^(?<id>[0-9a-fA-F-]{36})\.(?<secret>[0-9a-fA-F]{64})$/.exec(raw || '');
  return m?.groups || null;
}

export function requireTenantBearerDb() {
  return async function (req, reply) {
    try {
      if (req.method === 'OPTIONS') return;

      // tenant.js deve ter resolvido pelo host:
      const subdomain = req.tenant?.subdomain;
      let tenantId = req.tenant?.id;
      if (!subdomain && !tenantId) {
        return reply.code(400).send({ error: 'missing_tenant' });
      }

      const auth = parseAuth(req.headers);
      if (!auth) {
        return reply.code(401).send({ error: 'missing_token', message: 'Use Authorization: Bearer <id>.<secret> ou Session <jwt>' });
      }

      // === NOVO CAMINHO: sessão via JWT emitido pelo AUTH ===
      if (auth.scheme.toLowerCase() === 'session') {
        try {
          const payload = jwt.verify(auth.value, process.env.JWT_SECRET); // HS256
          // opcional, mas recomendado: enforce tenant do subdomínio
          if (payload.tenant && payload.tenant !== subdomain) {
            return reply.code(401).send({ error: 'tenant_mismatch' });
          }

          // garantir tenantId (caso não preenchido)
          if (!tenantId) {
            const { rows: trows } = await pool.query(
              'SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1',
              [subdomain]
            );
            tenantId = trows[0]?.id;
            if (!tenantId) return reply.code(404).send({ error: 'tenant_not_found' });
            req.tenant.id = tenantId;
          }

          // contexto útil como no caminho do Bearer
          req.tokenId = null;
          req.tokenIsDefault = false;
          req.sessionUser = payload; // quem é o usuário logado

          return; // autorizado pelo caminho "Session"
        } catch (e) {
          req.log?.warn({ msg: 'session_jwt_invalid', err: e?.message });
          return reply.code(401).send({ error: 'invalid_session' });
        }
      }

      // === CAMINHO ANTIGO (inalterado): api-key no formato <uuid>.<hexsecret> ===
      const raw = auth.value;
      const parts = splitIdSecret(raw);
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
