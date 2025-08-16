
// routes/chatsRoutes.js
async function chatsRoutes(fastify, options) {
  fastify.get('/', async (req, reply) => {
    const { assigned_to, filas } = req.query;

    if (!assigned_to || !filas) {
      return reply.code(400).send({
        error: 'Parâmetros obrigatórios: assigned_to (email) e filas (CSV)',
      });
    }

    const filaList = filas.split(',').map((f) => f.trim());

    try {
      const { rows } = await req.db.query(
        `
SELECT 
  t.user_id,
  t.ticket_number,
  t.fila,
  f.color AS fila_color,        
  t.assigned_to,
  t.status,
  c.name,
  c.channel,
  c.phone,
  c.atendido,
  m.type AS type,
  m.content AS content,
  m.timestamp AS timestamp
FROM tickets t
JOIN clientes c ON t.user_id = c.user_id
JOIN filas f ON f.nome = t.fila
LEFT JOIN LATERAL (
  SELECT type, content, timestamp
  FROM messages
  WHERE user_id = t.user_id
  ORDER BY timestamp DESC
  LIMIT 1
) m ON true
WHERE t.status = 'open'
  AND t.assigned_to = $1
  AND t.fila = ANY($2)
ORDER BY t.created_at DESC;
        `,
        [assigned_to, filaList]
      );

      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao buscar chats:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar chats',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  fastify.get('/fila', async (req, reply) => {
  const { filas } = req.query;

  if (!filas) {
    return reply.code(400).send({
      error: 'Parâmetro obrigatório: filas (CSV)',
    });
  }

  const filaList = filas.split(',').map((f) => f.trim());

  try {
    const { rows } = await req.db.query(
      `
      SELECT 
        t.id,
        t.user_id,
        t.ticket_number,
        t.fila,
        t.status,
        t.created_at
      FROM tickets t
      WHERE t.status = 'open'
        AND (t.assigned_to IS NULL OR t.assigned_to = '')
        AND t.fila = ANY($1)
      ORDER BY t.created_at ASC
      `,
      [filaList]
    );

    return reply.send(rows);
  } catch (error) {
    fastify.log.error('Erro ao buscar fila:', error);
    return reply.code(500).send({
      error: 'Erro interno ao buscar fila',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

  fastify.put('/fila/proximo', async (req, reply) => {
  const { email, filas } = req.body;

  if (!email || !filas || !Array.isArray(filas)) {
    return reply.code(400).send({ error: 'email e filas[] são obrigatórios' });
  }

  try {
    const { rows } = await req.db.query(
      `
      UPDATE tickets
      SET assigned_to = $1
      WHERE id = (
        SELECT id
        FROM tickets
        WHERE status = 'open'
          AND (assigned_to IS NULL OR assigned_to = '')
          AND fila = ANY($2)
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
      `,
      [email, filas]
    );

    if (rows.length === 0) {
      return reply.code(204).send(); // Sem ticket disponível
    }

    return reply.send(rows[0]);
 } catch (error) {
  fastify.log.error('Erro ao atribuir próximo ticket:', error); // ✅ Agora 'error' existe
  return reply.code(500).send({ error: 'Erro ao atribuir próximo ticket' });
}

});

  
}

export default chatsRoutes;
