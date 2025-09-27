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
  fastify.get('/customer/catalog', async (req, reply) => {
    const { q = '', active, page = 1, page_size = 20 } = req.query || {};
    const pageNum  = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);
    const offset   = (pageNum - 1) * pageSize;

    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(LOWER(tag) LIKE LOWER($${params.length}) OR LOWER(COALESCE(label,'')) LIKE LOWER($${params.length}))`);
    }
    if (active === 'true' || active === true) {
      where.push(`active IS TRUE`);
    } else if (active === 'false' || active === false) {
      where.push(`active IS FALSE`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sqlCount = `SELECT COUNT(*)::bigint AS total FROM customer_tag_catalog ${whereSql}`;
    const sqlList  = `
      SELECT tag, label, color, active, created_at
        FROM customer_tag_catalog
        ${whereSql}
       ORDER BY tag ASC
       LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    try {
      const rCount = await req.db.query(sqlCount, params);
      const total  = Number(rCount.rows?.[0]?.total || 0);
      const rList  = await req.db.query(sqlList, [...params, pageSize, offset]);
      return reply.send({
        data: rList.rows || [],
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (err) {
      req.log.error({ err }, 'GET /tags/customer/catalog');
      return reply.code(500).send({ error: 'Erro ao listar catálogo de tags de cliente' });
    }
  });

  // POST /tags/customer/catalog  { tag, label?, color?, active? }
  fastify.post('/customer/catalog', async (req, reply) => {
    const { tag, label = null, color = null, active = true } = req.body || {};
    const t = String(tag || '').trim();
    if (!t) return reply.code(400).send({ error: 'tag é obrigatória' });

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
      const { rows } = await req.db.query(sql, [t, label, color, Boolean(active)]);
      return reply.code(201).send(rows[0]);
    } catch (err) {
      req.log.error({ err }, 'POST /tags/customer/catalog');
      return reply.code(500).send({ error: 'Erro ao criar/atualizar tag no catálogo' });
    }
  });

  // PATCH /tags/customer/catalog/:tag   { label?, color?, active? }
  fastify.patch('/customer/catalog/:tag', async (req, reply) => {
    const key = String(req.params?.tag || '').trim();
    if (!key) return reply.code(400).send({ error: 'tag inválida' });

    const allowed = ['label', 'color', 'active'];
    const upd = {};
    for (const k of allowed) {
      if (k in req.body) upd[k] = req.body[k];
    }
    if (!Object.keys(upd).length) {
      return reply.code(400).send({ error: 'Nada para atualizar' });
    }

    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(upd)) {
      sets.push(`${k} = $${i++}`);
      vals.push(k === 'active' ? Boolean(v) : v);
    }
    vals.push(key);

    try {
      const sql = `
        UPDATE customer_tag_catalog
           SET ${sets.join(', ')}
         WHERE tag = $${i}
         RETURNING tag, label, color, active, created_at
      `;
      const { rows } = await req.db.query(sql, vals);
      if (!rows[0]) return reply.code(404).send({ error: 'Tag do catálogo não encontrada' });
      return reply.send(rows[0]);
    } catch (err) {
      req.log.error({ err }, 'PATCH /tags/customer/catalog/:tag');
      return reply.code(500).send({ error: 'Erro ao atualizar tag do catálogo' });
    }
  });

  // DELETE /tags/customer/catalog/:tag
  fastify.delete('/customer/catalog/:tag', async (req, reply) => {
    const key = String(req.params?.tag || '').trim();
    if (!key) return reply.code(400).send({ error: 'tag inválida' });

    try {
      // impede excluir se em uso (opcional; remova se quiser cascata lógica)
      const rUse = await req.db.query(
        `SELECT 1 FROM customer_tags WHERE tag = $1 LIMIT 1`,
        [key]
      );
      if (rUse.rowCount) {
        return reply.code(409).send({ error: 'Tag está em uso por clientes — remova os vínculos antes' });
      }

      const { rowCount } = await req.db.query(
        `DELETE FROM customer_tag_catalog WHERE tag = $1`,
        [key]
      );
      return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Tag não encontrada' });
    } catch (err) {
      req.log.error({ err }, 'DELETE /tags/customer/catalog/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do catálogo' });
    }
  });

  // ============================
  // Vínculo cliente ⇄ tag (customer_tags)
  // ============================

  // GET /tags/customer/:user_id
  fastify.get('/customer/:user_id', async (req, reply) => {
    const { user_id } = req.params || {};
    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido' });
    }
    try {
      // garante que o cliente existe (o DDL não tem FK em user_id)
      const rCli = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      if (!rCli.rowCount) return reply.code(404).send({ error: 'Cliente não encontrado' });

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
      req.log.error({ err }, 'GET /tags/customer/:user_id');
      return reply.code(500).send({ error: 'Erro ao listar tags do cliente' });
    }
  });

  // POST /tags/customer/:user_id  { tags: ["vip","inadimplente"] }
  fastify.post('/customer/:user_id', async (req, reply) => {
    const { user_id } = req.params || {};
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(x => String(x).trim()).filter(Boolean) : [];
    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido' });
    }
    if (!tags.length) return reply.code(400).send({ error: 'tags é obrigatório (array não-vazio)' });

    try {
      const rCli = await req.db.query(
        `SELECT 1 FROM clientes WHERE user_id = $1 LIMIT 1`,
        [user_id]
      );
      if (!rCli.rowCount) return reply.code(404).send({ error: 'Cliente não encontrado' });

      // garante que existem no catálogo
      const rKnown = await req.db.query(
        `SELECT tag FROM customer_tag_catalog WHERE tag = ANY($1::text[]) AND active IS TRUE`,
        [tags]
      );
      const known = new Set((rKnown.rows || []).map(r => r.tag));
      const unknown = tags.filter(t => !known.has(t));
      if (unknown.length) {
        return reply.code(400).send({ error: 'Tags inexistentes ou inativas no catálogo', unknown });
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
        VALUES ${values.join(', ')}
        ON CONFLICT (user_id, tag) DO NOTHING
        RETURNING user_id, tag, created_at
      `;
      const { rows } = await req.db.query(sql, params);
      return reply.code(201).send({ added: rows.length, items: rows });
    } catch (err) {
      req.log.error({ err }, 'POST /tags/customer/:user_id');
      return reply.code(500).send({ error: 'Erro ao vincular tags ao cliente' });
    }
  });

  // DELETE /tags/customer/:user_id/:tag
  fastify.delete('/customer/:user_id/:tag', async (req, reply) => {
    const { user_id, tag } = req.params || {};
    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido' });
    }
    const t = String(tag || '').trim();
    if (!t) return reply.code(400).send({ error: 'tag inválida' });

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM customer_tags WHERE user_id = $1 AND tag = $2`,
        [user_id, t]
      );
      return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Vínculo não encontrado' });
    } catch (err) {
      req.log.error({ err }, 'DELETE /tags/customer/:user_id/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do cliente' });
    }
  });
}

export default customerTagsRoutes;
