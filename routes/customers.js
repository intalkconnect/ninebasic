function isValidUserId(userId) {
  return /^[^@]+@[^@]+\.[^@]+$/.test(userId);
}


  function normalizeTag(raw) {
    if (raw == null) return null;
    const t = String(raw).trim().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t.length > 40) return t.slice(0, 40);

    if (/[^\S\r\n]*[\r\n]/.test(t)) return null;
    return t;
  }

async function customersRoutes(fastify, options) {

  // GET /clientes?page=&page_size=&q=
  fastify.get('/', async (req, reply) => {
    const { q = '', page = 1, page_size = 10 } = req.query || {};

    // page_size permitido: 10,20,30,40
    const allowed = new Set([10, 20, 30, 40]);
    const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
    const pageNum  = Math.max(1, Number(page) || 1);
    const offset   = (pageNum - 1) * pageSize;

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

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sqlCount = `SELECT COUNT(*)::bigint AS total FROM clientes c ${whereSql}`;
    const sqlList  = `
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

      const listRes = await req.db.query(sqlList, [...paramsWhere, pageSize, offset]);
      const data = listRes.rows || [];

      const total_pages = Math.max(1, Math.ceil(total / pageSize));
      return reply.send({ data, page: pageNum, page_size: pageSize, total, total_pages });
    } catch (error) {
      req.log.error('Erro ao listar clientes:', error);
      return reply.code(500).send({ error: 'Erro interno ao listar clientes' });
    }
  });
    
  // GET /clientes/:user_id
  fastify.get('/:user_id', async (req, reply) => {
  const { user_id } = req.params;

  if (!isValidUserId(user_id)) {
    return reply.code(400).send({ 
      error: 'Formato de user_id inválido. Use: usuario@dominio',
      user_id
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
      : reply.code(404).send({ error: 'Cliente não encontrado', user_id });
  } catch (error) {
    fastify.log.error(`Erro ao buscar cliente ${user_id}:`, error);
    return reply.code(500).send({ 
      error: 'Erro interno',
      user_id,
      ...(process.env.NODE_ENV === 'production' && { details: error.message })
    });
  }
});


  // PUT /clientes/:user_id
  fastify.put('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { name, phone } = req.body;

    if (!name?.trim() || !phone?.trim()) {
      return reply.code(400).send({ 
        error: 'Campos name e phone são obrigatórios e não podem ser vazios',
        user_id
      });
    }

    try {
      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET name = $1, phone = $2, updated_at = NOW()
         WHERE user_id = $3
         RETURNING *`,
        [name.trim(), phone.trim(), user_id]
      );

      return rows[0]
        ? reply.send(rows[0])
        : reply.code(404).send({ error: 'Cliente não encontrado', user_id });
    } catch (error) {
      fastify.log.error(`Erro ao atualizar cliente ${user_id}:`, error);
      return reply.code(500).send({
        error: 'Erro na atualização',
        user_id,
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
      });
    }
  });

  // PATCH /clientes/:user_id
  fastify.patch('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const updates = Object.entries(req.body)
      .filter(([key, val]) => ['name', 'phone'].includes(key) && val?.trim())
      .reduce((acc, [key, val]) => ({ ...acc, [key]: val.trim() }), {});

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({
        error: 'Forneça name ou phone válidos para atualização',
        user_id
      });
    }

    try {
      const setClauses = Object.keys(updates)
        .map((key, i) => `${key} = $${i + 1}`)
        .join(', ');

      const { rows } = await req.db.query(
        `UPDATE clientes 
         SET ${setClauses}, updated_at = NOW()
         WHERE user_id = $${Object.keys(updates).length + 1}
         RETURNING *`,
        [...Object.values(updates), user_id]
      );

      return rows[0]
        ? reply.send(rows[0])
        : reply.code(404).send({ error: 'Cliente não encontrado', user_id });
    } catch (error) {
      fastify.log.error(`Erro ao atualizar parcialmente ${user_id}:`, error);
      return reply.code(500).send({
        error: 'Erro na atualização parcial',
        user_id,
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
      });
    }
  });

  // DELETE /clientes/:user_id
  fastify.delete('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM clientes WHERE user_id = $1`,
        [user_id]
      );

      return rowCount > 0
        ? reply.code(204).send() // No Content
        : reply.code(404).send({ error: 'Cliente não encontrado', user_id });
    } catch (error) {
      fastify.log.error(`Erro ao deletar cliente ${user_id}:`, error);
      return reply.code(500).send({
        error: 'Erro ao excluir',
        user_id,
        ...(process.env.NODE_ENV === 'production' && { details: error.message })
      });
    }
  });


  // GET /clientes/:user_id/tags -> { user_id, tags: [] }
  fastify.get('/:user_id/tags', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
    }

    try {
      // garante que o cliente existe
      const cRes = await req.db.query(`SELECT 1 FROM clientes WHERE user_id = $1`, [user_id]);
      if (cRes.rowCount === 0) return reply.code(404).send({ error: 'Cliente não encontrado' });

      const { rows } = await req.db.query(
        `SELECT tag FROM customer_tags WHERE user_id = $1 ORDER BY tag ASC`,
        [user_id]
      );
      return reply.send({ user_id, tags: rows.map(r => r.tag) });
    } catch (err) {
      req.log.error({ err }, 'Erro em GET /clientes/:user_id/tags');
      return reply.code(500).send({ error: 'Erro interno ao listar tags do cliente' });
    }
  });

  // PUT /clientes/:user_id/tags { tags: string[] } -> substitui o conjunto
  fastify.put('/:user_id/tags', async (req, reply) => {
    const { user_id } = req.params;
    const { tags } = req.body || {};

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
    }
    if (!Array.isArray(tags)) {
      return reply.code(400).send({ error: 'Payload inválido. Envie { tags: string[] }' });
    }

    // normaliza e remove duplicadas
    const norm = [...new Set(tags.map(normalizeTag).filter(Boolean))];

    const client = req.db;
    let inTx = false;
    try {
      // garante cliente existente
      const cRes = await client.query(`SELECT 1 FROM clientes WHERE user_id = $1`, [user_id]);
      if (cRes.rowCount === 0) return reply.code(404).send({ error: 'Cliente não encontrado' });

      await client.query('BEGIN'); inTx = true;

      // apaga todas e insere as novas (conjunto substitutivo)
      await client.query(`DELETE FROM customer_tags WHERE user_id = $1`, [user_id]);

      if (norm.length) {
        const values = norm.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO customer_tags (user_id, tag) VALUES ${values} ON CONFLICT DO NOTHING`,
          [user_id, ...norm]
        );
      }

      await client.query('COMMIT'); inTx = false;
      return reply.send({ ok: true, user_id, tags: norm });
    } catch (err) {
      if (inTx) { try { await req.db.query('ROLLBACK'); } catch {} }
      req.log.error({ err }, 'Erro em PUT /clientes/:user_id/tags');
      return reply.code(500).send({ error: 'Erro ao salvar tags do cliente' });
    }
  });

  // POST /clientes/:user_id/tags { tag: string } -> adiciona uma tag
  fastify.post('/:user_id/tags', async (req, reply) => {
    const { user_id } = req.params;
    const { tag } = req.body || {};
    const t = normalizeTag(tag);

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
    }
    if (!t) {
      return reply.code(400).send({ error: 'Tag inválida' });
    }

    try {
      const cRes = await req.db.query(`SELECT 1 FROM clientes WHERE user_id = $1`, [user_id]);
      if (cRes.rowCount === 0) return reply.code(404).send({ error: 'Cliente não encontrado' });

      await req.db.query(
        `INSERT INTO customer_tags (user_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user_id, t]
      );
      return reply.code(201).send({ ok: true, user_id, tag: t });
    } catch (err) {
      req.log.error({ err }, 'Erro em POST /clientes/:user_id/tags');
      return reply.code(500).send({ error: 'Erro ao adicionar tag do cliente' });
    }
  });

  // DELETE /clientes/:user_id/tags/:tag -> remove uma tag
  fastify.delete('/:user_id/tags/:tag', async (req, reply) => {
    const { user_id, tag } = req.params;
    const t = normalizeTag(tag);

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
    }
    if (!t) {
      return reply.code(400).send({ error: 'Tag inválida' });
    }

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM customer_tags WHERE user_id = $1 AND tag = $2`,
        [user_id, t]
      );
      if (rowCount === 0) {
        return reply.code(404).send({ error: 'Tag não encontrada para este cliente' });
      }
      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err }, 'Erro em DELETE /clientes/:user_id/tags/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do cliente' });
    }
  });

  fastify.get('/catalog', async (req, reply) => {
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
  fastify.post('/catalog', async (req, reply) => {
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
  fastify.patch('/catalog/:tag', async (req, reply) => {
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
  fastify.delete('/catalog/:tag', async (req, reply) => {
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
  fastify.get('/:user_id', async (req, reply) => {
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
  fastify.post('/:user_id', async (req, reply) => {
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
  fastify.delete('/:user_id/:tag', async (req, reply) => {
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

export default customersRoutes;
