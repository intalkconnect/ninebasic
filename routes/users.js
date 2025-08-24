// routes/atendentes.js
async function usersRoutes(fastify, _options) {
  // Listar
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, perfil
           FROM users
           ORDER BY name, lastname`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar atendentes' });
    }
  });

  // Buscar por email
  fastify.get('/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, lastname, email, status, filas, perfil
           FROM users
          WHERE email = $1`,
        [email]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar atendente' });
    }
  });

  // Criar
  fastify.post('/', async (req, reply) => {
    const { name, lastname, email, perfil, filas = [] } = req.body;
    if (!name || !lastname || !email || !perfil) {
      return reply.code(400).send({ error: 'name, lastname, perfil e email são obrigatórios' });
    }

    // ⬇️ só atendente pode ter filas
    const filasToSave = perfil === 'atendente' ? (Array.isArray(filas) ? filas : []) : [];

    try {
      const { rows } = await req.db.query(
        `INSERT INTO users (name, lastname, email, filas, perfil)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, lastname, email, status, filas, perfil`,
        [name, lastname, email, filasToSave, perfil]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar atendente' });
    }
  });

  // Atualizar
  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, perfil, filas } = req.body;
    if (!name || !lastname || !email || !perfil) {
      return reply.code(400).send({ error: 'Campos inválidos' });
    }

    const filasToSave = perfil === 'atendente' ? (Array.isArray(filas) ? filas : []) : [];

    try {
      const { rowCount } = await req.db.query(
        `UPDATE users
            SET name = $1, lastname = $2, email = $3, filas = $4, perfil = $5
          WHERE id = $6`,
        [name, lastname, email, filasToSave, perfil, id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

  // Excluir — bloqueia se houver filas vinculadas
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const check = await req.db.query(`SELECT filas FROM users WHERE id = $1`, [id]);
      if (check.rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      const filas = check.rows[0]?.filas || [];
      if (Array.isArray(filas) && filas.length > 0) {
        return reply.code(409).send({ error: 'Desvincule as filas antes de excluir o usuário.' });
      }

      const { rowCount } = await req.db.query(`DELETE FROM users WHERE id = $1`, [id]);
      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao excluir atendente' });
    }
  });
}

export default usersRoutes;
