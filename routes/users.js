// routes/atendentes.js
import axios from 'axios';
import { pool } from '../services/db.js'; // pool global (public)

// ===== Config da API externa =====
// Invite: já existia
const AUTH_API_BASE =
  process.env.AUTH_API_BASE || 'https://srv-auth.dkdevs.com.br';
// Token opcional para ambas as chamadas
const AUTH_API_TOKEN = process.env.AUTH_API_TOKEN || '';

// Delete externo (novo): usa o serviço auth que você expõe em /api/users
const AUTH_API_BASE = (process.env.AUTH_API_BASE || 'https://srv-auth.dkdevs.com.br').replace(/\/+$/,'');
const AUTH_DELETE_URL = `${AUTH_API_BASE}/api/users`;

// ---------- helpers HTTP ----------
async function triggerInvite({ email, companySlug, profile }, log) {
  const headers = {
    'Content-Type': 'application/json',
    ...(AUTH_API_TOKEN ? { Authorization: `Bearer ${AUTH_API_TOKEN}` } : {}),
  };
  const payload = { email, companySlug, profile };

  log?.info({ payload, url: `${AUTH_API_TOKEN}/api/invite` }, '➡️ Chamando INVITE API');

  const { data, status } = await axios.post(`${AUTH_API_BASE}/api/invite`, payload, {
    headers,
    timeout: 10_000,
    validateStatus: () => true,
  });

  log?.info({ status, data }, '📩 Invite API respondeu');

  if (status < 200 || status >= 300) {
    const msg = (data && (data.message || data.error)) || `HTTP ${status}`;
    throw new Error(`Invite falhou: ${msg}`);
  }
  return data;
}

async function triggerExternalDelete({ email, companySlug }, log) {
  const headers = {
    'Content-Type': 'application/json',
    ...(INVITE_API_TOKEN ? { Authorization: `Bearer ${AUTH_API_TOKEN}` } : {}),
  };
  const payload = { email, companySlug };

  log?.info({ payload, url: `${AUTH_DELETE_URL}/api/users` }, '➡️ Chamando AUTH DELETE /api/users');

  const { data, status } = await axios.delete(AUTH_API_BASE, {
    headers,
    timeout: 10_000,
    validateStatus: () => true,
    data: payload, // body no DELETE
  });

  log?.info({ status, data }, '🗑️ AUTH DELETE respondeu');

  if (status < 200 || status >= 300) {
    const msg = (data && (data.message || data.error)) || `HTTP ${status}`;
    throw new Error(`Auth delete falhou: ${msg}`);
  }
  return data;
}

/** Detecta nomes de colunas existentes na <schema>.users do tenant */
async function detectUserColumns(req) {
  const q = `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
  `;
  const { rows } = await req.db.query(q);
  const cols = new Set(rows.map(r => r.column_name.toLowerCase()));

  const nameCol =
    (cols.has('name') && 'name') ||
    (cols.has('first_name') && 'first_name') ||
    (cols.has('nome') && 'nome') ||
    null;

  const lastCol =
    (cols.has('lastname') && 'lastname') ||
    (cols.has('last_name') && 'last_name') ||
    (cols.has('sobrenome') && 'sobrenome') ||
    null;

  const emailCol  = cols.has('email')  ? 'email'  : null;
  const filasCol  = cols.has('filas')  ? 'filas'  : null;
  const perfilCol =
    (cols.has('perfil') && 'perfil') ||
    (cols.has('profile') && 'profile') ||
    null;

  const statusCol = cols.has('status') ? 'status' : null;
  const idCol     = cols.has('id')     ? 'id'     : null;

  return { idCol, nameCol, lastCol, emailCol, filasCol, perfilCol, statusCol, all: cols };
}

function buildSelect(cols) {
  const fields = [];
  if (cols.idCol)     fields.push(`${cols.idCol} as id`);
  if (cols.nameCol)   fields.push(`${cols.nameCol} as name`);
  if (cols.lastCol)   fields.push(`${cols.lastCol} as lastname`);
  if (cols.emailCol)  fields.push(`${cols.emailCol} as email`);
  if (cols.statusCol) fields.push(`${cols.statusCol} as status`);
  if (cols.filasCol)  fields.push(`${cols.filasCol} as filas`);
  if (cols.perfilCol) fields.push(`${cols.perfilCol} as perfil`);
  if (!fields.length) fields.push('*');
  return `SELECT ${fields.join(', ')} FROM users`;
}

