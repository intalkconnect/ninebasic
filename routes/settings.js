async function settingsRoutes(fastify, options) {
  // Rota GET /settings - Retorna todas as configurações
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT 
           "key",
           value,
           description,
           created_at,
           updated_at
         FROM settings`
      );

      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao buscar configurações:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao buscar configurações',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota POST /settings - Cria ou atualiza uma configuração
  fastify.post('/', async (req, reply) => {
    const { key, value, description } = req.body;

    if (!key || value === undefined) {
      return reply.code(400).send({ 
        error: 'Campos key e value são obrigatórios' 
      });
    }

    try {
      const { rows } = await req.db.query(
        `INSERT INTO settings ("key", value, description)
         VALUES ($1, $2, $3)
         ON CONFLICT ("key") 
         DO UPDATE SET 
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = NOW()
         RETURNING *`,
        [key, value, description ?? null]
      );

      return reply.code(201).send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao salvar configuração:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao salvar configuração',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

export default settingsRoutes;
