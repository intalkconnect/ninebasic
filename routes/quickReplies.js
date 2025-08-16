// routes/quickReplies.js
export default async function quickReplyRoutes(fastify) {
  // ➕ Criar nova resposta rápida
  fastify.post('/', async (req, reply) => {
    const { title, content } = req.body || {};
    if (!title || !content) {
      return reply.code(400).send({ error: 'title e content são obrigatórios' });
    }

    try {
      const { rows } = await req.db.query(
        'INSERT INTO quick_replies (title, content) VALUES ($1, $2) RETURNING *',
        [title, content]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar resposta rápida' });
    }
  });

  // 📄 Listar todas as respostas rápidas
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        'SELECT id, title, content FROM quick_replies ORDER BY title'
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar respostas rápidas' });
    }
  });

  // 🗑️ Remover uma resposta rápida
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const { rowCount } = await req.db.query('DELETE FROM quick_replies WHERE id = $1', [id]);
      if (rowCount === 0) return reply.code(404).send({ error: 'Resposta não encontrada' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao deletar resposta' });
    }
  });
}
