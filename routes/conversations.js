
// routes/chatsRoutes.js

// Helper para descobrir o flow_id do atendente pelo email
async function getAgentFlowId(db, email) {
  const { rows } = await db.query(
    `SELECT flow_id FROM hmg.users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0]?.flow_id || null;
}

async function conversationsRoutes(fastify, options) {
  

  fastify.get('/', async (req, reply) => {
  const { assigned_to, filas } = req.query;

  if (!assigned_to || !filas) {
    return reply.code(400).send({
      error: 'Parâmetros obrigatórios: assigned_to (email) e filas (CSV)',
    });
  }

  const filaList = filas.split(',').map((f) => f.trim()).filter(Boolean);

  try {
    const agentFlowId = await getAgentFlowId(req.db, assigned_to);

    if (!agentFlowId) {
      return reply.code(404).send({
        error: 'Agente não encontrado ou sem flow_id configurado',
      });
    }

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

        lm.type            AS type,
        lm.last_message    AS last_message,
        lm.last_message_at AS last_message_at

      FROM hmg.tickets t
      JOIN hmg.clientes c
        ON c.user_id = t.user_id
      JOIN hmg.filas f
        ON f.nome    = t.fila
       AND f.flow_id = t.flow_id

      -- última mensagem não-system
      LEFT JOIN LATERAL (
        SELECT
          m."type"      AS type,
          m."timestamp" AS last_message_at,
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
          AND m."type" <> 'system'
        ORDER BY m."timestamp" DESC
        LIMIT 1
      ) lm ON TRUE

      WHERE t.status = 'open'
        AND t.assigned_to = $1
        AND t.fila = ANY($2)
        AND t.flow_id = $3::uuid   -- 🔒 garante mesmo flow do atendente

      ORDER BY COALESCE(lm.last_message_at, t.created_at) DESC;
      `,
      [assigned_to, filaList, agentFlowId]
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
  const { filas, email } = req.query;

  if (!email) {
    return reply.code(400).send({
      error: 'Parâmetros obrigatórios: email (atendente)',
    });
  }

  const filaList = filas
    ? filas.split(',').map((f) => f.trim()).filter(Boolean)
    : [];

  try {
    const agentFlowId = await getAgentFlowId(req.db, email);

    if (!agentFlowId) {
      return reply.code(404).send({
        error: 'Agente não encontrado ou sem flow_id configurado',
      });
    }

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
      FROM hmg.tickets t
      WHERE t.status = 'open'
        AND (t.assigned_to IS NULL OR t.assigned_to = '')
        AND t.fila = ANY($1)
        AND t.flow_id = $2::uuid   -- 🔒 só tickets do flow do atendente
      ORDER BY t.created_at ASC
      `,
      [filaList, agentFlowId]
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

  if (!email) {
    return reply.code(400).send({ error: 'email é obrigatório' });
  }

  const queuesArray = Array.isArray(queues)
    ? queues.filter(Boolean)
    : [];

  try {
    const agentFlowId = await getAgentFlowId(req.db, email);

    if (!agentFlowId) {
      return reply.code(404).send({
        error: 'Agente não encontrado ou sem flow_id configurado',
      });
    }

    const { rows } = await req.db.query(
      `
      UPDATE hmg.tickets t
      SET assigned_to = $1
      WHERE t.id = (
        SELECT t2.id
        FROM hmg.tickets t2
        WHERE t2.status = 'open'
          AND (t2.assigned_to IS NULL OR t2.assigned_to = '')
          AND ( $2::text[] IS NULL OR t2.fila = ANY($2) )
          AND t2.flow_id = $3::uuid          -- 🔒 só do flow do agente
        ORDER BY t2.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING t.*;
      `,
      [email, queuesArray.length ? queuesArray : null, agentFlowId]
    );

    if (rows.length === 0) {
      return reply.code(204).send(); // Sem ticket disponível para esse agente/flow
    }

    return reply.send(rows[0]);
  } catch (error) {
    fastify.log.error('Erro ao atribuir próximo ticket:', error);
    return reply
      .code(500)
      .send({ error: 'Erro ao atribuir próximo ticket' });
  }
});
  
}

export default conversationsRoutes;
