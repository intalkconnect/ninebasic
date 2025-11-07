// routes/ticketTags.js
/**
 * Endpoints:
 * - GET    /tags/ticket/catalog?fila=NomeDaFila&q=&active=true|false&page=&page_size=&flow_id=
 * - POST   /tags/ticket/catalog         → cria/ativa/atualiza tag em uma fila { fila, tag, label?, color?, active?, flow_id? }
 * - PATCH  /tags/ticket/catalog/:fila/:tag  (?flow_id=)
 * - DELETE /tags/ticket/catalog/:fila/:tag  (?flow_id=)
 *
 * - GET    /tags/ticket/:ticket_number          → lista tags do ticket
 * - GET    /tags/ticket/:ticket_number/catalog  → lista catálogo aplicável (fila do ticket)
 * - POST   /tags/ticket/:ticket_number          → adiciona 1..N tags ao ticket { tags: [...] }
 * - DELETE /tags/ticket/:ticket_number/:tag     → remove 1 tag do ticket
 */

async function ticketTagsRoutes(fastify) {
  // ===== Helpers =====
  async function getFilaIdByNome(db, nomeFila, flowId = null) {
    if (!nomeFila) return null;

    // se flow_id vier, precisa bater também
    if (flowId !== null && flowId !== undefined) {
      const { rows } = await db.query(
        `SELECT id
           FROM filas
          WHERE nome = $1
            AND flow_id IS NOT DISTINCT FROM $2
          LIMIT 1`,
        [nomeFila, flowId]
      );
      return rows[0]?.id || null;
    }

    // legado: sem flow_id, pega a primeira que bater
    const { rows } = await db.query(
      `SELECT id FROM filas WHERE nome = $1 LIMIT 1`,
      [nomeFila]
    );
    return rows[0]?.id || null;
  }

  async function getTicketFilaNome(db, ticketNumber) {
    const { rows } = await db.query(
      `SELECT fila FROM tickets WHERE ticket_number = $1 LIMIT 1`,
      [ticketNumber]
    );
    return rows[0]?.fila || null;
  }

  // ============================
  // Catálogo por fila (queue_ticket_tag_catalog)
  // ============================

  // GET /tags/ticket/catalog?fila=NomeDaFila&q=&active=true|false&page=&page_size=&flow_id=
  fastify.get("/ticket/catalog", async (req, reply) => {
    const {
      fila = "",
      q = "",
      active,
      page = 1,
      page_size = 20,
      flow_id,
    } = req.query || {};

    if (!fila.trim())
      return reply.code(400).send({ error: "Parâmetro fila é obrigatório" });

    const flowId = flow_id ?? null;

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);
    const offset = (pageNum - 1) * pageSize;

    try {
      const filaId = await getFilaIdByNome(req.db, fila, flowId);
      if (!filaId)
        return reply.code(404).send({ error: "Fila não encontrada" });

      const where = [`fila_id = $1`];
      const params = [filaId];

      if (q) {
        params.push(`%${q}%`);
        where.push(
          `(LOWER(tag) LIKE LOWER($${params.length}) OR LOWER(COALESCE(label,'')) LIKE LOWER($${params.length}))`
        );
      }
      if (active === "true" || active === true) {
        where.push(`active IS TRUE`);
      } else if (active === "false" || active === false) {
        where.push(`active IS FALSE`);
      }
      const whereSql = `WHERE ${where.join(" AND ")}`;

      const sqlCount = `SELECT COUNT(*)::bigint AS total FROM queue_ticket_tag_catalog ${whereSql}`;
      const sqlList = `
        SELECT fila_id, tag, label, color, active, created_at
          FROM queue_ticket_tag_catalog
          ${whereSql}
         ORDER BY tag ASC
         LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `;

      const rCount = await req.db.query(sqlCount, params);
      const total = Number(rCount.rows?.[0]?.total || 0);
      const rList = await req.db.query(sqlList, [...params, pageSize, offset]);

      return reply.send({
        fila,
        fila_id: filaId,
        flow_id: flowId,
        data: rList.rows || [],
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (err) {
      req.log.error({ err }, "GET /tags/ticket/catalog");
      return reply
        .code(500)
        .send({ error: "Erro ao listar catálogo de tags por fila" });
    }
  });

  // POST /tags/ticket/catalog { fila, tag, label?, color?, active?, flow_id? }
  fastify.post("/ticket/catalog", async (req, reply) => {
    const {
      fila,
      tag,
      label = null,
      color = null,
      active = true,
      flow_id,
    } = req.body || {};
    const f = String(fila || "").trim();
    const t = String(tag || "").trim();
    const flowId = flow_id ?? null;

    const resourceId = f && t ? `${f}:${t}${flowId ? `@${flowId}` : ""}` : null;

    // log de início
    await fastify.audit(req, {
      action: "ticket.tags.catalog.upsert.start",
      resourceType: "queue_ticket_tag",
      resourceId,
      statusCode: 200,
      requestBody: { fila: f, tag: t, label, color, active, flow_id: flowId },
    });

    if (!f || !t) {
      const body400 = { error: "Campos fila e tag são obrigatórios" };
      await fastify.audit(req, {
        action: "ticket.tags.catalog.upsert.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const filaId = await getFilaIdByNome(req.db, f, flowId);
      if (!filaId) {
        const body404 = { error: "Fila não encontrada" };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.upsert.not_found",
          resourceType: "queue",
          resourceId: f,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const sql = `
        INSERT INTO queue_ticket_tag_catalog (fila_id, tag, label, color, active)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (fila_id, tag) DO UPDATE
          SET label = EXCLUDED.label,
              color = EXCLUDED.color,
              active = EXCLUDED.active
        RETURNING fila_id, tag, label, color, active, created_at
      `;
      const { rows } = await req.db.query(sql, [
        filaId,
        t,
        label,
        color,
        Boolean(active),
      ]);
      const body201 = { fila: f, fila_id: filaId, flow_id: flowId, ...rows[0] };

      await fastify.audit(req, {
        action: "ticket.tags.catalog.upsert.done",
        resourceType: "queue_ticket_tag",
        resourceId: `${filaId}:${t}`,
        statusCode: 201,
        responseBody: body201,
      });

      return reply.code(201).send(body201);
    } catch (err) {
      req.log.error({ err }, "POST /tags/ticket/catalog");
      const body500 = { error: "Erro ao criar/atualizar tag de fila" };

      await fastify.audit(req, {
        action: "ticket.tags.catalog.upsert.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });

  // PATCH /tags/ticket/catalog/:fila/:tag  { label?, color?, active? } + ?flow_id=
  fastify.patch("/ticket/catalog/:fila/:tag", async (req, reply) => {
    const fila = String(req.params?.fila || "").trim();
    const tag = String(req.params?.tag || "").trim();
    const flowId = req.query?.flow_id ?? req.body?.flow_id ?? null;

    const resourceId = fila && tag ? `${fila}:${tag}${flowId ? `@${flowId}` : ""}` : null;

    // log: start
    await fastify.audit(req, {
      action: "ticket.tags.catalog.update.start",
      resourceType: "queue_ticket_tag",
      resourceId,
      statusCode: 200,
      requestBody: req.body || {},
    });

    if (!fila || !tag) {
      const body400 = { error: "Parâmetros fila e tag são obrigatórios" };
      await fastify.audit(req, {
        action: "ticket.tags.catalog.update.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    const allowed = ["label", "color", "active"];
    const upd = {};
    for (const k of allowed) {
      if (k in (req.body || {})) upd[k] = req.body[k];
    }

    if (!Object.keys(upd).length) {
      const body400 = { error: "Nada para atualizar" };
      await fastify.audit(req, {
        action: "ticket.tags.catalog.update.nop",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const filaId = await getFilaIdByNome(req.db, fila, flowId);
      if (!filaId) {
        const body404 = { error: "Fila não encontrada" };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.update.not_found_queue",
          resourceType: "queue",
          resourceId: fila,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const sets = [];
      const vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(upd)) {
        sets.push(`${k} = $${i++}`);
        vals.push(k === "active" ? Boolean(v) : v);
      }
      vals.push(filaId, tag);

      const sql = `
        UPDATE queue_ticket_tag_catalog
           SET ${sets.join(", ")}, updated_at = now()
         WHERE fila_id = $${i++} AND tag = $${i}
         RETURNING fila_id, tag, label, color, active, created_at
      `;
      const { rows } = await req.db.query(sql, vals);
      if (!rows[0]) {
        const body404 = {
          error: "Tag do catálogo não encontrada para esta fila",
        };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.update.not_found_tag",
          resourceType: "queue_ticket_tag",
          resourceId: `${filaId}:${tag}`,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      const body200 = { fila, fila_id: filaId, flow_id: flowId, ...rows[0] };

      await fastify.audit(req, {
        action: "ticket.tags.catalog.update.done",
        resourceType: "queue_ticket_tag",
        resourceId: `${filaId}:${tag}`,
        statusCode: 200,
        responseBody: body200,
        extra: { changedFields: Object.keys(upd) },
      });

      return reply.send(body200);
    } catch (err) {
      req.log.error({ err }, "PATCH /tags/ticket/catalog/:fila/:tag");
      const body500 = { error: "Erro ao atualizar tag do catálogo da fila" };

      await fastify.audit(req, {
        action: "ticket.tags.catalog.update.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });

  // DELETE /tags/ticket/catalog/:fila/:tag  (?flow_id=)
  fastify.delete("/ticket/catalog/:fila/:tag", async (req, reply) => {
    const fila = String(req.params?.fila || "").trim();
    const tag = String(req.params?.tag || "").trim();
    const flowId = req.query?.flow_id ?? null;

    const resourceId = fila && tag ? `${fila}:${tag}${flowId ? `@${flowId}` : ""}` : null;

    // log: start
    await fastify.audit(req, {
      action: "ticket.tags.catalog.delete.start",
      resourceType: "queue_ticket_tag",
      resourceId,
      statusCode: 200,
      requestBody: null,
    });

    if (!fila || !tag) {
      const body400 = { error: "Parâmetros fila e tag são obrigatórios" };
      await fastify.audit(req, {
        action: "ticket.tags.catalog.delete.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const filaId = await getFilaIdByNome(req.db, fila, flowId);
      if (!filaId) {
        const body404 = { error: "Fila não encontrada" };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.delete.not_found_queue",
          resourceType: "queue",
          resourceId: fila,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // impedir exclusão se estiver em uso
      const inUse = await req.db.query(
        `SELECT 1 FROM ticket_tags WHERE fila_id = $1 AND tag = $2 LIMIT 1`,
        [filaId, tag]
      );
      if (inUse.rowCount) {
        const body409 = {
          error: "Tag está vinculada a tickets — remova os vínculos antes",
        };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.delete.in_use",
          resourceType: "queue_ticket_tag",
          resourceId: `${filaId}:${tag}`,
          statusCode: 409,
          responseBody: body409,
        });
        return reply.code(409).send(body409);
      }

      const { rowCount } = await req.db.query(
        `DELETE FROM queue_ticket_tag_catalog WHERE fila_id = $1 AND tag = $2`,
        [filaId, tag]
      );

      if (rowCount) {
        await fastify.audit(req, {
          action: "ticket.tags.catalog.delete.done",
          resourceType: "queue_ticket_tag",
          resourceId: `${filaId}:${tag}`,
          statusCode: 204,
          responseBody: null,
        });
        return reply.code(204).send();
      } else {
        const body404 = { error: "Tag de fila não encontrada" };
        await fastify.audit(req, {
          action: "ticket.tags.catalog.delete.not_found_tag",
          resourceType: "queue_ticket_tag",
          resourceId: `${filaId}:${tag}`,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }
    } catch (err) {
      req.log.error({ err }, "DELETE /tags/ticket/catalog/:fila/:tag");
      const body500 = { error: "Erro ao remover tag do catálogo da fila" };
      await fastify.audit(req, {
        action: "ticket.tags.catalog.delete.error",
        resourceType: "queue_ticket_tag",
        resourceId,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });

  // ============================
  // Vínculo ticket ⇄ tag (ticket_tags)
  // ============================

  // GET /tags/ticket/:ticket_number
  fastify.get("/ticket/:ticket_number", async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || "").trim();
    if (!tn)
      return reply.code(400).send({ error: "ticket_number é obrigatório" });

    try {
      // checa ticket + resolve fila
      const { rows: rt } = await req.db.query(
        `SELECT ticket_number, fila FROM tickets WHERE ticket_number = $1 LIMIT 1`,
        [tn]
      );
      const t = rt[0];
      if (!t) return reply.code(404).send({ error: "Ticket não encontrado" });

      const { rows } = await req.db.query(
        `SELECT tt.ticket_number, tt.fila_id, qttc.tag, qttc.label, qttc.color, qttc.active, tt.created_at,
                f.nome AS fila
           FROM ticket_tags tt
           JOIN queue_ticket_tag_catalog qttc
             ON qttc.fila_id = tt.fila_id AND qttc.tag = tt.tag
           JOIN filas f ON f.id = tt.fila_id
          WHERE tt.ticket_number = $1
          ORDER BY qttc.tag ASC`,
        [tn]
      );
      return reply.send({ ticket_number: tn, fila: t.fila, tags: rows || [] });
    } catch (err) {
      req.log.error({ err }, "GET /tags/ticket/:ticket_number");
      return reply.code(500).send({ error: "Erro ao listar tags do ticket" });
    }
  });

  // GET /tags/ticket/:ticket_number/catalog  → catálogo aplicável (fila do ticket)
  fastify.get("/ticket/:ticket_number/catalog", async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || "").trim();
    if (!tn)
      return reply.code(400).send({ error: "ticket_number é obrigatório" });

    try {
      const filaNome = await getTicketFilaNome(req.db, tn);
      if (!filaNome)
        return reply
          .code(404)
          .send({ error: "Ticket não encontrado ou sem fila" });

      // aqui ainda usa legado (sem flow_id) pois ticket não tem flow_id no modelo original
      const filaId = await getFilaIdByNome(req.db, filaNome);
      if (!filaId)
        return reply.code(404).send({ error: "Fila do ticket não encontrada" });

      const { rows } = await req.db.query(
        `SELECT fila_id, tag, label, color, active, created_at
           FROM queue_ticket_tag_catalog
          WHERE fila_id = $1 AND active IS TRUE
          ORDER BY tag ASC`,
        [filaId]
      );
      return reply.send({
        ticket_number: tn,
        fila: filaNome,
        fila_id: filaId,
        catalog: rows || [],
      });
    } catch (err) {
      req.log.error({ err }, "GET /tags/ticket/:ticket_number/catalog");
      return reply
        .code(500)
        .send({ error: "Erro ao listar catálogo de tags da fila do ticket" });
    }
  });

  // POST /tags/ticket/:ticket_number  { tags: ["agendamento","reclamacao"] }
  fastify.post("/ticket/:ticket_number", async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || "").trim();
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((x) => String(x).trim()).filter(Boolean)
      : [];

    // log: start
    await fastify.audit(req, {
      action: "ticket.tags.attach.start",
      resourceType: "ticket",
      resourceId: tn || null,
      statusCode: 200,
      requestBody: { tags },
    });

    if (!tn) {
      const body400 = { error: "ticket_number é obrigatório" };
      await fastify.audit(req, {
        action: "ticket.tags.attach.error",
        resourceType: "ticket",
        resourceId: null,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }
    if (!tags.length) {
      const body400 = { error: "tags é obrigatório (array não-vazio)" };
      await fastify.audit(req, {
        action: "ticket.tags.attach.error",
        resourceType: "ticket",
        resourceId: tn,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const filaNome = await getTicketFilaNome(req.db, tn);
      if (!filaNome) {
        const body404 = { error: "Ticket não encontrado ou sem fila" };
        await fastify.audit(req, {
          action: "ticket.tags.attach.not_found_ticket",
          resourceType: "ticket",
          resourceId: tn,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // legado: aqui ainda não diferenciamos por flow_id de ticket
      const filaId = await getFilaIdByNome(req.db, filaNome);
      if (!filaId) {
        const body404 = { error: "Fila do ticket não encontrada" };
        await fastify.audit(req, {
          action: "ticket.tags.attach.not_found_queue",
          resourceType: "queue",
          resourceId: filaNome,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // valida catálogo/ativas
      const rKnown = await req.db.query(
        `SELECT tag FROM queue_ticket_tag_catalog
          WHERE fila_id = $1 AND tag = ANY($2::text[]) AND active IS TRUE`,
        [filaId, tags]
      );
      const known = new Set((rKnown.rows || []).map((r) => r.tag));
      const unknown = tags.filter((t) => !known.has(t));

      if (unknown.length) {
        const body400 = {
          error: "Tags não pertencem ao catálogo da fila ou estão inativas",
          unknown,
        };
        await fastify.audit(req, {
          action: "ticket.tags.attach.unknown_tags",
          resourceType: "ticket_tag",
          resourceId: `${tn}:${filaId}`,
          statusCode: 400,
          responseBody: body400,
          extra: { requested: tags },
        });
        return reply.code(400).send(body400);
      }

      // upsert
      const values = [];
      const params = [];
      let i = 1;
      for (const t of tags) {
        params.push(tn, filaId, t);
        values.push(`($${i++}, $${i++}, $${i++})`);
      }
      const sql = `
        INSERT INTO ticket_tags (ticket_number, fila_id, tag)
        VALUES ${values.join(", ")}
        ON CONFLICT (ticket_number, tag) DO NOTHING
        RETURNING ticket_number, fila_id, tag, created_at
      `;
      const { rows } = await req.db.query(sql, params);

      const body201 = {
        added: rows.length,
        items: rows,
        fila: filaNome,
        fila_id: filaId,
      };
      await fastify.audit(req, {
        action: "ticket.tags.attach.done",
        resourceType: "ticket",
        resourceId: tn,
        statusCode: 201,
        responseBody: body201,
      });

      return reply.code(201).send(body201);
    } catch (err) {
      req.log.error({ err }, "POST /tags/ticket/:ticket_number");
      const body500 = { error: "Erro ao vincular tags ao ticket" };
      await fastify.audit(req, {
        action: "ticket.tags.attach.error",
        resourceType: "ticket",
        resourceId: tn,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });

  // DELETE /tags/ticket/:ticket_number/:tag
  fastify.delete("/ticket/:ticket_number/:tag", async (req, reply) => {
    const tn = String(req.params?.ticket_number || "").trim();
    const tag = String(req.params?.tag || "").trim();

    if (!tn || !tag) {
      const body400 = { error: "ticket_number e tag são obrigatórios" };
      await fastify.audit(req, {
        action: "ticket.tags.detach.error",
        resourceType: "ticket",
        resourceId: tn || null,
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM ticket_tags WHERE ticket_number = $1 AND tag = $2`,
        [tn, tag]
      );

      if (rowCount) {
        await fastify.audit(req, {
          action: "ticket.tags.detach.done",
          resourceType: "ticket_tag",
          resourceId: `${tn}:${tag}`,
          statusCode: 204,
        });
        return reply.code(204).send();
      } else {
        const body404 = { error: "Vínculo não encontrado" };
        await fastify.audit(req, {
          action: "ticket.tags.detach.not_found",
          resourceType: "ticket_tag",
          resourceId: `${tn}:${tag}`,
          statusCode: 404,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }
    } catch (err) {
      req.log.error({ err }, "DELETE /tags/ticket/:ticket_number/:tag");
      const body500 = { error: "Erro ao remover tag do ticket" };
      await fastify.audit(req, {
        action: "ticket.tags.detach.error",
        resourceType: "ticket_tag",
        resourceId: `${tn}:${tag}`,
        statusCode: 500,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });
}

export default ticketTagsRoutes;
