async function filaRoutes(fastify, options) {
  // ➕ Criar nova fila
  fastify.post('/', async (req, reply) => {
    const { nome } = req.body;
    if (!nome) return reply.code(400).send({ error: 'Nome da fila é obrigatório' });

    try {
      const { rows } = await req.db.query(
        'INSERT INTO filas (nome) VALUES ($1) RETURNING *',
        [nome]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar fila' });
    }
  });

  // routes/filas.js  (adicione no mesmo arquivo onde já estão as demais rotas de fila)
fastify.get('/atendentes/:fila_nome', async (req, reply) => {
  const { fila_nome } = req.params;

  try {
    const { rows } = await req.db.query(
      `
      SELECT id, name, lastname, email, status
      FROM atendentes
      WHERE $1 = ANY(filas)
        AND status = 'online'
      ORDER BY name, lastname;
      `,
      [fila_nome]
    );

    if (rows.length === 0) {
      return reply.send({
        message: 'Nenhum atendente online ou cadastrado para esta fila.',
        atendentes: []
      });
    }

    return reply.send({ atendentes: rows });
  } catch (err) {
    fastify.log.error(err, 'Erro ao buscar atendentes da fila');
    return reply.code(500).send({ error: 'Erro ao buscar atendentes' });
  }
});



  // 📥 Listar todas as filas
  fastify.get('/', async (_, reply) => {
    try {
      const { rows } = await req.db.query('SELECT * FROM filas ORDER BY nome');
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar filas' });
    }
  });

  // 🔄 Definir permissão de transferência
  fastify.post('/fila-permissoes', async (req, reply) => {
    const { usuario_email, fila_id, pode_transferir } = req.body;
    if (!usuario_email || !fila_id)
      return reply.code(400).send({ error: 'usuario_email e fila_id são obrigatórios' });

    try {
      const { rows } = await req.db.query(
        `
        INSERT INTO fila_permissoes (usuario_email, fila_id, pode_transferir)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_email, fila_id)
        DO UPDATE SET pode_transferir = EXCLUDED.pode_transferir
        RETURNING *
        `,
        [usuario_email, fila_id, pode_transferir ?? false]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao definir permissão' });
    }
  });

  // 👀 Obter as filas que um usuário pode transferir
  fastify.get('/fila-permissoes/:email', async (req, reply) => {
    const { email } = req.params;

    try {
      const { rows } = await req.db.query(
        `
        SELECT f.id, f.nome, p.pode_transferir
        FROM fila_permissoes p
        JOIN filas f ON p.fila_id = f.id
        WHERE p.usuario_email = $1 AND p.pode_transferir = true
        ORDER BY f.nome
        `,
        [email]
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar permissões' });
    }
  });

}

export default filaRoutes;
