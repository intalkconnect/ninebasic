function isValidUserId(userId) {
  return /^[^@]+@[^@]+\.[^@]+$/.test(userId);
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

    /* =========================
     TAGS DO CLIENTE (clientes)
     ========================= */

  // normalizador/validador de tag (mínimo 1, máximo 40, sem quebras de linha)
  function normalizeTag(raw) {
    if (raw == null) return null;
    const t = String(raw).trim().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t.length > 40) return t.slice(0, 40);
    // evita quebras/controle
    if (/[^\S\r\n]*[\r\n]/.test(t)) return null;
    return t;
  }

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

}

export default customersRoutes;
