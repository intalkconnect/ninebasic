// routes/quickReplies.js

// Detecta colunas dinamicamente em quick_replies (incluindo flow_id, se existir)
async function detectQuickReplyColumns(req) {
  const q = `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'quick_replies'
  `;
  const { rows } = await req.db.query(q);
  const cols = new Set(rows.map((r) => r.column_name.toLowerCase()));

  const idCol = cols.has("id") ? "id" : null;
  const titleCol = cols.has("title") ? "title" : null;
  const contentCol = cols.has("content") ? "content" : null;
  const flowIdCol = cols.has("flow_id") ? "flow_id" : null;

  return {
    idCol,
    titleCol,
    contentCol,
    flowIdCol,
    all: cols,
  };
}

function buildSelect(cols) {
  const fields = [];
  if (cols.idCol) fields.push(`${cols.idCol} AS id`);
  if (cols.titleCol) fields.push(`${cols.titleCol} AS title`);
  if (cols.contentCol) fields.push(`${cols.contentCol} AS content`);
  if (cols.flowIdCol) fields.push(`${cols.flowIdCol} AS flow_id`);
  if (!fields.length) fields.push("*");
  return `SELECT ${fields.join(", ")} FROM quick_replies`;
}

export default async function quickRepliesRoutes(fastify) {
  // ➕ Criar nova resposta rápida (suporta flow_id)
  fastify.post("/", async (req, reply) => {
    const { title, content, flow_id } = req.body || {};
    const flowIdFromQuery = req.query?.flow_id ?? null;
    const flowId = flow_id ?? flowIdFromQuery ?? null;

    if (!title || !content) {
      const body400 = { error: "title e content são obrigatórios" };
      await fastify.audit(req, {
        action: "quick_reply.create.invalid",
        resourceType: "quick_reply",
        statusCode: 400,
        requestBody: req.body,
        responseBody: body400,
        extra: { flow_id: flowId },
      });
      return reply.code(400).send(body400);
    }

    try {
      const cols = await detectQuickReplyColumns(req);
      fastify.log.info({ cols, flowId }, "🧩 colunas quick_replies (POST)");

      if (!cols.titleCol || !cols.contentCol) {
        const body500 = {
          error:
            "Tabela quick_replies não possui colunas obrigatórias (title/content).",
        };
        await fastify.audit(req, {
          action: "quick_reply.create.schema_invalid",
          resourceType: "quick_reply",
          statusCode: 500,
          requestBody: req.body,
          responseBody: body500,
          extra: { cols },
        });
        return reply.code(500).send(body500);
      }

      const insertCols = [];
      const values = [];
      let i = 1;

      insertCols.push(cols.titleCol);
      values.push(title);

      insertCols.push(cols.contentCol);
      values.push(content);

      if (cols.flowIdCol && flowId != null) {
        insertCols.push(cols.flowIdCol);
        values.push(flowId);
      }

      const placeholders = insertCols.map(() => `$${i++}`).join(", ");

      const { rows } = await req.db.query(
        `INSERT INTO quick_replies (${insertCols.join(", ")})
         VALUES (${placeholders})
         RETURNING *`,
        values
      );

      const created = rows[0];

      const out = {
        id: created[cols.idCol] ?? created.id,
        title: created[cols.titleCol] ?? created.title,
        content: created[cols.contentCol] ?? created.content,
        flow_id: cols.flowIdCol ? created[cols.flowIdCol] ?? flowId : flowId,
      };

      await fastify.audit(req, {
        action: "quick_reply.create",
        resourceType: "quick_reply",
        resourceId: String(out.id),
        statusCode: 201,
        requestBody: { title, content, flow_id: flowId },
        responseBody: out,
        afterData: out,
      });

      return reply.code(201).send(out);
    } catch (err) {
      fastify.log.error(err, "POST /quick-replies");

      if (err?.code === "23505") {
        // unique violation (caso haja constraint)
        const body409 = {
          error: "Já existe uma resposta rápida com esse título.",
        };
        await fastify.audit(req, {
          action: "quick_reply.create.conflict",
          resourceType: "quick_reply",
          statusCode: 409,
          requestBody: req.body,
          responseBody: body409,
          extra: { pgcode: err.code, detail: err.detail || null },
        });
        return reply.code(409).send(body409);
      }

      const body500 = { error: "Erro ao criar resposta rápida" };
      await fastify.audit(req, {
        action: "quick_reply.create.error",
        resourceType: "quick_reply",
        statusCode: 500,
        requestBody: req.body,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });

  // 📄 Listar respostas rápidas (opcionalmente por flow_id)
  fastify.get("/", async (req, reply) => {
    const flowId = req.query?.flow_id ?? null;

    try {
      const cols = await detectQuickReplyColumns(req);
      fastify.log.info({ cols, flowId }, "🧩 colunas quick_replies (GET)");

      let sql = buildSelect(cols);
      const params = [];

      if (flowId && cols.flowIdCol) {
        sql += ` WHERE ${cols.flowIdCol} = $1`;
        params.push(flowId);
      }

      // ordena por título se possível
      if (cols.titleCol) {
        sql += ` ORDER BY ${cols.titleCol}`;
      } else {
        sql += ` ORDER BY 1`;
      }

      const { rows } = await req.db.query(sql, params);
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err, "GET /quick-replies");
      return reply
        .code(500)
        .send({ error: "Erro ao buscar respostas rápidas" });
    }
  });

  // ✏️ Atualizar uma resposta rápida (title/content) com checagem opcional de flow_id
  fastify.put("/:id", async (req, reply) => {
    const { id } = req.params;
    const { title, content } = req.body || {};
    const flowId = req.query?.flow_id ?? null;

    if (!title || !content) {
      const body400 = { error: "title e content são obrigatórios" };
      await fastify.audit(req, {
        action: "quick_reply.update.invalid",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 400,
        requestBody: req.body,
        responseBody: body400,
        extra: { flow_id: flowId },
      });
      return reply.code(400).send(body400);
    }

    try {
      const cols = await detectQuickReplyColumns(req);
      fastify.log.info({ cols, flowId, id }, "🧩 colunas quick_replies (PUT)");

      if (!cols.idCol || !cols.titleCol || !cols.contentCol) {
        const body500 = {
          error:
            "Tabela quick_replies não possui colunas obrigatórias (id/title/content).",
        };
        await fastify.audit(req, {
          action: "quick_reply.update.schema_invalid",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 500,
          responseBody: body500,
          extra: { cols },
        });
        return reply.code(500).send(body500);
      }

      // snapshot antes (para audit)
      let whereSel = `${cols.idCol} = $1`;
      const paramsSel = [id];

      if (flowId && cols.flowIdCol) {
        whereSel += ` AND ${cols.flowIdCol} = $2`;
        paramsSel.push(flowId);
      }

      const beforeQuery = await req.db.query(
        `SELECT * FROM quick_replies WHERE ${whereSel} LIMIT 1`,
        paramsSel
      );
      const before = beforeQuery.rows?.[0] || null;

      if (!before) {
        const body404 = { error: "Resposta não encontrada" };
        await fastify.audit(req, {
          action: "quick_reply.update.not_found",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const sets = [];
      const values = [];
      let i = 1;

      sets.push(`${cols.titleCol} = $${i++}`);
      values.push(title);

      sets.push(`${cols.contentCol} = $${i++}`);
      values.push(content);

      let where = `${cols.idCol} = $${i++}`;
      values.push(id);

      if (flowId && cols.flowIdCol) {
        where += ` AND ${cols.flowIdCol} = $${i++}`;
        values.push(flowId);
      }

      const sql = `UPDATE quick_replies SET ${sets.join(", ")} WHERE ${where} RETURNING *`;
      const { rows } = await req.db.query(sql, values);

      if (!rows.length) {
        const body404 = { error: "Resposta não encontrada" };
        await fastify.audit(req, {
          action: "quick_reply.update.not_found_after_check",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 404,
          responseBody: body404,
          beforeData: before,
        });
        return reply.code(404).send(body404);
      }

      const updated = rows[0];
      const out = {
        id: updated[cols.idCol] ?? updated.id,
        title: updated[cols.titleCol] ?? updated.title,
        content: updated[cols.contentCol] ?? updated.content,
        flow_id: cols.flowIdCol
          ? updated[cols.flowIdCol] ?? before[cols.flowIdCol] ?? null
          : null,
      };

      await fastify.audit(req, {
        action: "quick_reply.update",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 200,
        requestBody: req.body,
        beforeData: before,
        afterData: out,
        responseBody: out,
        extra: { flow_id: flowId },
      });

      return reply.send(out);
    } catch (err) {
      fastify.log.error(err, "PUT /quick-replies/:id");

      if (err?.code === "23505") {
        const body409 = {
          error: "Já existe uma resposta rápida com esse título.",
        };
        await fastify.audit(req, {
          action: "quick_reply.update.conflict",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 409,
          requestBody: req.body,
          responseBody: body409,
          extra: { pgcode: err.code, detail: err.detail || null },
        });
        return reply.code(409).send(body409);
      }

      const body500 = { error: "Erro ao atualizar resposta" };
      await fastify.audit(req, {
        action: "quick_reply.update.error",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 500,
        requestBody: req.body,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });

  // 🗑️ Remover uma resposta rápida (opcionalmente checando flow_id)
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const flowId = req.query?.flow_id ?? null;

    try {
      const cols = await detectQuickReplyColumns(req);
      fastify.log.info({ cols, flowId, id }, "🧩 colunas quick_replies (DEL)");

      if (!cols.idCol) {
        const body500 = { error: "Tabela quick_replies não possui coluna id." };
        await fastify.audit(req, {
          action: "quick_reply.delete.schema_invalid",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 500,
          responseBody: body500,
          extra: { cols },
        });
        return reply.code(500).send(body500);
      }

      let where = `${cols.idCol} = $1`;
      const params = [id];

      if (flowId && cols.flowIdCol) {
        where += ` AND ${cols.flowIdCol} = $2`;
        params.push(flowId);
      }

      const { rows } = await req.db.query(
        `DELETE FROM quick_replies WHERE ${where} RETURNING *`,
        params
      );

      if (!rows.length) {
        const body404 = { error: "Resposta não encontrada" };
        await fastify.audit(req, {
          action: "quick_reply.delete.not_found",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 404,
          responseBody: body404,
          extra: { flow_id: flowId },
        });
        return reply.code(404).send(body404);
      }

      const removed = rows[0];

      await fastify.audit(req, {
        action: "quick_reply.delete",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 200,
        beforeData: removed,
        responseBody: { success: true },
        extra: { flow_id: flowId },
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err, "DELETE /quick-replies/:id");

      const body500 = { error: "Erro ao deletar resposta" };
      await fastify.audit(req, {
        action: "quick_reply.delete.error",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err), flow_id: flowId },
      });

      return reply.code(500).send(body500);
    }
  });
}
