async function atendentesRoutes(fastify, _options) {
  // 🔄 Listar todos os atendentes
  fastify.get('/', async (_, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, created_at FROM atendentes ORDER BY name`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar atendentes' });
    }
  });

  // 🔍 Buscar atendente por ID
  fastify.get('/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, created_at FROM atendentes WHERE email = $1`,
        [email]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar atendente' });
    }
  });

  // ➕ Criar novo atendente
  fastify.post('/', async (req, reply) => {
    const { name, lastname, email, filas = [] } = req.body;

    if (!name || !lastname || !email) {
      return reply.code(400).send({ error: 'name, lastname e email são obrigatórios' });
    }

    try {
      const { rows } = await req.db.query(
        `INSERT INTO atendentes (name, lastname, email, filas)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, lastname, email, status, filas, created_at`,
        [name, lastname, email, filas]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar atendente' });
    }
  });

  // ✏️ Atualizar atendente
  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, filas } = req.body;

    if (!name || !lastname || !email || !Array.isArray(filas)) {
      return reply.code(400).send({ error: 'Campos inválidos' });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET name = $1, lastname = $2, email = $3, filas = $4
         WHERE id = $5`,
        [name, lastname, email, filas, id]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

    // ✏️ Atualizar atendente
  fastify.put('/session/:email', async (req, reply) => {
    const { email } = req.params;
    const { session } = req.body;

    if (!email) {
      return reply.code(400).send({ error: 'Campos inválidos' });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET session_id = $2
         WHERE email = $1`,
        [email, session]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

  // 🗑️ Excluir atendente
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM atendentes WHERE id = $1`,
        [id]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao excluir atendente' });
    }
  });

  // ✅ Atualizar status (online/offline)
  fastify.put('/status/:session', async (req, reply) => {
    const { session } = req.params;

    if (!session) {
      return reply.code(400).send({ error: 'Email e status válidos são obrigatórios' });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
SET session_id = NULL
WHERE session_id = $1;
`,
        [session]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar status do atendente' });
    }
  });
}

export default atendentesRoutes;
