async function pausasRoutes(fastify) {
  // Listar motivos ativos
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT *
           FROM pause_reasons
          WHERE active = TRUE
          ORDER BY label`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err, '[pausas] erro ao listar');
      return reply.code(500).send({ error: 'Erro ao listar motivos de pausa' });
    }
  });

  // (Opcional) CRUD admin: criar/editar/inativar motivo
  // fastify.post('/', ...) / fastify.put('/:id', ...) / fastify.delete('/:id', ...)
}

export default pausasRoutes;
