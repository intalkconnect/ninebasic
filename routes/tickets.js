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

  // DENTRO de ticketsRoutes(fastify, options), ANTES da rota '/:user_id'

/**
 * GET /tickets/:id?include=messages&messages_limit=100
 * - :id deve ser numérico (id da tabela tickets)
 * - include=messages (opcional) para anexar o array de mensagens do hmg.messages
 * - messages_limit (1..500, default 100)
 */
fastify.get('/:id', async (req, reply) => {
  const { id } = req.params || {};
  const { include, messages_limit } = req.query || {};

  // Garante que esta rota só atende números e deixa '/:user_id' cuidar do restante
  if (!/^\d+$/.test(String(id))) {
    return reply.callNotFound();
  }

  const limit = Math.min(Math.max(parseInt(messages_limit || '100', 10) || 100, 1), 500);
  const withMessages = String(include || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('messages');

  try {
    // 1) Busca o ticket por ID
    const tRes = await req.db.query(
      `
      SELECT
        t.id,
        t.ticket_number,
        t.user_id,
        t.fila,
        t.assigned_to,
        t.status,
        t.created_at,
        t.updated_at,
        t.closed_at
      FROM tickets t
      WHERE t.id = $1
      `,
      [Number(id)]
    );

    if (tRes.rowCount === 0) {
      return reply.code(404).send({ error: 'Ticket não encontrado' });
    }
    const ticket = tRes.rows[0];

    // 2) (opcional) inclui mensagens pelo ticket_number
    if (withMessages && ticket.ticket_number) {
      const mRes = await req.db.query(
        `
        SELECT
          m.id,
          m.user_id,
          m.message_id,
          m.direction,
          m."type",
          m."content",
          m."timestamp",
          m.channel,
          m.ticket_number,
          m.assigned_to
        FROM messages m
        WHERE m.ticket_number = $1
        ORDER BY m."timestamp" ASC, m.id ASC
        LIMIT $2
        `,
        [String(ticket.ticket_number), limit]
      );

      // 3) mapeia para o formato esperado pelo front (minimalista)
      const mapped = (mRes.rows || []).map((m) => {
        const dir = String(m.direction || '').toLowerCase();
        const fromAgent = dir === 'outgoing' || dir === 'system';
        const sender =
          dir === 'outgoing'
            ? (m.assigned_to || ticket.assigned_to || 'Atendente')
            : dir === 'system'
            ? 'Sistema'
            : 'Cliente';

        return {
          id: m.id,                              // uuid
          direction: dir,                        // 'incoming' | 'outgoing' | 'system'
          type: m.type,                          // ex.: 'text'
          text: m.content,                       // seu esquema usa 'content' (text)
          created_at: m.timestamp,               // timestamptz
          channel: m.channel,
          message_id: m.message_id,
          ticket_number: m.ticket_number,
          from_agent: fromAgent,
          sender_name: sender,
        };
      });

      ticket.messages = mapped;
    }

    return reply.send(ticket);
  } catch (err) {
    req.log.error({ err }, 'Erro em GET /tickets/:id (com messages)');
    return reply.code(500).send({
      error: 'Erro interno ao buscar ticket',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});


  // GET /tickets/last/:user_id → retorna o ticket mais recente do usuário
fastify.get('/last/:user_id', async (req, reply) => {
  const { user_id } = req.params;

  // reutiliza seu validador existente
  if (!isValidUserId(user_id)) {
    return reply.code(400).send({
      error: 'Formato de user_id inválido. Use: usuario@dominio',
    });
  }

  try {
    const { rows } = await req.db.query(
      `
      SELECT
        id,
        ticket_number,
        user_id,
        fila,
        assigned_to,
        status,
        created_at,
        updated_at,
        COALESCE(updated_at, created_at) AS last_activity_at
      FROM tickets
      WHERE user_id = $1
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Ticket não encontrado' });
    }

    return reply.send(rows[0]);
  } catch (error) {
    fastify.log.error('Erro ao buscar último ticket:', error);
    return reply.code(500).send({ error: 'Erro interno ao buscar último ticket' });
  }
});


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

  // GET /tickets/history?page=&page_size=&q=&from=&to=
// Lista tickets com status 'closed' com busca e filtro por data (fechamento).
fastify.get('/history', async (req, reply) => {
  const { q = '', page = 1, page_size = 10, from = '', to = '' } = req.query || {};

  const allowed = new Set([10, 20, 30, 40]);
  const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
  const pageNum  = Math.max(1, Number(page) || 1);
  const offset   = (pageNum - 1) * pageSize;

  const where = [`status = 'closed'`];
  const params = [];

  // Busca fulltext simples
  if (q) {
    params.push(`%${q}%`);
    where.push(`(
      LOWER(COALESCE(ticket_number::text,'')) LIKE LOWER($${params.length})
      OR LOWER(COALESCE(user_id,''))          LIKE LOWER($${params.length})
      OR LOWER(COALESCE(fila,''))             LIKE LOWER($${params.length})
      OR LOWER(COALESCE(assigned_to,''))      LIKE LOWER($${params.length})
    )`);
  }

  // Filtro de data pelo momento do fechamento (updated_at)
  // Aceita from/to como YYYY-MM-DD (timezone do DB)
  let fromIdx, toIdx;
  if (from) {
    params.push(from + ' 00:00:00');
    fromIdx = params.length;
    where.push(`updated_at >= $${fromIdx}`);
  }
  if (to) {
    params.push(to + ' 23:59:59.999');
    toIdx = params.length;
    where.push(`updated_at <= $${toIdx}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sqlCount = `SELECT COUNT(*)::bigint AS total FROM tickets ${whereSql}`;
  const sqlList  = `
    SELECT
      id,
      ticket_number,
      user_id,
      fila,
      assigned_to,
      created_at,
      updated_at
    FROM tickets
    ${whereSql}
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  try {
    const rCount = await req.db.query(sqlCount, params);
    const total = Number(rCount.rows?.[0]?.total || 0);

    const rList = await req.db.query(sqlList, [...params, pageSize, offset]);
    const data = rList.rows || [];

    return reply.send({
      data,
      page: pageNum,
      page_size: pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    req.log.error('Erro em GET /tickets/history:', err);
    return reply.code(500).send({ error: 'Erro interno ao listar histórico' });
  }
});


}

export default ticketsRoutes;
