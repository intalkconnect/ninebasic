// routes/atendentes.js
import axios from "axios";
import { pool } from "../services/db.js"; // pool global (public)

// ===== Config da API externa =====
const AUTH_API_TOKEN = process.env.AUTH_API_TOKEN || "";

const AUTH_API_BASE = (
  process.env.AUTH_API_BASE || "https://srv-auth.dkdevs.com.br"
).replace(/\/+$/, "");
const AUTH_DELETE_URL = `${AUTH_API_BASE}/api/users`;
const INVITE_API_URL = `${AUTH_API_BASE}/api/invite`;

// ---------- helpers HTTP ----------
async function triggerInvite({ email, companySlug, profile }, log) {
  const headers = {
    "Content-Type": "application/json",
    ...(AUTH_API_TOKEN ? { Authorization: `Bearer ${AUTH_API_TOKEN}` } : {}),
  };
  const payload = { email, companySlug, profile };

  log?.info({ payload, url: INVITE_API_URL }, "➡️ Chamando INVITE API");

  const { data, status } = await axios.post(INVITE_API_URL, payload, {
    headers,
    timeout: 10_000,
    validateStatus: () => true,
  });

  log?.info({ status, data }, "📩 Invite API respondeu");

  if (status < 200 || status >= 300) {
    const msg = (data && (data.message || data.error)) || `HTTP ${status}`;
    throw new Error(`Invite falhou: ${msg}`);
  }
  return data;
}

async function triggerExternalDelete({ email, companySlug }, log) {
  const headers = {
    "Content-Type": "application/json",
    ...(AUTH_API_TOKEN ? { Authorization: `Bearer ${AUTH_API_TOKEN}` } : {}),
  };
  const payload = { email, companySlug };

  log?.info(
    { payload, url: AUTH_DELETE_URL },
    "➡️ Chamando AUTH DELETE /api/users"
  );

  const { data, status } = await axios.delete(AUTH_DELETE_URL, {
    headers,
    timeout: 10_000,
    validateStatus: () => true,
    data: payload,
  });

  log?.info({ status, data }, "🗑️ AUTH DELETE respondeu");

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
  const cols = new Set(rows.map((r) => r.column_name.toLowerCase()));

  const nameCol =
    (cols.has("name") && "name") ||
    (cols.has("first_name") && "first_name") ||
    (cols.has("nome") && "nome") ||
    null;

  const lastCol =
    (cols.has("lastname") && "lastname") ||
    (cols.has("last_name") && "last_name") ||
    (cols.has("sobrenome") && "sobrenome") ||
    null;

  const emailCol = cols.has("email") ? "email" : null;
  const filasCol = cols.has("filas") ? "filas" : null;
  const perfilCol =
    (cols.has("perfil") && "perfil") ||
    (cols.has("profile") && "profile") ||
    null;

  const statusCol = cols.has("status") ? "status" : null;
  const idCol = cols.has("id") ? "id" : null;
  const flowIdCol = cols.has("flow_id") ? "flow_id" : null;

  return {
    idCol,
    nameCol,
    lastCol,
    emailCol,
    filasCol,
    perfilCol,
    statusCol,
    flowIdCol,
    all: cols,
  };
}

function buildSelect(cols) {
  const fields = [];
  if (cols.idCol) fields.push(`${cols.idCol} as id`);
  if (cols.nameCol) fields.push(`${cols.nameCol} as name`);
  if (cols.lastCol) fields.push(`${cols.lastCol} as lastname`);
  if (cols.emailCol) fields.push(`${cols.emailCol} as email`);
  if (cols.statusCol) fields.push(`${cols.statusCol} as status`);
  if (cols.filasCol) fields.push(`${cols.filasCol} as filas`);
  if (cols.perfilCol) fields.push(`${cols.perfilCol} as perfil`);
  if (cols.flowIdCol) fields.push(`${cols.flowIdCol} as flow_id`);
  if (!fields.length) fields.push("*");
  return `SELECT ${fields.join(", ")} FROM users`;
}

