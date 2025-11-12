
// routes/chatsRoutes.js
async function conversationsRoutes(fastify, options) {
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
  t.flow_id,
  c.name,
  c.channel,
  c.phone,
  c.atendido,

  -- novos campos denormalizados
  lm.type                 AS type,               -- tipo da ÚLTIMA msg (não-system)
  lm.last_message         AS last_message,       -- string já pronta p/ snippet
  lm.last_message_at      AS last_message_at     -- timestamp da última msg

FROM hmg.tickets t
JOIN hmg.clientes c ON c.user_id = t.user_id
JOIN hmg.filas    f ON f.nome    = t.fila

LEFT JOIN LATERAL (
  SELECT
    m."type"        AS type,
    m."timestamp"   AS last_message_at,
    CASE
      WHEN m."type" = 'text'                   THEN m."content"
      WHEN m."type" IN ('image','photo')       THEN '🖼️ Imagem'
      WHEN m."type" IN ('file','document')     THEN '📄 Documento'
      WHEN m."type" IN ('audio','voice')       THEN '🎙️ Áudio'
      WHEN m."type" = 'video'                  THEN '🎬 Vídeo'
      WHEN m."type" = 'template'               THEN '📋 Template'
      WHEN m."type" = 'location'               THEN '📍 Localização'
      ELSE '[mensagem]'
    END AS last_message
  FROM hmg.messages m
  WHERE m.user_id = t.user_id
    AND m."type" <> 'system'               -- ⚠️ ignora mensagens de sistema
  ORDER BY m."timestamp" DESC
  LIMIT 1
) lm ON TRUE

WHERE t.status = 'open'
  AND t.assigned_to = $1
  AND t.fila = ANY($2)

ORDER BY COALESCE(lm.last_message_at, t.created_at) DESC;
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


  fastify.get('/queues', async (req, reply) => {
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
        t.flow_id,
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

  fastify.put('/queues/next', async (req, reply) => {
  const { email, queues } = req.body;

  if (!email || !queues || !Array.isArray(queues)) {
    return reply.code(400).send({ error: 'email e queues[] são obrigatórios' });
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
      [email, queues]
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

export default conversationsRoutes;
