// /app/routes/securityTokens.js
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

function maskToken(id, hint) {
  if (!id) return '—';
  const h = (hint || '').slice(0, 8);
  return `${id}.${h}${'•'.repeat(64 - h.length)}`; // mostra 8, oculta 56
}

export default async function securityTokensRoutes(fastify) {
  // Lista tokens do tenant (mascarados; sem segredo)
  fastify.get('/tokens', async (req, reply) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) return reply.code(400).send({ ok: false, error: 'missing_tenant' });

    const { rows } = await pool.query(
      `SELECT id, name, is_default, status, created_at, last_used_at, secret_hint
         FROM public.tenant_tokens
        WHERE tenant_id = $1
        ORDER BY is_default DESC, created_at DESC`,
      [tenantId]
    );

    const items = rows.map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      is_default: r.is_default,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      preview: maskToken(r.id, r.secret_hint),
    }));

    return { ok: true, items };
  });

 // POST /security/tokens
fastify.post('/tokens', async (req, reply) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return reply.code(400).send({ ok: false, error: 'missing_tenant' });

  const rawName = req.body?.name;
  const name = String(rawName ?? '').trim();
  if (!name) {
    return reply.code(400).send({ ok: false, error: 'name_required', message: 'Informe o nome do token.' });
  }
  if (name.length > 64) {
    return reply.code(400).send({ ok: false, error: 'name_too_long', message: 'Nome do token deve ter até 64 caracteres.' });
  }

  const isDefault = !!req.body?.is_default;

  const { rows } = await pool.query(
    `SELECT token, token_id
       FROM public.issue_tenant_token_id_secret($1, $2, $3)`,
    [tenantId, name, isDefault]
  );

  const out = rows?.[0];
  return { ok: true, id: out?.token_id, token: out?.token };
});


  // Revoga (não permite revogar o default)
  fastify.post('/tokens/:id/revoke', async (req, reply) => {
    const tenantId = req.tenant?.id;
    const tokenId = req.params?.id;
    if (!tenantId || !tokenId) return reply.code(400).send({ ok: false, error: 'bad_request' });

    const { rows } = await pool.query(
      `SELECT is_default, status FROM public.tenant_tokens WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [tokenId, tenantId]
    );
    const rec = rows?.[0];
    if (!rec) return reply.code(404).send({ ok: false, error: 'not_found' });
    if (rec.is_default) return reply.code(400).send({ ok: false, error: 'cannot_revoke_default' });
    if (rec.status === 'revoked') return { ok: true, already: true };

    await pool.query(
      `UPDATE public.tenant_tokens SET status = 'revoked' WHERE id = $1 AND tenant_id = $2`,
      [tokenId, tenantId]
    );
    return { ok: true };
  });

}