function buildUpsert(cols, data) {
  const insertCols = [];
  const values = [];
  const sets = [];

  // a ordem dos placeholders é a mesma dos insertCols
  if (cols.nameCol && data.name != null) {
    insertCols.push(cols.nameCol);
    values.push(data.name);
    sets.push(`${cols.nameCol}=EXCLUDED.${cols.nameCol}`);
  }
  if (cols.lastCol && data.lastname != null) {
    insertCols.push(cols.lastCol);
    values.push(data.lastname);
    sets.push(`${cols.lastCol}=EXCLUDED.${cols.lastCol}`);
  }
  if (cols.emailCol && data.email != null) {
    insertCols.push(cols.emailCol);
    values.push(data.email);
  }
  if (cols.filasCol && data.filas != null) {
    insertCols.push(cols.filasCol);
    values.push(data.filas);
    sets.push(`${cols.filasCol}=EXCLUDED.${cols.filasCol}`);
  }
  if (cols.perfilCol && data.perfil != null) {
    insertCols.push(cols.perfilCol);
    values.push(data.perfil);
    sets.push(`${cols.perfilCol}=EXCLUDED.${cols.perfilCol}`);
  }
  if (cols.flowIdCol && data.flow_id !== undefined) {
    insertCols.push(cols.flowIdCol);
    values.push(data.flow_id);
    sets.push(`${cols.flowIdCol}=EXCLUDED.${cols.flowIdCol}`);
  }

  let i = 1;
  const placeholders = insertCols.map(() => `$${i++}`).join(", ");
  const conflictKey = cols.emailCol || "email";

  const text = `
    INSERT INTO users (${insertCols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (${conflictKey}) DO UPDATE
      SET ${sets.join(", ")}
    RETURNING *
  `;
  return { text, values };
}

