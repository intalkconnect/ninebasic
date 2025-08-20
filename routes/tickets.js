import amqplib from 'amqplib';
const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const INCOMING_QUEUE = process.env.INCOMING_QUEUE || 'hmg.incoming';

let amqpConn, amqpChIncoming;
async function ensureAMQPIncoming() {
  if (amqpChIncoming) return amqpChIncoming;
  amqpConn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  amqpConn.on('close', () => { amqpConn = null; amqpChIncoming = null; });
  amqpChIncoming = await amqpConn.createChannel();
  await amqpChIncoming.assertQueue(INCOMING_QUEUE, { durable: true });
  return amqpChIncoming;
}

async function ticketsRoutes(fastify, options) {
  // Validação simples do formato do user_id
  function isValidUserId(user_id) {
    return /^[\w\d]+@[\w\d.-]+$/.test(user_id);
  }

  // GET /tickets/:user_id → Consulta ticket
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({
        error: 'Formato de user_id inválido. Use: usuario@dominio',
      });
    }

    try {
      const { rows } = await req.db.query(
        `SELECT status, fila, assigned_to
         FROM tickets
         WHERE user_id = $1 AND status = 'open'`,
        [user_id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Ticket não encontrado' });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao buscar ticket:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar ticket',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  fastify.get('/user/:user_id', async (req, reply) => {
  const { user_id } = req.params;

  if (!isValidUserId(user_id)) {
    return reply.code(400).send({
      error: 'Formato de user_id inválido. Use: usuario@dominio',
    });
  }

  try {
    const { rows } = await req.db.query(
      `SELECT id, ticket_number, user_id, created_at 
       FROM tickets
       WHERE user_id = $1 AND status = 'closed'
       ORDER BY created_at DESC`,
      [user_id]
    );

    if (rows.length === 0) {
      return reply.code(204).send({ error: 'Nenhum ticket fechado encontrado' });
    }

    return reply.send({ tickets: rows });
  } catch (error) {
    fastify.log.error('Erro ao buscar tickets:', error);
    return reply.code(500).send({
      error: 'Erro interno ao buscar tickets',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// PUT /tickets/:user_id → Finaliza o ÚLTIMO ticket 'open' e publica evento
fastify.put('/:user_id', async (req, reply) => {
  const { user_id } = req.params;
  const { status } = req.body || {};
  const s = String(status || '').toLowerCase();

  if (!isValidUserId(user_id)) {
    return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
  }
  if (s !== 'closed') {
    return reply.code(400).send({ error: "status deve ser 'closed'" });
  }

  try {
    // fecha SOMENTE o último ticket aberto desse usuário
    const { rows } = await req.db.query(
      `
      WITH last_open AS (
        SELECT id
          FROM tickets
         WHERE user_id = $1 AND status = 'open'
         ORDER BY created_at DESC, updated_at DESC, id DESC
         LIMIT 1
      )
      UPDATE tickets t
         SET status = 'closed', updated_at = NOW()
        FROM last_open lo
       WHERE t.id = lo.id
    RETURNING t.ticket_number, t.fila, t.status
      `,
      [user_id]
    );

    const updated = rows?.[0];
    if (!updated) {
      return reply.code(404).send({ error: 'Nenhum ticket aberto encontrado para encerrar' });
    }

    // publica evento para o worker retomar o fluxo
    const ch = await ensureAMQPIncoming();
    ch.sendToQueue(
      INCOMING_QUEUE,
      Buffer.from(JSON.stringify({
        kind: 'system_event',
        event: {
          type: 'ticket_status',
          userId: user_id,                // ex.: 55119...@w.msgcli.net
          status: 'closed',
          ticketNumber: updated.ticket_number, // ← número FINAL
          fila: updated.fila || null
        },
        ts: Date.now()
      })),
      { persistent: true, headers: { 'x-attempts': 0 } }
    );

    return reply.send({ ok: true, ticket: updated });
  } catch (error) {
    fastify.log.error('Erro ao finalizar ticket:', error);
    return reply.code(500).send({
      error: 'Erro interno ao finalizar ticket',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


 fastify.post('/transferir', async (req, reply) => {
  const { from_user_id, to_fila, to_assigned_to, transferido_por } = req.body;

  if (!from_user_id || !to_fila || !transferido_por) {
    return reply.code(400).send({ error: 'Campos obrigatórios: from_user_id, to_fila, transferido_por' });
  }

  const client = await req.db.connect();
  try {
    await client.query('BEGIN');

    // Finaliza o ticket atual
    const update = await client.query(
      `UPDATE tickets
       SET status = 'closed', updated_at = NOW()
       WHERE user_id = $1 AND status = 'open'`,
      [from_user_id]
    );

    if (update.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Ticket atual não encontrado ou já encerrado' });
    }

    // Busca o nome da fila com base no ID recebido
    const filaResult = await client.query(
      `SELECT nome FROM filas WHERE nome = $1`,
      [to_fila]
    );

    if (filaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Fila destino não encontrada' });
    }

    const nomeDaFila = filaResult.rows[0].nome;

    // Cria novo ticket usando a função que gera ticket_number automaticamente
    const result = await client.query(
      `SELECT create_ticket($1, $2, $3) AS ticket_number`,
      [from_user_id, nomeDaFila, to_assigned_to || null]
    );

    const novoTicket = await client.query(
      `SELECT user_id, ticket_number, fila, assigned_to, status
       FROM tickets
       WHERE ticket_number = $1`,
      [result.rows[0].ticket_number]
    );

    await client.query('COMMIT');
    return reply.send({
      sucesso: true,
      novo_ticket: novoTicket.rows[0],
    });

  } catch (err) {
    await client.query('ROLLBACK');
    fastify.log.error({ err, body: req.body }, 'Erro em POST /tickets/transferir');

    return reply.code(500).send({ error: 'Erro ao transferir atendimento' });
  } finally {
    client.release();
  }
});


}

export default ticketsRoutes;
