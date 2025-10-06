// routes/quickReplies.js
export default async function quickRepliesRoutes(fastify) {
  // ➕ Criar nova resposta rápida
  fastify.post("/", async (req, reply) => {
    const { title, content } = req.body || {};
    if (!title || !content) {
      const body400 = { error: "title e content são obrigatórios" };
      await fastify.audit(req, {
        action: "quick_reply.create.invalid",
        resourceType: "quick_reply",
        statusCode: 400,
        requestBody: req.body,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const { rows } = await req.db.query(
        "INSERT INTO quick_replies (title, content) VALUES ($1, $2) RETURNING *",
        [title, content]
      );

      const created = rows[0];

      await fastify.audit(req, {
        action: "quick_reply.create",
        resourceType: "quick_reply",
        resourceId: String(created.id),
        statusCode: 201,
        requestBody: req.body,
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

  // 📄 Listar todas as respostas rápidas
  fastify.get("/", async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        "SELECT id, title, content FROM quick_replies ORDER BY title"
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply
        .code(500)
        .send({ error: "Erro ao buscar respostas rápidas" });
    }
  });

  // 🗑️ Remover uma resposta rápida
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params;

    try {
      // usa RETURNING * para logarmos o que foi removido
      const { rows } = await req.db.query(
        "DELETE FROM quick_replies WHERE id = $1 RETURNING *",
        [id]
      );

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
