function isValidUserId(userId) {
  return /^[^@]+@[^@]+\.[^@]+$/.test(userId);
}

function normalizeTag(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 40) return t.slice(0, 40);

  if (/[^\S\r\n]*[\r\n]/.test(t)) return null;
  return t;
}

async function customersRoutes(fastify, options) {
  // GET /customers?page=&page_size=&q=&flow_id=
  fastify.get("/", async (req, reply) => {
    const { q = "", page = 1, page_size = 10, flow_id } = req.query || {};

    if (!flow_id) {
      return reply
        .code(400)
        .send({ error: "flow_id é obrigatório para listar clientes" });
    }
    const flowId = String(flow_id);

    // page_size permitido: 10,20,30,40
    const allowed = new Set([10, 20, 30, 40]);
    const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
    const pageNum = Math.max(1, Number(page) || 1);
    const offset = (pageNum - 1) * pageSize;

    const paramsWhere = [];
    const where = [];

    // sempre filtra por flow_id
    paramsWhere.push(flowId);
    where.push(`c.flow_id = $${paramsWhere.length}::uuid`);

    if (q) {
      paramsWhere.push(`%${q}%`);
      const i = paramsWhere.length;
      where.push(`(
        LOWER(COALESCE(c.name,''))      LIKE LOWER($${i})
        OR LOWER(COALESCE(c.user_id,'')) LIKE LOWER($${i})
        OR LOWER(COALESCE(c.phone,''))   LIKE LOWER($${i})
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sqlCount = `SELECT COUNT(*)::bigint AS total FROM clientes c ${whereSql}`;
    const sqlList = `
      SELECT c.user_id, c.name, c.phone, c.channel, c.created_at, c.updated_at
        FROM clientes c
        ${whereSql}
       ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
       LIMIT $${paramsWhere.length + 1}
      OFFSET $${paramsWhere.length + 2}
    `;

    try {
      const countRes = await req.db.query(sqlCount, paramsWhere);
      const total = Number(countRes.rows?.[0]?.total || 0);

      const listRes = await req.db.query(sqlList, [
        ...paramsWhere,
        pageSize,
        offset,
      ]);
      const data = listRes.rows || [];

      const total_pages = Math.max(1, Math.ceil(total / pageSize));
      return reply.send({
        data,
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages,
      });
    } catch (error) {
      req.log.error("Erro ao listar clientes:", error);
      return reply.code(500).send({ error: "Erro interno ao listar clientes" });
    }
  });

  // GET /customers/:user_id?flow_id=...
  fastify.get("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};

    if (!flow_id) {
      return reply
        .code(400)
        .send({ error: "flow_id é obrigatório", user_id });
    }
    const flowId = String(flow_id);

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({
        error: "Formato de user_id inválido. Use: usuario@dominio",
        user_id,
      });
    }

    try {
      const { rows } = await req.db.query(
        `
      SELECT 
        c.*, 
        t.ticket_number, 
        t.fila, 
        c.channel 
      FROM clientes c
      LEFT JOIN tickets t 
        ON c.user_id = t.user_id
       AND t.status = 'open'
       AND t.flow_id = c.flow_id
      WHERE c.user_id = $1
        AND c.flow_id = $2::uuid
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1
      `,
        [user_id, flowId]
      );

      return rows[0]
        ? reply.send(rows[0])
        : reply.code(404).send({ error: "Cliente não encontrado", user_id });
    } catch (error) {
      fastify.log.error(`Erro ao buscar cliente ${user_id}:`, error);
      return reply.code(500).send({
        error: "Erro interno",
        user_id,
        ...(process.env.NODE_ENV === "production" && {
          details: error.message,
        }),
      });
    }
  });

  // PUT /customers/:user_id?flow_id=...
  fastify.put("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};
    const { name, phone } = req.body || {};

    if (!flow_id) {
      const resp = { error: "flow_id é obrigatório", user_id };
      await fastify.audit(req, {
        action: "customer.update.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
        requestBody: req.body,
      });
      return reply.code(400).send(resp);
    }
    const flowId = String(flow_id);

    // 400 – validação
    if (!name?.trim() || !phone?.trim()) {
      const resp = {
        error: "Campos name e phone são obrigatórios e não podem ser vazios",
        user_id,
      };
      await fastify.audit(req, {
        action: "customer.update.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
        requestBody: req.body,
      });
      return reply.code(400).send(resp);
    }

    try {
      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT * FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid LIMIT 1`,
        [user_id, flowId]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      // atualização
      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET name = $1, phone = $2, updated_at = NOW()
       WHERE user_id = $3
         AND flow_id = $4::uuid
       RETURNING *`,
        [name.trim(), phone.trim(), user_id, flowId]
      );

      // 404 – não encontrado
      if (!rows[0]) {
        const resp = { error: "Cliente não encontrado", user_id };
        await fastify.audit(req, {
          action: "customer.update.not_found",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 404,
          responseBody: resp,
          requestBody: req.body,
          beforeData,
        });
        return reply.code(404).send(resp);
      }

      // 200 – sucesso
      const afterData = rows[0];
      await fastify.audit(req, {
        action: "customer.update",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 200,
        requestBody: req.body,
        beforeData,
        afterData,
      });

      return reply.send(afterData);
    } catch (error) {
      fastify.log.error(`Erro ao atualizar cliente ${user_id}:`, error);
      const resp = {
        error: "Erro na atualização",
        user_id,
        ...(process.env.NODE_ENV === "development" && {
          details: error.message,
        }),
      };

      await fastify.audit(req, {
        action: "customer.update.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp,
        requestBody: req.body,
        extra: { message: error.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // PATCH /customers/:user_id?flow_id=...
  fastify.patch("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};

    if (!flow_id) {
      const resp = { error: "flow_id é obrigatório", user_id };
      await fastify.audit(req, {
        action: "customer.patch.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        requestBody: req.body,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }
    const flowId = String(flow_id);

    // normaliza e filtra campos permitidos
    const updates = Object.entries(req.body || {})
      .filter(
        ([key, val]) =>
          ["name", "phone"].includes(key) &&
          typeof val === "string" &&
          val.trim()
      )
      .reduce((acc, [key, val]) => ({ ...acc, [key]: val.trim() }), {});

    // 400 – nada para atualizar
    if (Object.keys(updates).length === 0) {
      const resp = {
        error: "Forneça name ou phone válidos para atualização",
        user_id,
      };
      await fastify.audit(req, {
        action: "customer.patch.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        requestBody: req.body,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    try {
      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT * FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid LIMIT 1`,
        [user_id, flowId]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      // monta SET dinamicamente
      const keys = Object.keys(updates);
      const setClauses = keys
        .map((key, i) => `${key} = $${i + 1}`)
        .join(", ");
      const len = keys.length;

      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET ${setClauses}, updated_at = NOW()
       WHERE user_id = $${len + 1}
         AND flow_id = $${len + 2}::uuid
       RETURNING *`,
        [...Object.values(updates), user_id, flowId]
      );

      // 404 – não encontrado
      if (!rows[0]) {
        const resp = { error: "Cliente não encontrado", user_id };
        await fastify.audit(req, {
          action: "customer.patch.not_found",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 404,
          requestBody: req.body,
          responseBody: resp,
          beforeData,
        });
        return reply.code(404).send(resp);
      }

      // 200 – sucesso
      const afterData = rows[0];
      await fastify.audit(req, {
        action: "customer.patch",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 200,
        requestBody: req.body,
        beforeData,
        afterData,
      });

      return reply.send(afterData);
    } catch (error) {
      fastify.log.error(`Erro ao atualizar parcialmente ${user_id}:`, error);
      const resp = {
        error: "Erro na atualização parcial",
        user_id,
        ...(process.env.NODE_ENV === "development" && {
          details: error.message,
        }),
      };

      await fastify.audit(req, {
        action: "customer.patch.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        requestBody: req.body,
        responseBody: resp,
        extra: { message: error.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // DELETE /customers/:user_id?flow_id=...
  fastify.delete("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};

    if (!flow_id) {
      const resp = { error: "flow_id é obrigatório", user_id };
      await fastify.audit(req, {
        action: "customer.delete.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }
    const flowId = String(flow_id);

    try {
      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT * FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid LIMIT 1`,
        [user_id, flowId]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      const { rowCount } = await req.db.query(
        `DELETE FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid`,
        [user_id, flowId]
      );

      if (rowCount > 0) {
        await fastify.audit(req, {
          action: "customer.delete",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 204,
          beforeData,
        });
        return reply.code(204).send();
      }

      const resp404 = { error: "Cliente não encontrado", user_id };
      await fastify.audit(req, {
        action: "customer.delete.not_found",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 404,
        responseBody: resp404,
      });
      return reply.code(404).send(resp404);
    } catch (error) {
      fastify.log.error(`Erro ao deletar cliente ${user_id}:`, error);
      const resp500 = {
        error: "Erro ao excluir",
        user_id,
        ...(process.env.NODE_ENV === "production" && {
          details: error.message,
        }),
      };
      await fastify.audit(req, {
        action: "customer.delete.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp500,
        extra: { message: error.message },
      });
      return reply.code(500).send(resp500);
    }
  });

  // GET /customers/:user_id/tags?flow_id=...
  fastify.get("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};

    if (!flow_id) {
      return reply
        .code(400)
        .send({ error: "flow_id é obrigatório para listar tags" });
    }
    const flowId = String(flow_id);

    if (!isValidUserId(user_id)) {
      return reply
        .code(400)
        .send({ error: "Formato de user_id inválido. Use: usuario@dominio" });
    }

    try {
      const cRes = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      if (cRes.rowCount === 0)
        return reply.code(404).send({ error: "Cliente não encontrado" });

      const { rows } = await req.db.query(
        `SELECT tag 
           FROM customer_tags 
          WHERE user_id = $1
            AND flow_id = $2::uuid
          ORDER BY tag ASC`,
        [user_id, flowId]
      );
      return reply.send({ user_id, tags: rows.map((r) => r.tag) });
    } catch (err) {
      req.log.error({ err }, "Erro em GET /clientes/:user_id/tags");
      return reply
        .code(500)
        .send({ error: "Erro interno ao listar tags do cliente" });
    }
  });

  // PUT /customers/:user_id/tags?flow_id=... { tags: string[] }
  fastify.put("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};
    const { tags } = req.body || {};

    if (!flow_id) {
      const resp400 = { error: "flow_id é obrigatório" };
      await fastify.audit(req, {
        action: "customer.tags.replace.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }
    const flowId = String(flow_id);

    if (!isValidUserId(user_id)) {
      const resp400 = {
        error: "Formato de user_id inválido. Use: usuario@dominio",
      };
      await fastify.audit(req, {
        action: "customer.tags.replace.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }
    if (!Array.isArray(tags)) {
      const resp400 = { error: "Payload inválido. Envie { tags: string[] }" };
      await fastify.audit(req, {
        action: "customer.tags.replace.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    const norm = [...new Set(tags.map(normalizeTag).filter(Boolean))];

    const client = req.db;
    let inTx = false;
    try {
      const cRes = await client.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      if (cRes.rowCount === 0) {
        const resp404 = { error: "Cliente não encontrado" };
        await fastify.audit(req, {
          action: "customer.tags.replace.not_found",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 404,
          responseBody: resp404,
        });
        return reply.code(404).send(resp404);
      }

      const beforeQ = await client.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags
        WHERE user_id = $1
          AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      await client.query("BEGIN");
      inTx = true;

      await client.query(
        `DELETE FROM customer_tags WHERE user_id = $1 AND flow_id = $2::uuid`,
        [user_id, flowId]
      );

      if (norm.length) {
        const values = norm
          .map((_, i) => `($1, $2::uuid, $${i + 3})`)
          .join(", ");
        await client.query(
          `INSERT INTO customer_tags (user_id, flow_id, tag)
           VALUES ${values}
           ON CONFLICT DO NOTHING`,
          [user_id, flowId, ...norm]
        );
      }

      await client.query("COMMIT");
      inTx = false;

      const resp200 = { ok: true, user_id, tags: norm };

      await fastify.audit(req, {
        action: "customer.tags.replace",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 200,
        beforeData: { tags: beforeTags },
        afterData: { tags: norm },
        requestBody: { tags },
        responseBody: resp200,
      });

      return reply.send(resp200);
    } catch (err) {
      if (inTx) {
        try {
          await req.db.query("ROLLBACK");
        } catch {}
      }
      req.log.error({ err }, "Erro em PUT /clientes/:user_id/tags");

      const resp500 = { error: "Erro ao salvar tags do cliente" };

      await fastify.audit(req, {
        action: "customer.tags.replace.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp500,
        extra: { message: err?.message },
      });

      return reply.code(500).send(resp500);
    }
  });

  // POST /customers/:user_id/tags?flow_id=... { tag: string }
  fastify.post("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;
    const { flow_id } = req.query || {};
    const { tag } = req.body || {};
    const t = normalizeTag(tag);

    if (!flow_id) {
      const resp400 = { error: "flow_id é obrigatório" };
      await fastify.audit(req, {
        action: "customer.tags.add.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }
    const flowId = String(flow_id);

    if (!isValidUserId(user_id)) {
      const resp400 = {
        error: "Formato de user_id inválido. Use: usuario@dominio",
      };
      await fastify.audit(req, {
        action: "customer.tags.add.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    if (!t) {
      const resp400 = { error: "Tag inválida" };
      await fastify.audit(req, {
        action: "customer.tags.add.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    try {
      const cRes = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      if (cRes.rowCount === 0) {
        const resp404 = { error: "Cliente não encontrado" };
        await fastify.audit(req, {
          action: "customer.tags.add.not_found",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 404,
          responseBody: resp404,
        });
        return reply.code(404).send(resp404);
      }

      const beforeQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags
        WHERE user_id = $1
          AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      const ins = await req.db.query(
        `INSERT INTO customer_tags (user_id, flow_id, tag)
         VALUES ($1, $2::uuid, $3)
         ON CONFLICT DO NOTHING`,
        [user_id, flowId, t]
      );

      const afterQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags
        WHERE user_id = $1
          AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      const afterTags = afterQ.rows?.[0]?.tags || [];

      const created = ins.rowCount === 1;
      const resp = { ok: true, user_id, tag: t, created };

      await fastify.audit(req, {
        action: created ? "customer.tags.add" : "customer.tags.add.noop",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 201,
        beforeData: { tags: beforeTags },
        afterData: { tags: afterTags },
        requestBody: { tag },
        responseBody: resp,
      });

      return reply.code(201).send(resp);
    } catch (err) {
      req.log.error({ err }, "Erro em POST /clientes/:user_id/tags");

      const resp500 = { error: "Erro ao adicionar tag do cliente" };

      await fastify.audit(req, {
        action: "customer.tags.add.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp500,
        extra: { message: err?.message },
      });

      return reply.code(500).send(resp500);
    }
  });

  // DELETE /customers/:user_id/tags/:tag?flow_id=...
  fastify.delete("/:user_id/tags/:tag", async (req, reply) => {
    const { user_id, tag } = req.params;
    const { flow_id } = req.query || {};
    const t = normalizeTag(tag);

    if (!flow_id) {
      const resp400 = { error: "flow_id é obrigatório" };
      await fastify.audit(req, {
        action: "customer.tags.remove.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }
    const flowId = String(flow_id);

    if (!isValidUserId(user_id)) {
      const resp400 = {
        error: "Formato de user_id inválido. Use: usuario@dominio",
      };
      await fastify.audit(req, {
        action: "customer.tags.remove.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    if (!t) {
      const resp400 = { error: "Tag inválida" };
      await fastify.audit(req, {
        action: "customer.tags.remove.bad_request",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp400,
      });
      return reply.code(400).send(resp400);
    }

    try {
      const beforeQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags
        WHERE user_id = $1
          AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      const del = await req.db.query(
        `DELETE FROM customer_tags 
        WHERE user_id = $1
          AND flow_id = $2::uuid
          AND tag = $3`,
        [user_id, flowId, t]
      );

      if (del.rowCount === 0) {
        const resp404 = { error: "Tag não encontrada para este cliente" };
        await fastify.audit(req, {
          action: "customer.tags.remove.not_found",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 404,
          beforeData: { tags: beforeTags },
          responseBody: resp404,
          requestBody: { tag: t },
        });
        return reply.code(404).send(resp404);
      }

      const afterQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags
        WHERE user_id = $1
          AND flow_id = $2::uuid`,
        [user_id, flowId]
      );
      const afterTags = afterQ.rows?.[0]?.tags || [];

      await fastify.audit(req, {
        action: "customer.tags.remove",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 204,
        beforeData: { tags: beforeTags },
        afterData: { tags: afterTags },
        requestBody: { tag: t },
      });

      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err }, "Erro em DELETE /clientes/:user_id/tags/:tag");
      const resp500 = { error: "Erro ao remover tag do cliente" };

      await fastify.audit(req, {
        action: "customer.tags.remove.error",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp500,
        extra: { message: err?.message },
      });

      return reply.code(500).send(resp500);
    }
  });
}

export default customersRoutes;