function buildUpsert(cols, data) {
  const insertCols = [];
  const values = [];
  const sets = [];
  let i = 1;

  if (cols.nameCol && data.name != null)       { insertCols.push(cols.nameCol);   values.push(data.name);     sets.push(`${cols.nameCol}=EXCLUDED.${cols.nameCol}`); }
  if (cols.lastCol && data.lastname != null)   { insertCols.push(cols.lastCol);   values.push(data.lastname); sets.push(`${cols.lastCol}=EXCLUDED.${cols.lastCol}`); }
  if (cols.emailCol && data.email != null)     { insertCols.push(cols.emailCol);  values.push(data.email); }
  if (cols.filasCol && data.filas != null)     { insertCols.push(cols.filasCol);  values.push(data.filas);    sets.push(`${cols.filasCol}=EXCLUDED.${cols.filasCol}`); }
  if (cols.perfilCol && data.perfil != null)   { insertCols.push(cols.perfilCol); values.push(data.perfil);   sets.push(`${cols.perfilCol}=EXCLUDED.${cols.perfilCol}`); }

  const placeholders = insertCols.map(() => `$${i++}`).join(', ');
  const conflictKey = cols.emailCol || 'email';

  const text = `
    INSERT INTO users (${insertCols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (${conflictKey}) DO UPDATE
      SET ${sets.join(', ')}
    RETURNING *
  `;
  return { text, values };
}

