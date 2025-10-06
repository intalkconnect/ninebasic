// routes/queueRules.js
async function queueRulesRoutes(fastify) {
  // ---------------- Helpers ----------------
  function isPlainObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  function validateConditions(conditions) {
    if (!Array.isArray(conditions))
      return { ok: false, error: "conditions deve ser um array" };
    for (const c of conditions) {
      if (!isPlainObject(c))
        return { ok: false, error: "cada condition deve ser um objeto" };
      const { type, variable } = c;
      if (!type || !variable) {
        return {
          ok: false,
          error: 'cada condition precisa de "type" e "variable"',
        };
      }
      // Operadores suportados (use os que seu executor entende)
      const okTypes = new Set([
        "equals",
        "not_equals",
        "contains",
        "starts_with",
        "ends_with",
        "exists",
        "not_exists",
        "in",
        "not_in",
        "regex",
        "gt",
        "gte",
        "lt",
        "lte",
      ]);
      if (!okTypes.has(String(type).toLowerCase())) {
        return { ok: false, error: `type inválido: ${type}` };
      }
    }
    return { ok: true };
  }

  // ---------------- CRUD ----------------

  // 📄 Listar todas as regras (200 sempre; pode retornar lista vazia)
  fastify.get("/", async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
           FROM queue_rules
          ORDER BY queue_name ASC`
      );
      return reply.code(200).send({ data: rows });
    } catch {
      // sem logs no console
      return reply.code(500).send({ error: "Erro ao listar regras" });
    }
  });

  // 🔎 Obter uma regra por nome de fila
  // 200 quando encontrada; 204 (sem corpo) quando não encontrada
  fastify.get("/:queue_name", async (req, reply) => {
    const queueName = String(req.params?.queue_name || "").trim();
    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    try {
      const { rows } = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
           FROM queue_rules
          WHERE queue_name = $1
          LIMIT 1`,
        [queueName]
      );
      const row = rows[0];
      if (!row) return reply.code(204).send();
      return reply.code(200).send({ data: row });
    } catch {
      return reply.code(500).send({ error: "Erro ao obter regra" });
    }
  });

  // ➕ Criar regra (falha se já existir)
  fastify.post("/", async (req, reply) => {
    const { queue_name, enabled = true, conditions = [] } = req.body || {};
    const queueName = String(queue_name || "").trim();
    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    const v = validateConditions(conditions);
    if (!v.ok) return reply.code(400).send({ error: v.error });

    try {
      const { rows } = await req.db.query(
        `INSERT INTO queue_rules (queue_name, enabled, conditions)
       VALUES ($1, $2, $3::jsonb)
       RETURNING queue_name, enabled, conditions, created_at, updated_at`,
        [queueName, !!enabled, JSON.stringify(conditions)]
      );

      const data = { data: rows[0] };

      // 🔎 AUDIT (sucesso)
      await fastify.audit(req, {
        action: "queue.rules.create",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 201,
        requestBody: { enabled: !!enabled, conditions },
        responseBody: data,
      });

      return reply.code(201).send(data);
    } catch (err) {
      // conflito (já existe)
      if (err?.code === "23505") {
        const resp = { error: "Já existe regra para essa fila" };

        // 🔎 AUDIT (conflito)
        await fastify.audit(req, {
          action: "queue.rules.create.conflict",
          resourceType: "queue",
          resourceId: queueName,
          statusCode: 409,
          requestBody: { enabled: !!enabled, conditions },
          responseBody: resp,
        });

        return reply.code(409).send(resp);
      }

      const resp = { error: "Erro ao criar regra" };

      // 🔎 AUDIT (erro)
      await fastify.audit(req, {
        action: "queue.rules.create.error",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 500,
        requestBody: { enabled: !!enabled, conditions },
        responseBody: resp,
      });

      return reply.code(500).send(resp);
    }
  });

  // ✏️ Atualizar (upsert) regra da fila
  // 200 ao atualizar; 201 se precisou criar
  fastify.put("/:queue_name", async (req, reply) => {
    const queueName = String(req.params?.queue_name || "").trim();
    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    let { enabled, conditions } = req.body || {};
    if (typeof conditions !== "undefined") {
      const v = validateConditions(conditions);
      if (!v.ok) return reply.code(400).send({ error: v.error });
    }

    // SETs dinâmicos
    const sets = [];
    const vals = [queueName];
    let i = 1;

    if (typeof enabled !== "undefined") {
      sets.push(`enabled = $${++i}`);
      vals.push(!!enabled);
    }
    if (typeof conditions !== "undefined") {
      sets.push(`conditions = $${++i}::jsonb`);
      vals.push(JSON.stringify(conditions));
    }

    if (!sets.length) {
      return reply.code(400).send({ error: "Nada para atualizar" });
    }

    try {
      // snapshot "antes" (se existir)
      const prevRes = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
         FROM queue_rules WHERE queue_name = $1 LIMIT 1`,
        [queueName]
      );
      const beforeData = prevRes.rows[0] || null;

      // tenta atualizar
      const sqlUpd = `
      UPDATE queue_rules
         SET ${sets.join(", ")}, updated_at = now()
       WHERE queue_name = $1
       RETURNING queue_name, enabled, conditions, created_at, updated_at
    `;
      const rUpd = await req.db.query(sqlUpd, vals);

      if (rUpd.rows.length) {
        const data = { data: rUpd.rows[0] };

        // 🔎 AUDIT: update
        await fastify.audit(req, {
          action: "queue.rules.upsert.update",
          resourceType: "queue",
          resourceId: queueName,
          statusCode: 200,
          requestBody: req.body,
          beforeData,
          afterData: data.data,
          responseBody: data,
        });

        return reply.code(200).send(data);
      }

      // não existia -> cria (upsert por PUT)
      const enabledFinal = typeof enabled === "undefined" ? true : !!enabled;
      const condsFinal = typeof conditions === "undefined" ? [] : conditions;

      const { rows } = await req.db.query(
        `INSERT INTO queue_rules (queue_name, enabled, conditions)
       VALUES ($1, $2, $3::jsonb)
       RETURNING queue_name, enabled, conditions, created_at, updated_at`,
        [queueName, enabledFinal, JSON.stringify(condsFinal)]
      );
      const data = { data: rows[0] };

      // 🔎 AUDIT: create
      await fastify.audit(req, {
        action: "queue.rules.upsert.create",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 201,
        requestBody: req.body,
        afterData: data.data,
        responseBody: data,
      });

      return reply.code(201).send(data);
    } catch (err) {
      const resp = { error: "Erro ao salvar regra" };

      // 🔎 AUDIT: erro
      await fastify.audit(req, {
        action: "queue.rules.upsert.error",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 500,
        requestBody: req.body,
        responseBody: resp,
        extra: { error: String(err?.message || err) },
      });

      return reply.code(500).send(resp);
    }
  });

  // 🗑️ Excluir regra da fila
  // 200 quando exclui; 204 quando não existe
  fastify.delete("/:queue_name", async (req, reply) => {
    const queueName = String(req.params?.queue_name || "").trim();
    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    try {
      // snapshot antes (se existir)
      const prev = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
         FROM queue_rules WHERE queue_name = $1 LIMIT 1`,
        [queueName]
      );
      const beforeData = prev.rows[0] || null;

      const { rows } = await req.db.query(
        `DELETE FROM queue_rules
        WHERE queue_name = $1
        RETURNING queue_name`,
        [queueName]
      );

      if (!rows.length) {
        // 🔎 AUDIT: not found (nada para excluir)
        await fastify.audit(req, {
          action: "queue.rules.delete.notfound",
          resourceType: "queue",
          resourceId: queueName,
          statusCode: 204,
          beforeData, // provavelmente null
          responseBody: null,
        });
        return reply.code(204).send();
      }

      const body = { ok: true, queue_name: rows[0].queue_name };

      // 🔎 AUDIT: delete OK
      await fastify.audit(req, {
        action: "queue.rules.delete",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 200,
        beforeData, // como era antes de remover
        responseBody: body,
      });

      return reply.code(200).send(body);
    } catch (err) {
      const body = { error: "Erro ao excluir regra" };

      // 🔎 AUDIT: erro
      await fastify.audit(req, {
        action: "queue.rules.delete.error",
        resourceType: "queue",
        resourceId: queueName,
        statusCode: 500,
        responseBody: body,
        extra: { error: String(err?.message || err) },
      });

      return reply.code(500).send(body);
    }
  });
}

export default queueRulesRoutes;
