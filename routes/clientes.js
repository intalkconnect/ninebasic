function isValidUserId(userId) {
  return /^[^@]+@[^@]+\.[^@]+$/.test(userId);
}

async function clientesRoutes(fastify, options) {
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
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
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
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
      });
    }
  });
}

export default clientesRoutes;