async function usersRoutes(fastify, _options) {
  // Listar
  fastify.get('/', async (req, reply) => {
    try {
      const cols = await detectUserColumns(req);
      req.log.info({ cols }, '🔎 colunas detectadas (GET /users)');
      const order = (cols.nameCol && cols.lastCol) ? ` ORDER BY ${cols.nameCol}, ${cols.lastCol}` : '';
      const sql = buildSelect(cols) + order;
      const { rows } = await req.db.query(sql);
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
      const cols = await detectUserColumns(req);
      req.log.info({ cols }, '🔎 colunas detectadas (GET /users/:email)');
      if (!cols.emailCol) return reply.code(500).send({ error: 'Tabela users não possui coluna "email"' });
      const sql = buildSelect(cols) + ` WHERE ${cols.emailCol} = $1`;
      const { rows } = await req.db.query(sql, [email]);
      if (rows.length === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar atendente' });
    }
  });

  // Criar (tenant + public + invite)
  fastify.post('/', async (req, reply) => {
    const { name, lastname, email, perfil, filas = [] } = req.body || {};
    if (!email || !perfil) return reply.code(400).send({ error: 'email e perfil são obrigatórios' });

    const lowerEmail = String(email).toLowerCase();
    const filasToSave = Array.isArray(filas) ? filas : [];

    try {
      const { subdomain } = req.tenant || {};
      if (!subdomain) return reply.code(400).send({ error: 'tenant não resolvido' });

      // 1) catálogo global: company_id e slug
      const qTenant = await pool.query(
        `SELECT id AS company_id, slug
           FROM public.companies
          WHERE slug = $1`,
        [subdomain]
      );
      const tenant = qTenant.rows[0];
      if (!tenant) return reply.code(404).send({ error: 'tenant não encontrado no catálogo' });

      // 2) UPSERT no schema do tenant
      const cols = await detectUserColumns(req);
      req.log.info({ cols }, '🧩 colunas detectadas (POST /users)');
      if (!cols.emailCol) return reply.code(500).send({ error: 'Tabela users do tenant não possui coluna "email"' });

      const up = buildUpsert(cols, {
        name: name ?? null,
        lastname: lastname ?? null,
        email: lowerEmail,
        filas: cols.filasCol ? filasToSave : null,
        perfil: perfil ?? null,
      });
      const ins = await req.db.query(up.text, up.values);
      const u = ins.rows[0] || {};
      const out = {
        id:       u[cols.idCol]     ?? u.id     ?? null,
        name:     u[cols.nameCol]   ?? u.name   ?? null,
        lastname: u[cols.lastCol]   ?? u.lastname ?? null,
        email:    u[cols.emailCol]  ?? u.email  ?? lowerEmail,
        status:   cols.statusCol ? (u[cols.statusCol] ?? u.status ?? null) : null,
        filas:    cols.filasCol ? (u[cols.filasCol] ?? u.filas ?? []) : [],
        perfil:   u[cols.perfilCol] ?? u.perfil ?? perfil,
      };

      // 3) public.users — company_id, email, profile
      await pool.query(
        `INSERT INTO public.users (company_id, email, profile)
         VALUES ($1,$2,$3)
         ON CONFLICT (company_id, email) DO UPDATE
           SET profile = COALESCE(EXCLUDED.profile, public.users.profile),
               updated_at = NOW()`,
        [tenant.company_id, lowerEmail, perfil]
      );

      // 4) Invite externo
      let invite_sent = false;
      let invite_error = null;
      try {
        await triggerInvite({ email: lowerEmail, companySlug: tenant.slug, profile: perfil }, fastify.log);
        invite_sent = true;
      } catch (e) {
        invite_error = e.response?.data?.message || e.message || 'Falha ao enviar invite';
        fastify.log.error({ invite_error, email: lowerEmail, companySlug: tenant.slug }, '❌ Invite falhou');
      }

      return reply.code(201).send({ ...out, invite_sent, ...(invite_error ? { invite_error } : {}) });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar atendente' });
    }
  });

  // Atualizar (sincroniza public.users: apenas profile)
  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, perfil, filas } = req.body || {};
    if (!email || !perfil) return reply.code(400).send({ error: 'email e perfil são obrigatórios' });

    try {
      const cols = await detectUserColumns(req);
      if (!cols.idCol)    return reply.code(500).send({ error: 'Tabela users não possui coluna "id"' });
      if (!cols.emailCol) return reply.code(500).send({ error: 'Tabela users não possui coluna "email"' });

      const sets = [];
      const values = [];
      let i = 1;

      if (cols.nameCol   && name != null)     { sets.push(`${cols.nameCol}=$${i++}`);   values.push(name); }
      if (cols.lastCol   && lastname != null) { sets.push(`${cols.lastCol}=$${i++}`);   values.push(lastname); }
      if (cols.emailCol  && email != null)    { sets.push(`${cols.emailCol}=$${i++}`);  values.push(String(email).toLowerCase()); }
      if (cols.perfilCol && perfil != null)   { sets.push(`${cols.perfilCol}=$${i++}`); values.push(perfil); }
      if (cols.filasCol  && Array.isArray(filas)) { sets.push(`${cols.filasCol}=$${i++}`); values.push(filas); }

      if (!sets.length) return reply.code(400).send({ error: 'Nada para atualizar' });

      const sql = `UPDATE users SET ${sets.join(', ')} WHERE ${cols.idCol} = $${i}`;
      values.push(id);
      const r = await req.db.query(sql, values);
      if (r.rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      // sincroniza profile em public.users
      const { subdomain } = req.tenant || {};
      if (subdomain) {
        const qTenant = await pool.query(
          `SELECT id AS company_id FROM public.companies WHERE slug = $1`,
          [subdomain]
        );
        const companyId = qTenant.rows[0]?.company_id;
        if (companyId) {
          await pool.query(
            `INSERT INTO public.users (company_id, email, profile)
             VALUES ($1,$2,$3)
             ON CONFLICT (company_id, email) DO UPDATE
               SET profile = COALESCE(EXCLUDED.profile, public.users.profile),
                   updated_at = NOW()`,
            [companyId, String(email).toLowerCase(), perfil]
          );
        }
      }

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

  // Excluir (tenant) + chamada externa para remover em public.users
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const cols = await detectUserColumns(req);
      if (!cols.idCol) return reply.code(500).send({ error: 'Tabela users não possui coluna "id"' });

      // 1) Buscar email e filas antes de excluir (email é necessário para a chamada externa)
      const selFields = [cols.emailCol ? `${cols.emailCol} AS email` : `'__noemail__' AS email`];
      if (cols.filasCol) selFields.push(`${cols.filasCol} AS filas`);

      const pre = await req.db.query(
        `SELECT ${selFields.join(', ')} FROM users WHERE ${cols.idCol} = $1`,
        [id]
      );
      if (pre.rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      const email = String(pre.rows[0].email || '').toLowerCase();
      const filas = cols.filasCol ? (pre.rows[0]?.filas || []) : [];

      if (cols.filasCol && Array.isArray(filas) && filas.length > 0) {
        return reply.code(409).send({ error: 'Desvincule as filas antes de excluir o usuário.' });
      }

      // 2) Exclui no tenant
      const del = await req.db.query(`DELETE FROM users WHERE ${cols.idCol} = $1`, [id]);
      if (del.rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      // 3) Chama o serviço externo para remover de public.users
      try {
        const companySlug = req.tenant?.subdomain;
        if (email && companySlug) {
          await triggerExternalDelete({ email, companySlug }, fastify.log);
        } else {
          fastify.log.warn({ email, companySlug }, '⚠️ Não foi possível chamar AUTH DELETE — dados insuficientes');
        }
      } catch (extErr) {
        fastify.log.error({ err: extErr?.message }, '❌ Falha ao remover em AUTH /api/users (public.users)');
        // Não falha a operação principal
      }

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao excluir atendente' });
    }
  });
}

export default usersRoutes;
