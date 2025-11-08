// routes/quickReplies.js
export default async function quickRepliesRoutes(fastify) {
  // ➕ Criar nova resposta rápida (suporta flow_id)
  fastify.post("/", async (req, reply) => {
    const { title, content, flow_id: bodyFlowId } = req.body || {};
    const queryFlowId = req.query?.flow_id;
    const flowId = bodyFlowId || queryFlowId || null;

    if (!title || !content) {
      const body400 = { error: "title e content são obrigatórios" };
      await fastify.audit(req, {
        action: "quick_reply.create.invalid",
        resourceType: "quick_reply",
        statusCode: 400,
        requestBody: { ...req.body, flow_id: flowId },
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const { rows } = await req.db.query(
        `
          INSERT INTO quick_replies (title, content, flow_id)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
        [title, content, flowId]
      );

      const created = rows[0];

      await fastify.audit(req, {
        action: "quick_reply.create",
        resourceType: "quick_reply",
        resourceId: String(created.id),
        statusCode: 201,
        requestBody: { ...req.body, flow_id: flowId },
        responseBody: created,
        afterData: created,
      });

      return reply.code(201).send(created);
    } catch (err) {
      fastify.log.error(err, "POST /quick-replies");

      if (err?.code === "23505") {
        // unique violation (se houver constraint)
        const body409 = {
          error: "Já existe uma resposta rápida com esse título.",
        };
        await fastify.audit(req, {
          action: "quick_reply.create.conflict",
          resourceType: "quick_reply",
          statusCode: 409,
          requestBody: { ...req.body, flow_id: flowId },
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
        requestBody: { ...req.body, flow_id: flowId },
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });

  // ✏️ Atualizar resposta rápida (novo) – respeita flow_id
  fastify.put("/:id", async (req, reply) => {
    const { id } = req.params;
    const { title, content, flow_id: bodyFlowId } = req.body || {};
    const queryFlowId = req.query?.flow_id;
    const flowId = bodyFlowId || queryFlowId || null;

    if (!title || !content) {
      const body400 = { error: "title e content são obrigatórios" };
      await fastify.audit(req, {
        action: "quick_reply.update.invalid",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 400,
        requestBody: { ...req.body, flow_id: flowId },
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      // snapshot "antes"
      const whereBefore = flowId
        ? "id = $1 AND flow_id = $2"
        : "id = $1";

      const paramsBefore = flowId ? [id, flowId] : [id];
      const rBefore = await req.db.query(
        `SELECT * FROM quick_replies WHERE ${whereBefore} LIMIT 1`,
        paramsBefore
      );
      const before = rBefore.rows?.[0] || null;

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

      const whereUpdate = flowId
        ? "id = $3 AND flow_id = $4"
        : "id = $3";

      const paramsUpdate = flowId
        ? [title, content, id, flowId]
        : [title, content, id];

      const { rows } = await req.db.query(
        `
          UPDATE quick_replies
             SET title = $1,
                 content = $2
           WHERE ${whereUpdate}
           RETURNING *
        `,
        paramsUpdate
      );

      if (!rows.length) {
        const body404 = { error: "Resposta não encontrada" };
        await fastify.audit(req, {
          action: "quick_reply.update.not_found_after_check",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 404,
          beforeData: before,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const updated = rows[0];

      await fastify.audit(req, {
        action: "quick_reply.update",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 200,
        requestBody: { ...req.body, flow_id: flowId },
        beforeData: before,
        afterData: updated,
        responseBody: updated,
      });

      return reply.send(updated);
    } catch (err) {
      fastify.log.error(err, "PUT /quick-replies/:id");

      const body500 = { error: "Erro ao atualizar resposta" };
      await fastify.audit(req, {
        action: "quick_reply.update.error",
        resourceType: "quick_reply",
        resourceId: String(id),
        statusCode: 500,
        requestBody: { ...req.body, flow_id: bodyFlowId || queryFlowId },
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });

  // 📄 Listar respostas rápidas (opcionalmente por flow_id)
  fastify.get("/", async (req, reply) => {
    const flowId = req.query?.flow_id || null;

    try {
      let sql =
        "SELECT id, title, content, flow_id FROM quick_replies";
      const params = [];

      if (flowId) {
        sql += " WHERE flow_id = $1";
        params.push(flowId);
      }

      sql += " ORDER BY title";

      const { rows } = await req.db.query(sql, params);
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);

      return reply
        .code(500)
        .send({ error: "Erro ao buscar respostas rápidas" });
    }
  });

  // 🗑️ Remover uma resposta rápida (respeita flow_id)
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const flowId = req.query?.flow_id || null;

    try {
      let sql =
        "DELETE FROM quick_replies WHERE id = $1";
      const params = [id];

      if (flowId) {
        sql += " AND flow_id = $2";
        params.push(flowId);
      }

      sql += " RETURNING *";

      const { rows } = await req.db.query(sql, params);

      if (!rows.length) {
        const body404 = { error: "Resposta não encontrada" };
        await fastify.audit(req, {
          action: "quick_reply.delete.not_found",
          resourceType: "quick_reply",
          resourceId: String(id),
          statusCode: 404,
          responseBody: body404,
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
        extra: { flow_id: flowId || removed.flow_id || null },
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
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });
}
