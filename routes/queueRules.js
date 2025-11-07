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
      // Operadores suportados
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

  // 📄 Listar todas as regras (pode filtrar por flow_id)
  fastify.get("/", async (req, reply) => {
    const flowId = req.query?.flow_id ?? null;
    try {
      let sql = `
        SELECT queue_name, flow_id, enabled, conditions, created_at, updated_at
          FROM queue_rules
      `;
      const params = [];
      if (flowId !== null && flowId !== undefined) {
        sql += ` WHERE flow_id IS NOT DISTINCT FROM $1`;
        params.push(flowId);
      }
      sql += ` ORDER BY queue_name ASC`;

      const { rows } = await req.db.query(sql, params);
      return reply.code(200).send({ data: rows });
    } catch {
      return reply.code(500).send({ error: "Erro ao listar regras" });
    }
  });

  // 🔎 Obter uma regra por nome de fila (+ flow_id opcional)
  fastify.get("/:queue_name", async (req, reply) => {
    const queueName = String(req.params?.queue_name || "").trim();
    const flowId = req.query?.flow_id ?? null;
    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    try {
      const params = [queueName];
      let where = `queue_name = $1`;
      if (flowId !== null && flowId !== undefined) {
        params.push(flowId);
        where += ` AND flow_id IS NOT DISTINCT FROM $${params.length}`;
      }

      const { rows } = await req.db.query(
        `SELECT queue_name, flow_id, enabled, conditions, created_at, updated_at
           FROM queue_rules
          WHERE ${where}
          LIMIT 1`,
        params
      );
      const row = rows[0];
      if (!row) return reply.code(204).send();
      return reply.code(200).send({ data: row });
    } catch {
      return reply.code(500).send({ error: "Erro ao obter regra" });
    }
  });

  // ➕ Criar regra (falha se já existir mesma queue + flow)
  fastify.post("/", async (req, reply) => {
    const {
      queue_name,
      flow_id = null,
      enabled = true,
      conditions = [],
    } = req.body || {};
    const queueName = String(queue_name || "").trim();
    const flowId = flow_id ?? null;

    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    const v = validateConditions(conditions);
    if (!v.ok) return reply.code(400).send({ error: v.error });

    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    try {
      const { rows } = await req.db.query(
        `INSERT INTO queue_rules (queue_name, flow_id, enabled, conditions)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING queue_name, flow_id, enabled, conditions, created_at, updated_at`,
        [queueName, flowId, !!enabled, JSON.stringify(conditions)]
      );

      const data = { data: rows[0] };

      // 🔎 AUDIT (sucesso)
      await fastify.audit(req, {
        action: "queue.rules.create",
        resourceType: "queue",
        resourceId: resourceId,
        statusCode: 201,
        requestBody: { flow_id: flowId, enabled: !!enabled, conditions },
        responseBody: data,
      });

      return reply.code(201).send(data);
    } catch (err) {
      if (err?.code === "23505") {
        const resp = { error: "Já existe regra para essa fila/flow" };

        await fastify.audit(req, {
          action: "queue.rules.create.conflict",
          resourceType: "queue",
          resourceId: resourceId,
          statusCode: 409,
          requestBody: { flow_id: flowId, enabled: !!enabled, conditions },
          responseBody: resp,
        });

        return reply.code(409).send(resp);
      }

      const resp = { error: "Erro ao criar regra" };

      await fastify.audit(req, {
        action: "queue.rules.create.error",
        resourceType: "queue",
        resourceId: resourceId,
        statusCode: 500,
        requestBody: { flow_id: flowId, enabled: !!enabled, conditions },
        responseBody: resp,
      });

      return reply.code(500).send(resp);
    }
  });

  // ✏️ Atualizar (upsert) regra da fila
  // 200 ao atualizar; 201 se precisou criar
  fastify.put("/:queue_name", async (req, reply) => {
    const queueName = String(req.params?.queue_name || "").trim();
    const flowId = req.query?.flow_id ?? req.body?.flow_id ?? null;

    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    let { enabled, conditions } = req.body || {};
    if (typeof conditions !== "undefined") {
      const v = validateConditions(conditions);
      if (!v.ok) return reply.code(400).send({ error: v.error });
    }

    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    // SETs dinâmicos
    const sets = [];
    const vals = [queueName, flowId];
    let i = vals.length;

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
        `SELECT queue_name, flow_id, enabled, conditions, created_at, updated_at
           FROM queue_rules
          WHERE queue_name = $1
            AND flow_id IS NOT DISTINCT FROM $2
          LIMIT 1`,
        [queueName, flowId]
      );
      const beforeData = prevRes.rows[0] || null;

      // tenta atualizar
      const sqlUpd = `
        UPDATE queue_rules
           SET ${sets.join(", ")}, updated_at = now()
         WHERE queue_name = $1
           AND flow_id IS NOT DISTINCT FROM $2
         RETURNING queue_name, flow_id, enabled, conditions, created_at, updated_at
      `;
      const rUpd = await req.db.query(sqlUpd, vals);

      if (rUpd.rows.length) {
        const data = { data: rUpd.rows[0] };

        await fastify.audit(req, {
          action: "queue.rules.upsert.update",
          resourceType: "queue",
          resourceId,
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
        `INSERT INTO queue_rules (queue_name, flow_id, enabled, conditions)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING queue_name, flow_id, enabled, conditions, created_at, updated_at`,
        [queueName, flowId, enabledFinal, JSON.stringify(condsFinal)]
      );
      const data = { data: rows[0] };

      await fastify.audit(req, {
        action: "queue.rules.upsert.create",
        resourceType: "queue",
        resourceId,
        statusCode: 201,
        requestBody: req.body,
        afterData: data.data,
        responseBody: data,
      });

      return reply.code(201).send(data);
    } catch (err) {
      const resp = { error: "Erro ao salvar regra" };

      await fastify.audit(req, {
        action: "queue.rules.upsert.error",
        resourceType: "queue",
        resourceId,
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
    const flowId = req.query?.flow_id ?? null;
    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    if (!queueName)
      return reply.code(400).send({ error: "queue_name é obrigatório" });

    try {
      // snapshot antes (se existir)
      const prev = await req.db.query(
        `SELECT queue_name, flow_id, enabled, conditions, created_at, updated_at
           FROM queue_rules
          WHERE queue_name = $1
            AND flow_id IS NOT DISTINCT FROM $2
          LIMIT 1`,
        [queueName, flowId]
      );
      const beforeData = prev.rows[0] || null;

      const { rows } = await req.db.query(
        `DELETE FROM queue_rules
          WHERE queue_name = $1
            AND flow_id IS NOT DISTINCT FROM $2
        RETURNING queue_name, flow_id`,
        [queueName, flowId]
      );

      if (!rows.length) {
        await fastify.audit(req, {
          action: "queue.rules.delete.notfound",
          resourceType: "queue",
          resourceId,
          statusCode: 204,
          beforeData,
          responseBody: null,
        });
        return reply.code(204).send();
      }

      const body = {
        ok: true,
        queue_name: rows[0].queue_name,
        flow_id: rows[0].flow_id,
      };

      await fastify.audit(req, {
        action: "queue.rules.delete",
        resourceType: "queue",
        resourceId,
        statusCode: 200,
        beforeData,
        responseBody: body,
      });

      return reply.code(200).send(body);
    } catch (err) {
      const body = { error: "Erro ao excluir regra" };

      await fastify.audit(req, {
        action: "queue.rules.delete.error",
        resourceType: "queue",
        resourceId,
        statusCode: 500,
        responseBody: body,
        extra: { error: String(err?.message || err) },
      });

      return reply.code(500).send(body);
    }
  });
}

export default queueRulesRoutes;
