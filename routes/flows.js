export default async function flowsRoutes(fastify, opts) {
  fastify.post("/publish", async (req, reply) => {
    const { data } = req.body;

    // 400 — payload inválido
    if (!data || typeof data !== "object") {
      const resp400 = { error: "Fluxo inválido ou ausente." };
      await fastify.audit(req, {
        action: "flow.publish.bad_request",
        resourceType: "flow",
        resourceId: null,
        statusCode: 400,
        requestBody: { preview: typeof data, hasData: !!data },
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    try {
      // snapshot "antes": fluxos ativos (ids e total)
      const beforeQ = await req.db.query(
        `SELECT id FROM flows WHERE active = true ORDER BY id DESC`
      );
      const beforeActiveIds = (beforeQ.rows || []).map((r) => r.id);

      // Faz a publicação dentro de transação e retorna dados para auditoria
      const txResult = await req.db.tx(async (client) => {
        // 1) desativar todos
        const upd = await client.query(
          `UPDATE flows SET active = false WHERE active = true`
        );
        const deactivatedCount = upd.rowCount || 0;

        // 2) inserir novo ativo
        const ins = await client.query(
          `INSERT INTO flows(data, created_at, active)
         VALUES($1, now(), true)
         RETURNING id`,
          [data]
        );
        const insertedId = ins.rows[0].id;

        // 3) snapshot "depois"
        const afterQ = await client.query(
          `SELECT id FROM flows WHERE active = true ORDER BY id DESC`
        );
        const afterActiveIds = (afterQ.rows || []).map((r) => r.id);

        return { insertedId, deactivatedCount, afterActiveIds };
      });

      const responseBody = {
        message: "Fluxo publicado e ativado com sucesso.",
        id: txResult.insertedId,
      };

      // Auditoria de sucesso
      await fastify.audit(req, {
        action: "flow.publish",
        resourceType: "flow",
        resourceId: txResult.insertedId,
        statusCode: 200,
        requestBody: {
          /* cuidado com payload grande; o plugin já redige chaves sensíveis */
          // opcional: mandar só um resumo para não inflar o log
          hasData: true,
        },
        responseBody,
        beforeData: {
          active_flow_ids: beforeActiveIds,
        },
        afterData: {
          published_id: txResult.insertedId,
          deactivated_count: txResult.deactivatedCount,
          active_flow_ids: txResult.afterActiveIds,
        },
      });

      return reply.send(responseBody);
    } catch (error) {
      req.log.error(error, "Erro ao publicar fluxo");
      const resp500 = {
        error: "Erro ao publicar fluxo",
        detail: error.message,
      };

      await fastify.audit(req, {
        action: "flow.publish.error",
        resourceType: "flow",
        resourceId: null,
        statusCode: 500,
        responseBody: resp500,
        extra: { message: error?.message },
      });

      return reply.code(500).send(resp500);
    }
  });

  fastify.get("/sessions/:user_id", async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rows } = await req.db.query(
        "SELECT * FROM sessions WHERE user_id = $1 LIMIT 1",
        [user_id]
      );

      if (rows.length === 0) {
        reply.code(404).send({ error: "Sessão não encontrada" });
      } else {
        reply.send(rows[0]);
      }
    } catch (error) {
      fastify.log.error(error);
      reply
        .code(500)
        .send({ error: "Erro ao buscar sessão", detail: error.message });
    }
  });

  fastify.post("/sessions/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { current_block, flow_id, vars } = req.body || {};

    try {
      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT user_id, current_block, last_flow_id, vars, updated_at
         FROM sessions
        WHERE user_id = $1
        LIMIT 1`,
        [user_id]
      );
      const beforeRow = beforeQ.rows?.[0] || null;

      // upsert + retorna "depois"
      const upsertQ = await req.db.query(
        `INSERT INTO sessions(user_id, current_block, last_flow_id, vars, updated_at)
       VALUES($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         current_block = EXCLUDED.current_block,
         last_flow_id  = EXCLUDED.last_flow_id,
         vars          = EXCLUDED.vars,
         updated_at    = NOW()
       RETURNING user_id, current_block, last_flow_id, vars, updated_at`,
        [user_id, current_block, flow_id, vars]
      );
      const afterRow = upsertQ.rows[0];

      const responseBody = { message: "Sessão salva com sucesso." };

      // auditoria de sucesso
      await fastify.audit(req, {
        action: "session.upsert",
        resourceType: "session",
        resourceId: user_id,
        statusCode: 200,
        requestBody: {
          current_block: current_block ?? null,
          flow_id: flow_id ?? null,
          has_vars: !!vars,
        },
        responseBody,
        beforeData: beforeRow,
        afterData: afterRow,
      });

      return reply.send(responseBody);
    } catch (error) {
      req.log.error(error, "Erro ao salvar sessão");

      const resp500 = { error: "Erro ao salvar sessão", detail: error.message };

      // auditoria de erro
      await fastify.audit(req, {
        action: "session.upsert.error",
        resourceType: "session",
        resourceId: user_id,
        statusCode: 500,
        requestBody: {
          current_block: current_block ?? null,
          flow_id: flow_id ?? null,
          has_vars: !!vars,
        },
        responseBody: resp500,
        extra: { message: error?.message },
      });

      return reply.code(500).send(resp500);
    }
  });

  fastify.post("/activate", async (req, reply) => {
    const { id } = req.body || {};
    if (!id) {
      const resp400 = { error: "id é obrigatório" };
      await fastify.audit(req, {
        action: "flow.activate.error",
        resourceType: "flow",
        resourceId: null,
        statusCode: 400,
        requestBody: { id: id ?? null },
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    let beforeActives = [];
    let afterActives = [];
    let updatedCount = 0;

    try {
      // transação
      await req.db.tx(async (client) => {
        // snapshot antes (quais estão ativos)
        const b = await client.query(
          "SELECT id FROM flows WHERE active = true ORDER BY created_at DESC"
        );
        beforeActives = b.rows || [];

        // desativa todos
        await client.query("UPDATE flows SET active = false");

        // ativa o específico
        const up = await client.query(
          "UPDATE flows SET active = true WHERE id = $1 RETURNING id",
          [id]
        );
        updatedCount = up.rowCount;

        // snapshot depois
        const a = await client.query(
          "SELECT id FROM flows WHERE active = true ORDER BY created_at DESC"
        );
        afterActives = a.rows || [];
      });

      if (updatedCount === 0) {
        const resp404 = { error: "Fluxo não encontrado", id };
        await fastify.audit(req, {
          action: "flow.activate.not_found",
          resourceType: "flow",
          resourceId: id,
          statusCode: 404,
          requestBody: { id },
          responseBody: resp404,
          beforeData: { active_before: beforeActives },
          afterData: { active_after: afterActives },
        });
        return reply.code(404).send(resp404);
      }

      const resp200 = {
        success: true,
        active_ids: afterActives.map((r) => r.id),
      };

      // auditoria de sucesso
      await fastify.audit(req, {
        action: "flow.activate",
        resourceType: "flow",
        resourceId: id,
        statusCode: 200,
        requestBody: { id },
        responseBody: resp200,
        beforeData: { active_before: beforeActives },
        afterData: { active_after: afterActives },
      });

      return reply.code(200).send(resp200);
    } catch (error) {
      req.log.error(error, "Erro ao ativar fluxo");

      const resp500 = { error: "Erro ao ativar fluxo", detail: error.message };
      await fastify.audit(req, {
        action: "flow.activate.error",
        resourceType: "flow",
        resourceId: id || null,
        statusCode: 500,
        requestBody: { id: id ?? null },
        responseBody: resp500,
        beforeData: { active_before: beforeActives },
        afterData: { active_after: afterActives },
        extra: { message: error?.message },
      });

      return reply.code(500).send(resp500);
    }
  });

  fastify.get("/latest", async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
      SELECT id, active, created_at 
      FROM flows 
      WHERE active = true 
      `);

      return reply.code(200).send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({
        error: "Falha ao buscar últimos fluxos",
        detail: error.message,
      });
    }
  });

  fastify.get("/history", async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
      SELECT id, active, created_at 
      FROM flows 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

      return reply.code(200).send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({
        error: "Erro ao buscar histórico de versões",
        detail: error.message,
      });
    }
  });

  fastify.get("/data/:id", async (req, reply) => {
    const { id } = req.params;

    try {
      const { rows } = await req.db.query(
        "SELECT data FROM flows WHERE id = $1",
        [id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: "Fluxo não encontrado" });
      }

      return reply.code(200).send(rows[0].data);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({
        error: "Erro ao buscar fluxo",
        detail: error.message,
      });
    }
  });
}
