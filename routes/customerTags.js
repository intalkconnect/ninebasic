// routes/customerTags.js
/**
 * Endpoints:
 * - GET    /tags/customer/catalog            → lista catálogo de tags de cliente
 * - POST   /tags/customer/catalog            → cria/ativa/atualiza (upsert) tag no catálogo
 * - PATCH  /tags/customer/catalog/:tag       → atualiza label/color/active
 * - DELETE /tags/customer/catalog/:tag       → remove do catálogo (se não estiver em uso)
 *
 * - GET    /tags/customer/:user_id           → lista tags do cliente
 * - POST   /tags/customer/:user_id           → adiciona 1..N tags ao cliente
 * - DELETE /tags/customer/:user_id/:tag      → remove 1 tag do cliente
 */

function isValidUserId(user_id) {
  // mesmo critério dos tickets (aceita "coisa@dominio")
  return /^[\w\d]+@[\w\d.-]+$/.test(String(user_id));
}

async function customerTagsRoutes(fastify) {
  // ============================
  // Catálogo (customer_tag_catalog)
  // ============================

  // GET /tags/customer/catalog?q=&active=true|false&page=1&page_size=20
  fastify.get("/customer/catalog", async (req, reply) => {
    const { q = "", active, page = 1, page_size = 20 } = req.query || {};
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);
    const offset = (pageNum - 1) * pageSize;

    const where = [];
    const params = [];

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
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sqlCount = `SELECT COUNT(*)::bigint AS total FROM customer_tag_catalog ${whereSql}`;
    const sqlList = `
      SELECT tag, label, color, active, created_at
        FROM customer_tag_catalog
        ${whereSql}
       ORDER BY tag ASC
       LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    try {
      const rCount = await req.db.query(sqlCount, params);
      const total = Number(rCount.rows?.[0]?.total || 0);
      const rList = await req.db.query(sqlList, [...params, pageSize, offset]);
      return reply.send({
        data: rList.rows || [],
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (err) {
      req.log.error({ err }, "GET /tags/customer/catalog");
      return reply
        .code(500)
        .send({ error: "Erro ao listar catálogo de tags de cliente" });
    }
  });

  // POST /tags/customer/catalog  { tag, label?, color?, active? }
  fastify.post("/customer/catalog", async (req, reply) => {
    const { tag, label = null, color = null, active = true } = req.body || {};
    const t = String(tag || "").trim();

    if (!t) {
      const resp = { error: "tag é obrigatória" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.bad_request",
        resourceType: "customer_tag",
        statusCode: 400,
        requestBody: { tag, label, color, active },
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    try {
      const sql = `
      INSERT INTO customer_tag_catalog (tag, label, color, active)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tag) DO UPDATE
        SET label = EXCLUDED.label,
            color = EXCLUDED.color,
            active = EXCLUDED.active
      RETURNING tag, label, color, active, created_at
    `;
      const { rows } = await req.db.query(sql, [
        t,
        label,
        color,
        Boolean(active),
      ]);
      const resp = rows[0];

      await fastify.audit(req, {
        action: "tags.customer.catalog.upsert",
        resourceType: "customer_tag",
        resourceId: t,
        statusCode: 201,
        requestBody: { tag: t, label, color, active: Boolean(active) },
        afterData: resp,
        responseBody: resp,
      });

      return reply.code(201).send(resp);
    } catch (err) {
      req.log.error({ err }, "POST /tags/customer/catalog");

      const resp = { error: "Erro ao criar/atualizar tag no catálogo" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.error",
        resourceType: "customer_tag",
        resourceId: t || null,
        statusCode: 500,
        requestBody: { tag: t || tag, label, color, active },
        responseBody: resp,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // PATCH /tags/customer/catalog/:tag   { label?, color?, active? }
  fastify.patch("/customer/catalog/:tag", async (req, reply) => {
    const key = String(req.params?.tag || "").trim();
    if (!key) {
      const resp = { error: "tag inválida" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.bad_request",
        resourceType: "customer_tag",
        statusCode: 400,
        requestBody: req.body || null,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    const allowed = ["label", "color", "active"];
    const upd = {};
    for (const k of allowed) {
      if (k in (req.body || {})) upd[k] = req.body[k];
    }
    if (!Object.keys(upd).length) {
      const resp = { error: "Nada para atualizar" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.bad_request",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 400,
        requestBody: req.body || null,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    // captura estado "antes"
    const beforeSql = `
    SELECT tag, label, color, active, created_at
      FROM customer_tag_catalog
     WHERE tag = $1
     LIMIT 1
  `;
    const beforeRes = await req.db.query(beforeSql, [key]);
    const before = beforeRes.rows[0] || null;
    if (!before) {
      const resp = { error: "Tag do catálogo não encontrada" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.not_found",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 404,
        requestBody: req.body || null,
        responseBody: resp,
      });
      return reply.code(404).send(resp);
    }

    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(upd)) {
      sets.push(`${k} = $${i++}`);
      vals.push(k === "active" ? Boolean(v) : v);
    }
    vals.push(key);

    try {
      const sql = `
      UPDATE customer_tag_catalog
         SET ${sets.join(", ")}
       WHERE tag = $${i}
       RETURNING tag, label, color, active, created_at
    `;
      const { rows } = await req.db.query(sql, vals);
      const after = rows[0];

      await fastify.audit(req, {
        action: "tags.customer.catalog.update",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 200,
        requestBody: req.body || null,
        beforeData: before,
        afterData: after,
        responseBody: after,
      });

      return reply.send(after);
    } catch (err) {
      req.log.error({ err }, "PATCH /tags/customer/catalog/:tag");
      const resp = { error: "Erro ao atualizar tag do catálogo" };

      await fastify.audit(req, {
        action: "tags.customer.catalog.error",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 500,
        requestBody: req.body || null,
        responseBody: resp,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // DELETE /tags/customer/catalog/:tag?dry_run=true|false
  fastify.delete("/customer/catalog/:tag", async (req, reply) => {
    const key = String(req.params?.tag || "").trim();
    const { dry_run = "false" } = req.query || {};
    const isDry = String(dry_run).toLowerCase() === "true";

    if (!key) {
      const resp = { error: "tag inválida" };
      await fastify.audit(req, {
        action: "tags.customer.catalog.bad_request",
        resourceType: "customer_tag",
        statusCode: 400,
        requestBody: null,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    try {
      // Busca "antes" (para auditoria) + existência
      const beforeSql = `
      SELECT tag, label, color, active, created_at
        FROM customer_tag_catalog
       WHERE tag = $1
       LIMIT 1
    `;
      const beforeRes = await req.db.query(beforeSql, [key]);
      const before = beforeRes.rows[0] || null;

      if (!before) {
        const resp = { error: "Tag não encontrada no catálogo" };
        await fastify.audit(req, {
          action: "tags.customer.catalog.not_found",
          resourceType: "customer_tag",
          resourceId: key,
          statusCode: 404,
          responseBody: resp,
        });
        return reply.code(404).send(resp);
      }

      // Contagem de vínculos (para dry-run e para registrar no "antes")
      const c1 = await req.db.query(
        "SELECT COUNT(*)::bigint AS n FROM customer_tags WHERE tag = $1",
        [key]
      );
      const linkedCount = Number(c1.rows?.[0]?.n || 0);

      if (isDry) {
        const resp = {
          tag: key,
          would_remove_from_customers: linkedCount,
          would_remove_from_catalog: 1,
        };

        await fastify.audit(req, {
          action: "tags.customer.catalog.delete.dry_run",
          resourceType: "customer_tag",
          resourceId: key,
          statusCode: 200,
          beforeData: { ...before, linked_count: linkedCount },
          responseBody: resp,
        });

        return reply.send(resp);
      }

      // Remoção em cascata (atômica)
      const sql = `
      WITH del_links AS (
        DELETE FROM customer_tags WHERE tag = $1
        RETURNING 1
      ),
      del_cat AS (
        DELETE FROM customer_tag_catalog WHERE tag = $1
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*)::int FROM del_links) AS removed_from_customers,
        (SELECT COUNT(*)::int FROM del_cat)   AS removed_from_catalog
    `;
      const { rows } = await req.db.query(sql, [key]);
      const res = rows?.[0] || {
        removed_from_customers: 0,
        removed_from_catalog: 0,
      };

      if (!res.removed_from_catalog) {
        const resp = { error: "Tag não encontrada (já removida?)" };
        await fastify.audit(req, {
          action: "tags.customer.catalog.not_found",
          resourceType: "customer_tag",
          resourceId: key,
          statusCode: 404,
          beforeData: { ...before, linked_count: linkedCount },
          responseBody: resp,
        });
        return reply.code(404).send(resp);
      }

      const resp = { tag: key, ...res };

      await fastify.audit(req, {
        action: "tags.customer.catalog.delete",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 200,
        beforeData: { ...before, linked_count: linkedCount },
        afterData: null,
        responseBody: resp,
      });

      return reply.send(resp);
    } catch (err) {
      req.log.error(
        { err },
        "DELETE /tags/customer/catalog/:tag (cte-cascade)"
      );
      const resp = { error: "Erro ao remover tag do catálogo (cascade)" };

      await fastify.audit(req, {
        action: "tags.customer.catalog.error",
        resourceType: "customer_tag",
        resourceId: key,
        statusCode: 500,
        responseBody: resp,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // ============================
  // Vínculo cliente ⇄ tag (customer_tags)
  // ============================

  // GET /tags/customer/:user_id
  fastify.get("/customer/:user_id", async (req, reply) => {
    const { user_id } = req.params || {};
    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: "Formato de user_id inválido" });
    }
    try {
      // garante que o cliente existe (o DDL não tem FK em user_id)
      const rCli = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      if (!rCli.rowCount)
        return reply.code(404).send({ error: "Cliente não encontrado" });

      const sql = `
        SELECT ct.tag, ctc.label, ctc.color, ctc.active, ct.created_at
          FROM customer_tags ct
          LEFT JOIN customer_tag_catalog ctc ON ctc.tag = ct.tag
         WHERE ct.user_id = $1
         ORDER BY ct.tag ASC
      `;
      const { rows } = await req.db.query(sql, [user_id]);
      return reply.send({ user_id, tags: rows || [] });
    } catch (err) {
      req.log.error({ err }, "GET /tags/customer/:user_id");
      return reply.code(500).send({ error: "Erro ao listar tags do cliente" });
    }
  });

  // POST /tags/customer/:user_id  { tags: ["vip","inadimplente"] }
  fastify.post("/customer/:user_id", async (req, reply) => {
    const { user_id } = req.params || {};
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((x) => String(x).trim()).filter(Boolean)
      : [];

    // 400 – user_id inválido
    if (!isValidUserId(user_id)) {
      const resp = { error: "Formato de user_id inválido" };
      await fastify.audit(req, {
        action: "tags.customer.attach.bad_request",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
        extra: { requested_tags: tags },
      });
      return reply.code(400).send(resp);
    }

    // 400 – array vazio
    if (!tags.length) {
      const resp = { error: "tags é obrigatório (array não-vazio)" };
      await fastify.audit(req, {
        action: "tags.customer.attach.bad_request",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    try {
      // 404 – cliente não existe
      const rCli = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      if (!rCli.rowCount) {
        const resp = { error: "Cliente não encontrado" };
        await fastify.audit(req, {
          action: "tags.customer.attach.not_found",
          resourceType: "customer_tag_link",
          resourceId: user_id,
          statusCode: 404,
          responseBody: resp,
        });
        return reply.code(404).send(resp);
      }

      // estado "antes" (tags já vinculadas) – para auditoria
      const beforeQ = await req.db.query(
        `SELECT ARRAY(
         SELECT tag FROM customer_tags WHERE user_id = $1 ORDER BY tag
       ) AS tags`,
        [user_id]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      // valida catálogo
      const rKnown = await req.db.query(
        `SELECT tag
         FROM customer_tag_catalog
        WHERE tag = ANY($1::text[]) AND active IS TRUE`,
        [tags]
      );
      const known = new Set((rKnown.rows || []).map((r) => r.tag));
      const unknown = tags.filter((t) => !known.has(t));
      if (unknown.length) {
        const resp = {
          error: "Tags inexistentes ou inativas no catálogo",
          unknown,
        };
        await fastify.audit(req, {
          action: "tags.customer.attach.unknown",
          resourceType: "customer_tag_link",
          resourceId: user_id,
          statusCode: 400,
          responseBody: resp,
          extra: { requested_tags: tags },
        });
        return reply.code(400).send(resp);
      }

      // upserts
      const values = [];
      const params = [];
      let i = 1;
      for (const t of tags) {
        params.push(user_id, t);
        values.push(`($${i++}, $${i++})`);
      }
      const sql = `
      INSERT INTO customer_tags (user_id, tag)
      VALUES ${values.join(", ")}
      ON CONFLICT (user_id, tag) DO NOTHING
      RETURNING user_id, tag, created_at
    `;
      const { rows } = await req.db.query(sql, params);

      const resp = { added: rows.length, items: rows };

      await fastify.audit(req, {
        action: "tags.customer.attach",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 201,
        beforeData: { tags: beforeTags },
        afterData: resp, // o que foi realmente inserido
        responseBody: resp,
        extra: { requested_tags: tags },
      });

      return reply.code(201).send(resp);
    } catch (err) {
      req.log.error({ err }, "POST /tags/customer/:user_id");
      const resp = { error: "Erro ao vincular tags ao cliente" };

      await fastify.audit(req, {
        action: "tags.customer.attach.error",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp,
        extra: { message: err.message },
      });

      return reply.code(500).send(resp);
    }
  });

  // DELETE /tags/customer/:user_id/:tag
  fastify.delete("/customer/:user_id/:tag", async (req, reply) => {
    const { user_id, tag } = req.params || {};

    // 400 – user_id inválido
    if (!isValidUserId(user_id)) {
      const resp = { error: "Formato de user_id inválido" };
      await fastify.audit(req, {
        action: "tags.customer.detach.bad_request",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
        extra: { tag },
      });
      return reply.code(400).send(resp);
    }

    // 400 – tag vazia
    const t = String(tag || "").trim();
    if (!t) {
      const resp = { error: "tag inválida" };
      await fastify.audit(req, {
        action: "tags.customer.detach.bad_request",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 400,
        responseBody: resp,
      });
      return reply.code(400).send(resp);
    }

    try {
      // capture "before" (se quiser o snapshot completo de tags do cliente)
      const beforeQ = await req.db.query(
        `SELECT ARRAY(SELECT tag FROM customer_tags WHERE user_id = $1 ORDER BY tag) AS tags`,
        [user_id]
      );
      const beforeTags = beforeQ.rows?.[0]?.tags || [];

      // delete com RETURNING para sabermos o que foi removido
      const del = await req.db.query(
        `DELETE FROM customer_tags
        WHERE user_id = $1 AND tag = $2
        RETURNING user_id, tag, created_at`,
        [user_id, t]
      );

      if (!del.rowCount) {
        const resp = { error: "Vínculo não encontrado" };
        await fastify.audit(req, {
          action: "tags.customer.detach.not_found",
          resourceType: "customer_tag_link",
          resourceId: user_id,
          statusCode: 404,
          responseBody: resp,
          extra: { tag: t, beforeTags },
        });
        return reply.code(404).send(resp);
      }

      const removed = del.rows[0];

      await fastify.audit(req, {
        action: "tags.customer.detach",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 204,
        beforeData: { tags: beforeTags },
        afterData: { removed }, // o vínculo removido
        // 204 → sem body na resposta
        extra: { tag: t },
      });

      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err }, "DELETE /tags/customer/:user_id/:tag");
      const resp = { error: "Erro ao remover tag do cliente" };

      await fastify.audit(req, {
        action: "tags.customer.detach.error",
        resourceType: "customer_tag_link",
        resourceId: user_id,
        statusCode: 500,
        responseBody: resp,
        extra: { tag: t, message: err.message },
      });

      return reply.code(500).send(resp);
    }
  });
}

export default customerTagsRoutes;