async function usersRoutes(fastify, _options) {
  // ========================================================================
  // GET /users  → lista (opcionalmente filtrado por flow_id)
  // ========================================================================
  fastify.get("/", async (req, reply) => {
    const flowId = req.query?.flow_id || null;

    try {
      const cols = await detectUserColumns(req);
      req.log.info({ cols, flowId }, "🔎 colunas detectadas (GET /users)");

      let sql = buildSelect(cols);
      const params = [];

      if (flowId && cols.flowIdCol) {
        sql += ` WHERE ${cols.flowIdCol} = $1`;
        params.push(flowId);
      }

      const order =
        cols.nameCol && cols.lastCol
          ? ` ORDER BY ${cols.nameCol}, ${cols.lastCol}`
          : "";
      sql += order;

      const { rows } = await req.db.query(sql, params);
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Erro ao listar atendentes" });
    }
  });

  // ========================================================================
  // GET /users/id/:id  → busca por ID (opcionalmente checando flow_id)
  // ========================================================================
  fastify.get("/id/:id", async (req, reply) => {
    const { id } = req.params;
    const flowId = req.query?.flow_id || null;

    try {
      const cols = await detectUserColumns(req);
      req.log.info(
        { cols, id, flowId },
        "🔎 colunas detectadas (GET /users/id/:id)"
      );

      if (!cols.idCol) {
        return reply
          .code(500)
          .send({ error: "Tabela users não possui coluna de ID" });
      }

      let sql = buildSelect(cols) + ` WHERE ${cols.idCol} = $1`;
      const params = [String(id)];

      if (flowId && cols.flowIdCol) {
        sql += ` AND ${cols.flowIdCol} = $2`;
        params.push(flowId);
      }

      const { rows } = await req.db.query(sql, params);
      if (rows.length === 0)
        return reply.code(404).send({ error: "Atendente não encontrado" });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Erro ao buscar atendente por ID" });
    }
  });

  // ========================================================================
  // GET /users/:email  → busca por email (opcionalmente filtrado por flow_id)
  // ========================================================================
  fastify.get("/:email", async (req, reply) => {
    const { email } = req.params;
    const flowId = req.query?.flow_id || null;

    try {
      const cols = await detectUserColumns(req);
      req.log.info(
        { cols, email, flowId },
        "🔎 colunas detectadas (GET /users/:email)"
      );

      if (!cols.emailCol)
        return reply
          .code(500)
          .send({ error: 'Tabela users não possui coluna "email"' });

      let sql = buildSelect(cols) + ` WHERE ${cols.emailCol} = $1`;
      const params = [email];

      if (flowId && cols.flowIdCol) {
        sql += ` AND ${cols.flowIdCol} = $2`;
        params.push(flowId);
      }

      const { rows } = await req.db.query(sql, params);
      if (rows.length === 0)
        return reply.code(404).send({ error: "Atendente não encontrado" });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Erro ao buscar atendente" });
    }
  });

  // ========================================================================
  // POST /users  → criar (tenant + public + invite) com flow_id
  // ========================================================================
  fastify.post("/", async (req, reply) => {
    const { name, lastname, email, perfil, filas = [], flow_id } =
      req.body || {};
    if (!email || !perfil) {
      const body400 = { error: "email e perfil são obrigatórios" };
      await fastify.audit(req, {
        action: "user.create.invalid_payload",
        resourceType: "user",
        resourceId: String(email || ""),
        statusCode: 400,
        requestBody: {
          name,
          lastname,
          email,
          perfil,
          filas_count: Array.isArray(filas) ? filas.length : 0,
          flow_id,
        },
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    const lowerEmail = String(email).toLowerCase();
    const filasToSave = Array.isArray(filas) ? filas : [];
    const flowId = flow_id || null;

    try {
      const { subdomain } = req.tenant || {};
      if (!subdomain) {
        const body400 = { error: "tenant não resolvido" };
        await fastify.audit(req, {
          action: "user.create.tenant_unresolved",
          resourceType: "user",
          resourceId: lowerEmail,
          statusCode: 400,
          responseBody: body400,
        });
        return reply.code(400).send(body400);
      }

      // 1) catálogo global
      const qTenant = await pool.query(
        `SELECT id AS company_id, slug
           FROM public.companies
          WHERE slug = $1`,
        [subdomain]
      );
      const tenant = qTenant.rows[0];
      if (!tenant) {
        const body404 = { error: "tenant não encontrado no catálogo" };
        await fastify.audit(req, {
          action: "user.create.tenant_not_found",
          resourceType: "user",
          resourceId: lowerEmail,
          statusCode: 404,
          responseBody: body404,
          extra: { subdomain },
        });
        return reply.code(404).send(body404);
      }

      // 2) UPSERT no schema do tenant
      const cols = await detectUserColumns(req);
      req.log.info({ cols, flowId }, "🧩 colunas detectadas (POST /users)");
      if (!cols.emailCol) {
        const body500 = {
          error: 'Tabela users do tenant não possui coluna "email"',
        };
        await fastify.audit(req, {
          action: "user.create.schema_invalid",
          resourceType: "user",
          resourceId: lowerEmail,
          statusCode: 500,
          responseBody: body500,
          extra: { subdomain, cols },
        });
        return reply.code(500).send(body500);
      }

      const up = buildUpsert(cols, {
        name: name ?? null,
        lastname: lastname ?? null,
        email: lowerEmail,
        filas: cols.filasCol ? filasToSave : null,
        perfil: perfil ?? null,
        flow_id: flowId,
      });
      const ins = await req.db.query(up.text, up.values);
      const u = ins.rows[0] || {};

      const out = {
        id: u[cols.idCol] ?? u.id ?? null,
        name: u[cols.nameCol] ?? u.name ?? null,
        lastname: u[cols.lastCol] ?? u.lastname ?? null,
        email: u[cols.emailCol] ?? u.email ?? lowerEmail,
        status: cols.statusCol ? u[cols.statusCol] ?? u.status ?? null : null,
        filas: cols.filasCol ? u[cols.filasCol] ?? u.filas ?? [] : [],
        perfil: u[cols.perfilCol] ?? u.perfil ?? perfil,
        flow_id: cols.flowIdCol ? u[cols.flowIdCol] ?? flowId : flowId,
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
        await triggerInvite(
          { email: lowerEmail, companySlug: tenant.slug, profile: perfil },
          fastify.log
        );
        invite_sent = true;
      } catch (e) {
        invite_error =
          e?.response?.data?.message || e?.message || "Falha ao enviar invite";
        fastify.log.error(
          { invite_error, email: lowerEmail, companySlug: tenant.slug },
          "❌ Invite falhou"
        );
      }

      // ✅ AUDIT SUCESSO
      await fastify.audit(req, {
        action: "user.create",
        resourceType: "user",
        resourceId: out.id || lowerEmail,
        statusCode: 201,
        requestBody: {
          name,
          lastname,
          email: lowerEmail,
          perfil,
          filas_count: filasToSave.length,
          flow_id: flowId,
        },
        afterData: out,
        extra: {
          tenant: {
            subdomain,
            company_id: tenant.company_id,
            slug: tenant.slug,
          },
          invite_sent,
          ...(invite_error ? { invite_error } : {}),
        },
      });

      return reply
        .code(201)
        .send({
          ...out,
          invite_sent,
          ...(invite_error ? { invite_error } : {}),
        });
    } catch (err) {
      fastify.log.error(err);
      await fastify.audit(req, {
        action: "user.create.error",
        resourceType: "user",
        resourceId: String(email || ""),
        statusCode: 500,
        responseBody: { error: "Erro ao criar atendente" },
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send({ error: "Erro ao criar atendente" });
    }
  });

  // ========================================================================
  // PUT /users/:id  → atualizar (incluindo flow_id opcional)
  // ========================================================================
  fastify.put("/:id", async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, perfil, filas, flow_id } = req.body || {};

    if (!email || !perfil) {
      const body400 = { error: "email e perfil são obrigatórios" };
      await fastify.audit(req, {
        action: "user.update.invalid_payload",
        resourceType: "user",
        resourceId: id,
        statusCode: 400,
        requestBody: {
          name,
          lastname,
          email,
          perfil,
          filas_count: Array.isArray(filas) ? filas.length : 0,
          flow_id,
        },
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const cols = await detectUserColumns(req);
      if (!cols.idCol) {
        const body500 = { error: 'Tabela users não possui coluna "id"' };
        await fastify.audit(req, {
          action: "user.update.schema_invalid",
          resourceType: "user",
          resourceId: id,
          statusCode: 500,
          responseBody: body500,
        });
        return reply.code(500).send(body500);
      }
      if (!cols.emailCol) {
        const body500 = { error: 'Tabela users não possui coluna "email"' };
        await fastify.audit(req, {
          action: "user.update.schema_invalid",
          resourceType: "user",
          resourceId: id,
          statusCode: 500,
          responseBody: body500,
        });
        return reply.code(500).send(body500);
      }

      // snapshot "antes"
      const rBefore = await req.db.query(
        `SELECT * FROM users WHERE ${cols.idCol} = $1 LIMIT 1`,
        [id]
      );
      const before = rBefore.rows?.[0] || null;
      if (!before) {
        const body404 = { error: "Atendente não encontrado" };
        await fastify.audit(req, {
          action: "user.update.not_found",
          resourceType: "user",
          resourceId: id,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const sets = [];
      const values = [];
      let i = 1;

      if (cols.nameCol && name != null) {
        sets.push(`${cols.nameCol}=$${i++}`);
        values.push(name);
      }
      if (cols.lastCol && lastname != null) {
        sets.push(`${cols.lastCol}=$${i++}`);
        values.push(lastname);
      }
      if (cols.emailCol && email != null) {
        sets.push(`${cols.emailCol}=$${i++}`);
        values.push(String(email).toLowerCase());
      }
      if (cols.perfilCol && perfil != null) {
        sets.push(`${cols.perfilCol}=$${i++}`);
        values.push(perfil);
      }
      if (cols.filasCol && Array.isArray(filas)) {
        sets.push(`${cols.filasCol}=$${i++}`);
        values.push(filas);
      }
      if (cols.flowIdCol && flow_id !== undefined) {
        sets.push(`${cols.flowIdCol}=$${i++}`);
        values.push(flow_id);
      }

      if (!sets.length) {
        const body400 = { error: "Nada para atualizar" };
        await fastify.audit(req, {
          action: "user.update.noop",
          resourceType: "user",
          resourceId: id,
          statusCode: 400,
          requestBody: req.body,
          responseBody: body400,
        });
        return reply.code(400).send(body400);
      }

      const sql = `UPDATE users SET ${sets.join(", ")} WHERE ${
        cols.idCol
      } = $${i}`;
      values.push(id);
      const r = await req.db.query(sql, values);

      if (r.rowCount === 0) {
        const body404 = { error: "Atendente não encontrado" };
        await fastify.audit(req, {
          action: "user.update.not_found",
          resourceType: "user",
          resourceId: id,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // sincroniza profile em public.users
      let syncInfo = null;
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
          syncInfo = { company_id: companyId, subdomain };
        }
      }

      const after = {
        id,
        ...(name != null ? { name } : {}),
        ...(lastname != null ? { lastname } : {}),
        ...(email != null ? { email: String(email).toLowerCase() } : {}),
        ...(perfil != null ? { perfil } : {}),
        ...(Array.isArray(filas) ? { filas } : {}),
        ...(flow_id !== undefined ? { flow_id } : {}),
      };

      await fastify.audit(req, {
        action: "user.update",
        resourceType: "user",
        resourceId: id,
        statusCode: 200,
        requestBody: req.body,
        beforeData: before,
        afterData: after,
        extra: syncInfo || undefined,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      await fastify.audit(req, {
        action: "user.update.error",
        resourceType: "user",
        resourceId: id,
        statusCode: 500,
        responseBody: { error: "Erro ao atualizar atendente" },
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send({ error: "Erro ao atualizar atendente" });
    }
  });

  // ========================================================================
  // DELETE /users/:id  → excluir (opcionalmente checando flow_id)
  // ========================================================================
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const flowId = req.query?.flow_id || null;

    try {
      const cols = await detectUserColumns(req);
      if (!cols.idCol) {
        const body500 = { error: 'Tabela users não possui coluna "id"' };
        await fastify.audit(req, {
          action: "user.delete.schema_invalid",
          resourceType: "user",
          resourceId: id,
          statusCode: 500,
          responseBody: body500,
        });
        return reply.code(500).send(body500);
      }

      // 1) snapshot antes (email, filas, flow_id)
      const selFields = [
        cols.emailCol ? `${cols.emailCol} AS email` : `'__noemail__' AS email`,
      ];
      if (cols.filasCol) selFields.push(`${cols.filasCol} AS filas`);
      if (cols.flowIdCol) selFields.push(`${cols.flowIdCol} AS flow_id`);

      let where = `${cols.idCol} = $1`;
      const paramsSel = [id];

      if (flowId && cols.flowIdCol) {
        where += ` AND ${cols.flowIdCol} = $2`;
        paramsSel.push(flowId);
      }

      const pre = await req.db.query(
        `SELECT ${selFields.join(", ")} FROM users WHERE ${where}`,
        paramsSel
      );
      if (pre.rowCount === 0) {
        const body404 = { error: "Atendente não encontrado" };
        await fastify.audit(req, {
          action: "user.delete.not_found",
          resourceType: "user",
          resourceId: id,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const before = pre.rows[0];
      const email = String(before.email || "").toLowerCase();
      const filas = cols.filasCol ? before?.filas || [] : [];

      if (cols.filasCol && Array.isArray(filas) && filas.length > 0) {
        const body409 = {
          error: "Desvincule as filas antes de excluir o usuário.",
        };
        await fastify.audit(req, {
          action: "user.delete.conflict_has_queues",
          resourceType: "user",
          resourceId: id,
          statusCode: 409,
          beforeData: before,
          responseBody: body409,
        });
        return reply.code(409).send(body409);
      }

      // 2) exclui no tenant
      let whereDel = `${cols.idCol} = $1`;
      const paramsDel = [id];
      if (flowId && cols.flowIdCol) {
        whereDel += ` AND ${cols.flowIdCol} = $2`;
        paramsDel.push(flowId);
      }

      const del = await req.db.query(
        `DELETE FROM users WHERE ${whereDel}`,
        paramsDel
      );
      if (del.rowCount === 0) {
        const body404 = { error: "Atendente não encontrado" };
        await fastify.audit(req, {
          action: "user.delete.not_found_after_check",
          resourceType: "user",
          resourceId: id,
          statusCode: 404,
          beforeData: before,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // 3) tenta remover no AUTH (public.users)
      let external = { attempted: false, ok: false, message: null };
      try {
        const companySlug = req.tenant?.subdomain;
        if (email && companySlug) {
          external.attempted = true;
          await triggerExternalDelete({ email, companySlug }, fastify.log);
          external.ok = true;
        } else {
          external.message =
            "Dados insuficientes para AUTH DELETE (email/companySlug)";
          fastify.log.warn(
            { email, companySlug },
            "⚠️ Não foi possível chamar AUTH DELETE — dados insuficientes"
          );
        }
      } catch (extErr) {
        external.message = String(extErr?.message || extErr);
        fastify.log.error(
          { err: external.message },
          "❌ Falha ao remover em AUTH /api/users (public.users)"
        );
        // não bloqueia a exclusão local
      }

      const body200 = { success: true };
      await fastify.audit(req, {
        action: "user.delete",
        resourceType: "user",
        resourceId: id,
        statusCode: 200,
        beforeData: before,
        responseBody: body200,
        extra: {
          email,
          had_queues_field: !!cols.filasCol,
          external_auth_delete: external,
        },
      });

      return reply.send(body200);
    } catch (err) {
      fastify.log.error(err);
      const body500 = { error: "Erro ao excluir atendente" };
      await fastify.audit(req, {
        action: "user.delete.error",
        resourceType: "user",
        resourceId: id,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });
}

export default usersRoutes;
