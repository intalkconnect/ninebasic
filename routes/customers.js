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
  // GET /clientes?page=&page_size=&q=
  fastify.get("/", async (req, reply) => {
    const { q = "", page = 1, page_size = 10 } = req.query || {};

    // page_size permitido: 10,20,30,40
    const allowed = new Set([10, 20, 30, 40]);
    const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
    const pageNum = Math.max(1, Number(page) || 1);
    const offset = (pageNum - 1) * pageSize;

    const paramsWhere = [];
    const where = [];

    if (q) {
      paramsWhere.push(`%${q}%`);
      where.push(`(
        LOWER(COALESCE(c.name,''))    LIKE LOWER($${paramsWhere.length})
        OR LOWER(COALESCE(c.user_id,'')) LIKE LOWER($${paramsWhere.length})
        OR LOWER(COALESCE(c.phone,''))   LIKE LOWER($${paramsWhere.length})
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

  // GET /clientes/:user_id
  fastify.get("/:user_id", async (req, reply) => {
    const { user_id } = req.params;

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
        ON c.user_id = t.user_id AND t.status = 'open'
      WHERE c.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 1
      `,
        [user_id]
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

  // PUT /clientes/:user_id
  fastify.put("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    const { name, phone } = req.body || {};

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
        `SELECT * FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      // atualização
      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET name = $1, phone = $2, updated_at = NOW()
       WHERE user_id = $3
       RETURNING *`,
        [name.trim(), phone.trim(), user_id]
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

  // PATCH /clientes/:user_id
  fastify.patch("/:user_id", async (req, reply) => {
    const { user_id } = req.params;

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
        `SELECT * FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      // monta SET dinamicamente
      const setClauses = Object.keys(updates)
        .map((key, i) => `${key} = $${i + 1}`)
        .join(", ");

      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET ${setClauses}, updated_at = NOW()
       WHERE user_id = $${Object.keys(updates).length + 1}
       RETURNING *`,
        [...Object.values(updates), user_id]
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

  // DELETE /clientes/:user_id
  fastify.delete("/:user_id", async (req, reply) => {
    const { user_id } = req.params;

    try {
      // snapshot "antes" (se existir, útil p/ trilha)
      const beforeQ = await req.db.query(
        `SELECT * FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      const beforeData = beforeQ.rows?.[0] || null;

      const { rowCount } = await req.db.query(
        `DELETE FROM clientes WHERE user_id = $1`,
        [user_id]
      );

      if (rowCount > 0) {
        // 204 – sucesso (sem body)
        await fastify.audit(req, {
          action: "customer.delete",
          resourceType: "customer",
          resourceId: user_id,
          statusCode: 204,
          beforeData,
        });
        return reply.code(204).send();
      }

      // 404 – não encontrado
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

  // GET /clientes/:user_id/tags -> { user_id, tags: [] }
  fastify.get("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply
        .code(400)
        .send({ error: "Formato de user_id inválido. Use: usuario@dominio" });
    }

    try {
      // garante que o cliente existe
      const cRes = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1`,
        [user_id]
      );
      if (cRes.rowCount === 0)
        return reply.code(404).send({ error: "Cliente não encontrado" });

      const { rows } = await req.db.query(
        `SELECT tag FROM customer_tags WHERE user_id = $1 ORDER BY tag ASC`,
        [user_id]
      );
      return reply.send({ user_id, tags: rows.map((r) => r.tag) });
    } catch (err) {
      req.log.error({ err }, "Erro em GET /clientes/:user_id/tags");
      return reply
        .code(500)
        .send({ error: "Erro interno ao listar tags do cliente" });
    }
  });

  // PUT /clientes/:user_id/tags { tags: string[] } -> substitui o conjunto
  fastify.put("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;
    const { tags } = req.body || {};

    // validações iniciais
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

    // normaliza e remove duplicadas
    const norm = [...new Set(tags.map(normalizeTag).filter(Boolean))];

    const client = req.db;
    let inTx = false;
    try {
      // garante cliente existente
      const cRes = await client.query(
        `SELECT 1 FROM clientes WHERE user_id = $1`,
        [user_id]
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

      // snapshot "antes"
      const beforeQ = await client.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags WHERE user_id = $1`,
        [user_id]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      await client.query("BEGIN");
      inTx = true;

      // substitui conjunto
      await client.query(`DELETE FROM customer_tags WHERE user_id = $1`, [
        user_id,
      ]);

      if (norm.length) {
        const values = norm.map((_, i) => `($1, $${i + 2})`).join(", ");
        await client.query(
          `INSERT INTO customer_tags (user_id, tag)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
          [user_id, ...norm]
        );
      }

      await client.query("COMMIT");
      inTx = false;

      const resp200 = { ok: true, user_id, tags: norm };

      // auditoria de sucesso
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

  // POST /clientes/:user_id/tags { tag: string } -> adiciona uma tag
  fastify.post("/:user_id/tags", async (req, reply) => {
    const { user_id } = req.params;
    const { tag } = req.body || {};
    const t = normalizeTag(tag);

    // 400 – user_id inválido
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

    // 400 – tag inválida
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
      // 404 – cliente não existe
      const cRes = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1`,
        [user_id]
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

      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags WHERE user_id = $1`,
        [user_id]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      // upsert simples
      const ins = await req.db.query(
        `INSERT INTO customer_tags (user_id, tag)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
        [user_id, t]
      );

      // snapshot "depois"
      const afterQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags WHERE user_id = $1`,
        [user_id]
      );
      const afterTags = afterQ.rows?.[0]?.tags || [];

      const created = ins.rowCount === 1;
      const resp = { ok: true, user_id, tag: t, created };

      // auditoria de sucesso
      await fastify.audit(req, {
        action: created ? "customer.tags.add" : "customer.tags.add.noop",
        resourceType: "customer",
        resourceId: user_id,
        statusCode: 201, // mantido 201 para compat com seu endpoint atual
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

  // DELETE /clientes/:user_id/tags/:tag -> remove uma tag
  fastify.delete("/:user_id/tags/:tag", async (req, reply) => {
    const { user_id, tag } = req.params;
    const t = normalizeTag(tag);

    // 400 – user_id inválido
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

    // 400 – tag inválida
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
      // snapshot "antes"
      const beforeQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags WHERE user_id = $1`,
        [user_id]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      const del = await req.db.query(
        `DELETE FROM customer_tags WHERE user_id = $1 AND tag = $2`,
        [user_id, t]
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

      // snapshot "depois"
      const afterQ = await req.db.query(
        `SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') AS tags
         FROM customer_tags WHERE user_id = $1`,
        [user_id]
      );
      const afterTags = afterQ.rows?.[0]?.tags || [];

      // auditoria de sucesso (204 sem body)
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
