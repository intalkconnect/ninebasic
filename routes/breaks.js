// routes/pausas.js
async function breaksRoutes(fastify, _opts) {
  // ========== CRUD: MOTIVOS (pause_reasons) ==========

  // Listar motivos (opcional ?active=true|false)
  fastify.get("/", async (req, reply) => {
    try {
      const { active } = req.db.query || {};
      let q = `SELECT id, code, label, max_minutes, active, created_at, updated_at
               FROM pause_reasons`;
      const params = [];
      if (typeof active !== "undefined") {
        q += ` WHERE active = $1`;
        params.push(String(active).toLowerCase() === "true");
      }
      q += ` ORDER BY label`;
      const { rows } = await req.db.query(q, params);
      return reply.send(rows);
    } catch (err) {
      req.log.error(err, "[pausas] list");
      return reply.code(500).send({ error: "Erro ao listar pausas" });
    }
  });

  // Buscar um motivo
  fastify.get("/:id", async (req, reply) => {
    const { id } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
           FROM pause_reasons
          WHERE id = $1`,
        [id]
      );
      if (!rows.length)
        return reply
          .code(404)
          .send({ error: "Motivo de pausa não encontrado" });
      return reply.send(rows[0]);
    } catch (err) {
      req.log.error(err, "[pausas] get one");
      return reply.code(500).send({ error: "Erro ao buscar motivo de pausa" });
    }
  });

  // Criar motivo
  fastify.post("/", async (req, reply) => {
    const { code, label, max_minutes = 0, active = true } = req.body || {};
    if (!code || !label) {
      const resp = { error: "code e label são obrigatórios" };
      // opcional: auditar tentativas inválidas
      await fastify.audit(req, {
        action: "pause_reasons.create.invalid",
        resourceType: "pause_reason",
        resourceId: code || null,
        requestBody: req.body,
        responseBody: resp,
        statusCode: 400,
      });
      return reply.code(400).send(resp);
    }

    try {
      const { rows } = await req.db.query(
        `INSERT INTO pause_reasons (code, label, max_minutes, active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        [code, label, max_minutes, !!active]
      );

      const created = rows[0];

      // 🔒 audit (manual)
      await fastify.audit(req, {
        action: "pause_reasons.create",
        resourceType: "pause_reason",
        resourceId: String(created.id),
        requestBody: req.body,
        responseBody: created,
        statusCode: 201,
      });

      return reply.code(201).send(created);
    } catch (err) {
      req.log.error(err, "[pausas] create");
      const msg = /duplicate key|unique/i.test(String(err))
        ? "code já existente"
        : "Erro ao criar motivo";
      const resp = { error: msg };

      // opcional: auditar falha
      await fastify.audit(req, {
        action: "pause_reasons.create.error",
        resourceType: "pause_reason",
        resourceId: code || null,
        requestBody: req.body,
        responseBody: resp,
        statusCode: 400,
      });

      return reply.code(400).send(resp);
    }
  });

  // Atualizar motivo (PUT)
  fastify.put("/:id", async (req, reply) => {
    const { id } = req.params;
    const { code, label, max_minutes = 0, active = true } = req.body || {};

    if (!code || !label) {
      const resp = { error: "code e label são obrigatórios" };
      await fastify.audit(req, {
        action: "pause_reasons.update.invalid",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: resp,
        statusCode: 400,
      });
      return reply.code(400).send(resp);
    }

    try {
      // pega estado ANTES
      const { rows: beforeRows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
         FROM pause_reasons
        WHERE id = $1
        LIMIT 1`,
        [id]
      );
      if (beforeRows.length === 0) {
        const resp = { error: "Motivo de pausa não encontrado" };
        await fastify.audit(req, {
          action: "pause_reasons.update.not_found",
          resourceType: "pause_reason",
          resourceId: String(id),
          requestBody: req.body,
          responseBody: resp,
          statusCode: 404,
        });
        return reply.code(404).send(resp);
      }
      const before = beforeRows[0];

      // atualiza e retorna estado DEPOIS
      const { rows: afterRows } = await req.db.query(
        `UPDATE pause_reasons
          SET code = $2,
              label = $3,
              max_minutes = $4,
              active = $5,
              updated_at = NOW()
        WHERE id = $1
      RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        [id, code, label, max_minutes, !!active]
      );

      const after = afterRows[0];

      await fastify.audit(req, {
        action: "pause_reasons.update",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: { success: true },
        beforeData: before,
        afterData: after,
        statusCode: 200,
      });

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, "[pausas] update");
      const resp = { error: "Erro ao atualizar motivo" };

      await fastify.audit(req, {
        action: "pause_reasons.update.error",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: resp,
        statusCode: 500,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // Atualizar motivo (PATCH)
  fastify.patch("/:id", async (req, reply) => {
    const { id } = req.params;
    const { code, label, max_minutes, active } = req.body || {};

    const sets = [];
    const vals = [id];
    let idx = 2;

    if (typeof code !== "undefined") {
      sets.push(`code = $${idx++}`);
      vals.push(code);
    }
    if (typeof label !== "undefined") {
      sets.push(`label = $${idx++}`);
      vals.push(label);
    }
    if (typeof max_minutes !== "undefined") {
      sets.push(`max_minutes = $${idx++}`);
      vals.push(max_minutes);
    }
    if (typeof active !== "undefined") {
      sets.push(`active = $${idx++}`);
      vals.push(!!active);
    }

    if (!sets.length) {
      const resp = { error: "Nada para atualizar" };
      await fastify.audit(req, {
        action: "pause_reasons.patch.invalid",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: resp,
        statusCode: 400,
      });
      return reply.code(400).send(resp);
    }

    try {
      // BEFORE
      const { rows: beforeRows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
         FROM pause_reasons
        WHERE id = $1
        LIMIT 1`,
        [id]
      );
      if (beforeRows.length === 0) {
        const resp = { error: "Motivo de pausa não encontrado" };
        await fastify.audit(req, {
          action: "pause_reasons.patch.not_found",
          resourceType: "pause_reason",
          resourceId: String(id),
          requestBody: req.body,
          responseBody: resp,
          statusCode: 404,
        });
        return reply.code(404).send(resp);
      }
      const before = beforeRows[0];

      // UPDATE + AFTER
      const { rows: afterRows } = await req.db.query(
        `UPDATE pause_reasons
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $1
      RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        vals
      );

      const after = afterRows[0];

      await fastify.audit(req, {
        action: "pause_reasons.patch",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: { success: true },
        beforeData: before,
        afterData: after,
        statusCode: 200,
      });

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, "[pausas] patch");
      const resp = { error: "Erro ao atualizar motivo" };

      await fastify.audit(req, {
        action: "pause_reasons.patch.error",
        resourceType: "pause_reason",
        resourceId: String(id),
        requestBody: req.body,
        responseBody: resp,
        statusCode: 500,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // Alternar ativo/inativo
  fastify.patch("/:id/toggle", async (req, reply) => {
    const { id } = req.params;

    try {
      // BEFORE
      const { rows: beforeRows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
         FROM pause_reasons
        WHERE id = $1
        LIMIT 1`,
        [id]
      );

      if (beforeRows.length === 0) {
        const resp = { error: "Motivo de pausa não encontrado" };
        await fastify.audit(req, {
          action: "pause_reasons.toggle.not_found",
          resourceType: "pause_reason",
          resourceId: String(id),
          responseBody: resp,
          statusCode: 404,
        });
        return reply.code(404).send(resp);
      }

      const before = beforeRows[0];

      // UPDATE + AFTER
      const { rows: afterRows } = await req.db.query(
        `UPDATE pause_reasons
          SET active = NOT active, updated_at = now()
        WHERE id = $1
      RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        [id]
      );

      const after = afterRows[0];

      await fastify.audit(req, {
        action: "pause_reasons.toggle",
        resourceType: "pause_reason",
        resourceId: String(id),
        beforeData: before,
        afterData: after,
        responseBody: after, // opcional: salva o que foi retornado
        statusCode: 200,
      });

      return reply.send(after);
    } catch (err) {
      req.log.error(err, "[pausas] toggle");
      const resp = { error: "Erro ao alternar ativo/inativo" };

      await fastify.audit(req, {
        action: "pause_reasons.toggle.error",
        resourceType: "pause_reason",
        resourceId: String(id),
        responseBody: resp,
        statusCode: 500,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // Remover motivo (só se não houver sessões vinculadas)
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params;

    try {
      // BEFORE: pega o registro que será removido
      const { rows: beforeRows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
         FROM pause_reasons
        WHERE id = $1
        LIMIT 1`,
        [id]
      );

      if (!beforeRows.length) {
        const resp = { error: "Motivo de pausa não encontrado" };
        await fastify.audit(req, {
          action: "pause_reasons.delete.not_found",
          resourceType: "pause_reason",
          resourceId: String(id),
          responseBody: resp,
          statusCode: 404,
        });
        return reply.code(404).send(resp);
      }

      const before = beforeRows[0];

      // Dependência: existe sessão vinculada?
      const dep = await req.db.query(
        `SELECT 1 FROM atendente_pause_sessions WHERE reason_id=$1 LIMIT 1`,
        [id]
      );
      if (dep.rowCount) {
        const resp = { error: "Há sessões vinculadas a este motivo" };
        await fastify.audit(req, {
          action: "pause_reasons.delete.conflict",
          resourceType: "pause_reason",
          resourceId: String(id),
          beforeData: before,
          responseBody: resp,
          statusCode: 409,
          extra: { hasLinkedSessions: true },
        });
        return reply.code(409).send(resp);
      }

      // DELETE
      const { rowCount } = await req.db.query(
        `DELETE FROM pause_reasons WHERE id=$1`,
        [id]
      );

      if (!rowCount) {
        // (caso raro: alguém removeu entre o SELECT e o DELETE)
        const resp = { error: "Motivo de pausa não encontrado" };
        await fastify.audit(req, {
          action: "pause_reasons.delete.not_found",
          resourceType: "pause_reason",
          resourceId: String(id),
          beforeData: before,
          responseBody: resp,
          statusCode: 404,
        });
        return reply.code(404).send(resp);
      }

      const resp = { success: true };

      await fastify.audit(req, {
        action: "pause_reasons.delete",
        resourceType: "pause_reason",
        resourceId: String(id),
        beforeData: before,
        responseBody: resp,
        statusCode: 200,
      });

      return reply.send(resp);
    } catch (err) {
      req.log.error(err, "[pausas] delete");
      const resp = { error: "Erro ao remover motivo" };

      await fastify.audit(req, {
        action: "pause_reasons.delete.error",
        resourceType: "pause_reason",
        resourceId: String(id),
        responseBody: resp,
        statusCode: 500,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // ========== SESSÕES DE PAUSA DO ATENDENTE ==========

  // Sessão ativa do atendente
  fastify.get("/agents/:email/current", async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT s.id, s.email, s.reason_id,
                r.code, r.label, r.max_minutes,
                s.started_at, s.ended_at, s.duration_sec, s.notes
           FROM atendente_pause_sessions s
           JOIN pause_reasons r ON r.id = s.reason_id
          WHERE s.email = $1 AND s.ended_at IS NULL
          ORDER BY s.started_at DESC
          LIMIT 1`,
        [email]
      );
      return reply.send(rows[0] || null);
    } catch (err) {
      req.log.error(err, "[pausas] current");
      return reply.code(500).send({ error: "Erro ao buscar pausa atual" });
    }
  });

  // Histórico do atendente
  fastify.get("/agents/:email/history", async (req, reply) => {
    const { email } = req.params;
    const { limit = 50, from } = req.query || {};
    const params = [email];
    let where = `WHERE s.email = $1`;
    if (from) {
      params.push(from);
      where += ` AND s.started_at >= $2`;
    }
    try {
      const { rows } = await req.db.query(
        `SELECT s.id, s.email, s.reason_id,
                r.code, r.label, r.max_minutes,
                s.started_at, s.ended_at, s.duration_sec, s.notes
           FROM atendente_pause_sessions s
           JOIN pause_reasons r ON r.id = s.reason_id
          ${where}
          ORDER BY s.started_at DESC
          LIMIT ${Number(limit) || 50}`,
        params
      );
      return reply.send(rows);
    } catch (err) {
      req.log.error(err, "[pausas] historico");
      return reply
        .code(500)
        .send({ error: "Erro ao listar histórico de pausas" });
    }
  });

  // Iniciar pausa
  fastify.post("/agents/:email/start", async (req, reply) => {
    const { email } = req.params;
    const { reason_id, notes } = req.body || {};
    if (!reason_id)
      return reply.code(400).send({ error: "reason_id é obrigatório" });

    try {
      // já tem pausa ativa?
      const active = await req.db.query(
        `SELECT id
           FROM atendente_pause_sessions
          WHERE email=$1 AND ended_at IS NULL
          LIMIT 1`,
        [email]
      );
      if (active.rowCount) {
        return reply.code(409).send({ error: "Já existe pausa ativa" });
      }

      // motivo existe e está ativo?
      const reason = await req.db.query(
        `SELECT id, active FROM pause_reasons WHERE id=$1`,
        [reason_id]
      );
      if (!reason.rowCount)
        return reply
          .code(404)
          .send({ error: "Motivo de pausa não encontrado" });
      if (!reason.rows[0].active)
        return reply.code(409).send({ error: "Motivo de pausa inativo" });

      // cria sessão
      const ins = await req.db.query(
        `INSERT INTO atendente_pause_sessions (email, reason_id, notes)
         VALUES ($1, $2, $3)
         RETURNING id, email, reason_id, started_at, ended_at, duration_sec, notes`,
        [email, reason_id, notes || null]
      );

      // status do atendente = 'pausa'
      await req.db.query(
        `UPDATE atendentes SET status='pausa' WHERE email=$1`,
        [email]
      );

      return reply.code(201).send(ins.rows[0]);
    } catch (err) {
      req.log.error(err, "[pausas] start");
      return reply.code(500).send({ error: "Erro ao iniciar pausa" });
    }
  });

  // Encerrar pausa
  fastify.patch("/agents/:email/:id/end", async (req, reply) => {
    const { email, id } = req.params;
    const { ended_at } = req.body || {};
    try {
      const { rows } = await req.db.query(
        `SELECT id, started_at, ended_at
           FROM atendente_pause_sessions
          WHERE id=$1 AND email=$2`,
        [id, email]
      );
      if (!rows.length)
        return reply
          .code(404)
          .send({ error: "Sessão de pausa não encontrada" });
      const sess = rows[0];

      if (sess.ended_at) {
        // idempotente
        return reply.send({ success: true, id, alreadyEnded: true });
      }

      const endTs = ended_at ? new Date(ended_at) : new Date();
      const dur = Math.max(
        0,
        Math.floor((endTs - new Date(sess.started_at)) / 1000)
      );

      await req.db.query(
        `UPDATE atendente_pause_sessions
            SET ended_at=$2, duration_sec=$3
          WHERE id=$1`,
        [id, endTs, dur]
      );

      // status do atendente = 'online' (ajuste se quiser restaurar status anterior)
      await req.db.query(
        `UPDATE atendentes SET status='online' WHERE email=$1`,
        [email]
      );

      return reply.send({ success: true, id, duration_sec: dur });
    } catch (err) {
      req.log.error(err, "[pausas] end");
      return reply.code(500).send({ error: "Erro ao encerrar pausa" });
    }
  });
}

export default breaksRoutes;
