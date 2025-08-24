// routes/atendentes.js
import { pool } from '../services/db.js'; // pool global (public)

// Config da API externa de invite
const INVITE_API_URL = process.env.INVITE_API_URL || 'https://srv-auth.dkdevs.com.br/api/invite';
const INVITE_API_TOKEN = process.env.INVITE_API_TOKEN || ''; // opcional

async function triggerInvite({ email, companySlug, profile }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const res = await fetch(INVITE_API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(INVITE_API_TOKEN ? { Authorization: `Bearer ${INVITE_API_TOKEN}` } : {}),
      },
      body: JSON.stringify({ email, companySlug, profile }),
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const body = ct.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const msg = typeof body === 'string' ? body : (body?.message || 'Invite falhou');
      throw new Error(`${res.status} ${msg}`);
    }
    return { ok: true, body };
  } finally {
    clearTimeout(t);
  }
}

async function usersRoutes(fastify, _options) {
  // Listar
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, perfil
           FROM users
           ORDER BY name, lastname`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar atendentes' });
    }
  });

  // Buscar por email
  fastify.get('/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, perfil
           FROM users
          WHERE email = $1`,
        [email]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar atendente' });
    }
  });

  // Criar (tenant + public + invite externo)
  fastify.post('/', async (req, reply) => {
    const { name, lastname, email, perfil, filas = [] } = req.body || {};
    if (!name || !lastname || !email || !perfil) {
      return reply.code(400).send({ error: 'name, lastname, perfil e email são obrigatórios' });
    }

    const filasToSave = perfil === 'atendente' ? (Array.isArray(filas) ? filas : []) : [];
    const lowerEmail = String(email).toLowerCase();

    try {
      const { subdomain } = req.tenant || {};
      if (!subdomain) return reply.code(400).send({ error: 'tenant não resolvido' });

      // 1) catálogo global -> company_id e slug
      const qTenant = await pool.query(
        `SELECT id AS company_id, slug
           FROM public.companies
          WHERE slug = $1`,
        [subdomain]
      );
      const tenant = qTenant.rows[0];
      if (!tenant) return reply.code(404).send({ error: 'tenant não encontrado no catálogo' });

      // 2) schema do tenant: upsert
      const tenantUser = await req.db.tx(async (client) => {
        const ins = await client.query(
          `INSERT INTO users (name, lastname, email, filas, perfil)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (email) DO UPDATE
             SET name = EXCLUDED.name,
                 lastname = EXCLUDED.lastname,
                 filas = EXCLUDED.filas,
                 perfil = EXCLUDED.perfil
           RETURNING id, name, lastname, email, status, filas, perfil`,
          [name, lastname, lowerEmail, filasToSave, perfil]
        );
        return ins.rows[0];
      });

      // 3) public.users: upsert por (company_id, email)
      const upPublic = await pool.query(
        `INSERT INTO public.users (company_id, email, name, lastname, profile)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, email) DO UPDATE
           SET name = COALESCE(EXCLUDED.name, public.users.name),
               lastname = COALESCE(EXCLUDED.lastname, public.users.lastname),
               profile = COALESCE(EXCLUDED.profile, public.users.profile),
               updated_at = NOW()
         RETURNING id`,
        [tenant.company_id, lowerEmail, name, lastname, perfil]
      );
      const publicUserId = upPublic.rows[0]?.id;

      // 4) dispara invite externo (email, companySlug, profile)
      let inviteSent = false;
      let inviteError = null;
      try {
        const r = await triggerInvite({ email: lowerEmail, companySlug: tenant.slug, profile: perfil });
        inviteSent = !!r.ok;
      } catch (e) {
        inviteError = e.message || String(e);
        req.log.error({ inviteError }, 'Falha ao disparar invite');
        // não falha a criação — só reporta
      }

      return reply.code(201).send({
        ...tenantUser,
        public_user_id: publicUserId,
        invite_sent: inviteSent,
        ...(inviteError ? { invite_error: inviteError } : {}),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar atendente' });
    }
  });

  // Atualizar
  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, perfil, filas } = req.body || {};
    if (!name || !lastname || !email || !perfil) {
      return reply.code(400).send({ error: 'Campos inválidos' });
    }

    const filasToSave = perfil === 'atendente' ? (Array.isArray(filas) ? filas : []) : [];

    try {
      const { rowCount } = await req.db.query(
        `UPDATE users
            SET name = $1, lastname = $2, email = $3, filas = $4, perfil = $5
          WHERE id = $6`,
        [name, lastname, email, filasToSave, perfil, id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      // mantém public.users sincronizado
      const { subdomain } = req.tenant || {};
      if (subdomain) {
        const qTenant = await pool.query(
          `SELECT id AS company_id
             FROM public.tenants
            WHERE subdomain = $1`,
          [subdomain]
        );
        const companyId = qTenant.rows[0]?.company_id;
        if (companyId) {
          await pool.query(
            `INSERT INTO public.users (company_id, email, name, lastname, profile)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (company_id, email) DO UPDATE
               SET name = COALESCE(EXCLUDED.name, public.users.name),
                   lastname = COALESCE(EXCLUDED.lastname, public.users.lastname),
                   profile = COALESCE(EXCLUDED.profile, public.users.profile),
                   updated_at = NOW()`,
            [companyId, String(email).toLowerCase(), name, lastname, perfil]
          );
        }
      }

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

  // Excluir — bloqueia se houver filas vinculadas
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const check = await req.db.query(`SELECT filas, email FROM users WHERE id = $1`, [id]);
      if (check.rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      const filas = check.rows[0]?.filas || [];
      if (Array.isArray(filas) && filas.length > 0) {
        return reply.code(409).send({ error: 'Desvincule as filas antes de excluir o usuário.' });
      }

      const { rowCount } = await req.db.query(`DELETE FROM users WHERE id = $1`, [id]);
      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      // opcional: refletir remoção em public.users (apenas se essa for sua regra)
      const { subdomain } = req.tenant || {};
      if (subdomain) {
        const t = await pool.query(`SELECT id AS company_id FROM public.companies WHERE slug=$1`, [subdomain]);
        const companyId = t.rows[0]?.company_id;
        const email = String(check.rows[0]?.email || '').toLowerCase();
        if (companyId && email) {
          await pool.query(`DELETE FROM public.users WHERE company_id=$1 AND email=$2`, [companyId, email]);
        }
      }

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao excluir atendente' });
    }
  });
}

export default usersRoutes;
