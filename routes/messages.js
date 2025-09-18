// routes/messages.js
import amqplib from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const OUTGOING_QUEUE = process.env.OUTGOING_QUEUE || 'hmg.outgoing';

let amqpConn, amqpCh;
async function ensureAMQP() {
  if (amqpCh) return amqpCh;
  amqpConn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  amqpConn.on('close', () => { amqpConn = null; amqpCh = null; });
  amqpCh = await amqpConn.createChannel();
  await amqpCh.assertQueue(OUTGOING_QUEUE, { durable: true });
  return amqpCh;
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// valida payload
function validateContent(type, content, channel) {
  if (!type) throw new Error('Message type is required');
  if (type === 'text') {
    if (!content || typeof content.body !== 'string' || !content.body.trim()) {
      throw new Error('Message text cannot be empty');
    }
    return;
  }
  if (!content || !content.url || typeof content.url !== 'string') {
    throw new Error(`Media URL is required for type "${type}" on channel "${channel}"`);
  }
}

function formatUserId(to, channel = 'whatsapp') {
  return channel === 'telegram' ? `${to}@t.msgcli.net` : `${to}@w.msgcli.net`;
}

// checagem 24h usando o DB do tenant
async function within24h(db, userId) {
  const { rows } = await db.query(
    `SELECT "timestamp"
       FROM messages
      WHERE user_id = $1 AND direction = 'incoming'
      ORDER BY "timestamp" DESC
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) return true;
  const diffH = (Date.now() - new Date(rows[0].timestamp).getTime()) / 36e5;
  return diffH <= 24;
}

export default async function messagesRoutes(fastify) {
  fastify.log.info('[messages] registrando rotas');

  // ===================== ENVIO =====================

  // POST /api/v1/messages/send
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context, channel = 'whatsapp' } = req.body || {};
    if (!to || !type) return reply.code(400).send({ error: 'Recipient and type are required' });
    validateContent(type, content, channel);

    const userId = formatUserId(to, channel);

    // 24h apenas p/ WhatsApp
    if (channel === 'whatsapp') {
      const ok = await within24h(req.db, userId);
      if (!ok) {
        return reply.code(400).send({ error: 'Outside 24h window. Use an approved template.' });
      }
    }

    const tempId = uuidv4();
    const dbContent = type === 'text' ? content.body : JSON.stringify(content);

    const { rows } = await req.db.query(
      `INSERT INTO messages (
         user_id, message_id, direction, "type", "content", "timestamp",
         flow_id, reply_to, status, metadata, created_at, updated_at, channel
       ) VALUES ($1,$2,'outgoing',$3,$4,NOW(),
                 NULL, $5, 'pending', NULL, NOW(), NOW(), $6)
       RETURNING *`,
      [userId, tempId, type, dbContent, context?.message_id || null, channel]
    );
    const pending = rows[0];

    const ch = await ensureAMQP();
    ch.sendToQueue(
      OUTGOING_QUEUE,
      Buffer.from(JSON.stringify({
        tempId,
        channel,
        to,
        userId,
        type,
        content,
        context
      })),
      { persistent: true, headers: { 'x-attempts': 0 } }
    );

    // emit opcional (se existir socket na app)
    try {
      fastify.io?.to(`chat-${userId}`).emit('new_message', pending);
      fastify.io?.emit('new_message', pending);
    } catch {}

    return reply.send({ success: true, enqueued: true, message: pending, channel });
  });

 // POST /api/v1/messages/send/template
fastify.post('/send/template', async (req, reply) => {
  // Suporta ambos formatos:
  // Novo (WABA): { to, template: { name, language: { code }, components? } }
  // Antigo:      { to, templateName, languageCode, components? }
  const { to } = req.body || {};
  let { template } = req.body || {};

  // Retrocompat: mapear antigo -> novo
  if (!template) {
    const { templateName, languageCode, components } = req.body || {};
    if (templateName && languageCode) {
      template = {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {})
      };
    }
  }

  // Validação
  if (!to) {
    return reply.code(400).send({ error: 'to é obrigatório' });
  }
  if (!template || typeof template !== 'object') {
    return reply.code(400).send({ error: 'template é obrigatório' });
  }
  if (!template.name || !template.language || !template.language.code) {
    return reply.code(400).send({
      error: 'template.name e template.language.code são obrigatórios'
    });
  }
  if (template.components && !Array.isArray(template.components)) {
    return reply.code(400).send({
      error: 'template.components, se fornecido, deve ser um array'
    });
  }

  const channel = 'whatsapp';
  const userId = formatUserId(to, channel);
  const tempId = uuidv4();

  // Guardar o nome do template em content e o resto em metadata
  const content = template.name;
  const metaObj = {
    languageCode: template.language.code,
    components: template.components || null
  };
  const meta = JSON.stringify(metaObj);

  const { rows } = await req.db.query(
    `INSERT INTO messages (
       user_id, message_id, direction, "type", "content",
       "timestamp", status, metadata, created_at, updated_at, channel
     ) VALUES ($1,$2,'outgoing','template',$3,
               NOW(),'pending',$4,NOW(),NOW(),$5)
     RETURNING *`,
    [userId, tempId, content, meta, channel]
  );
  const pending = rows[0];

  const ch = await ensureAMQP();
  ch.sendToQueue(
    OUTGOING_QUEUE,
    Buffer.from(JSON.stringify({
      tempId,
      channel: 'whatsapp',
      to,
      type: 'template',
      // Enviar já no formato correto que o worker publicará no WABA:
      template: {
        name: template.name,
        language: { code: template.language.code },
        ...(template.components ? { components: template.components } : {})
      }
    })),
    { persistent: true, headers: { 'x-attempts': 0 } }
  );

  try {
    fastify.io?.to(`chat-${userId}`).emit('new_message', pending);
    fastify.io?.emit('new_message', pending);
  } catch {}

  return reply.send({ success: true, enqueued: true, message: pending, channel });
});


  // ===================== STATUS / CONTAGEM =====================

  // GET /api/v1/messages/check-24h/:user_id
  fastify.get('/check-24h/:user_id', async (req) => {
    const userId = decode(req.params.user_id);
    const ok = await within24h(req.db, userId);
    return { within24h: ok, can_send_freeform: ok };
  });

  // PUT /api/v1/messages/read-status/:user_id
  fastify.put('/read-status/:user_id', async (req, reply) => {
    const userId = decode(req.params.user_id);
    const { last_read } = req.body || {};
    if (!last_read) return reply.code(400).send({ error: 'last_read é obrigatório' });

    const { rows } = await req.db.query(
      `INSERT INTO user_last_read (user_id, last_read)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET last_read = EXCLUDED.last_read
       RETURNING user_id, last_read;`,
      [userId, last_read]
    );
    return rows[0];
  });

  // GET /api/v1/messages/read-status
  fastify.get('/read-status', async (req) => {
    const { rows } = await req.db.query(
      `SELECT user_id, last_read FROM user_last_read`
    );
    return rows;
  });

  // GET /api/v1/messages/unread-counts
  fastify.get('/unread-counts', async (req) => {
    const { rows } = await req.db.query(
      `
      SELECT 
        m.user_id,
        COUNT(*)::int AS unread_count
      FROM messages m
      LEFT JOIN user_last_read r ON m.user_id = r.user_id
      WHERE 
        m.direction = 'incoming'
        AND m.created_at > COALESCE(r.last_read, '1970-01-01')
      GROUP BY m.user_id
      `
    );
    return rows;
  });

  // ===================== LISTAGEM =====================

  // GET /api/v1/messages/:user_id
fastify.get('/:user_id', async (req) => {
  const userId = decode(req.params.user_id);
  const { limit = '100', before_ts, sort = 'asc' } = req.query || {};

  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const wantAsc = String(sort).toLowerCase() === 'asc';

  // Monta SQL: sempre consulta em DESC (índice ajuda), e depois ajusta a ordem para o cliente
  let sql, params;
  if (before_ts) {
    sql = `
      SELECT *
        FROM messages
       WHERE user_id = $1
         AND "timestamp" < $2
       ORDER BY "timestamp" DESC
       LIMIT $3
    `;
    params = [userId, new Date(before_ts).toISOString(), lim];
  } else {
    // primeira página: últimas N
    sql = `
      SELECT *
        FROM messages
       WHERE user_id = $1
       ORDER BY "timestamp" DESC
       LIMIT $2
    `;
    params = [userId, lim];
  }

  const { rows } = await req.db.query(sql, params);

  // Ajusta a ordem para o cliente
  const result = wantAsc ? rows.slice().reverse() : rows;

  // cursor para próxima página (pegar mais antigas)
  const oldest = result.length ? (result[0].timestamp || result[0].created_at) : before_ts || null;

  return {
    data: result,
    has_more: rows.length === lim,     // se veio cheio, provavelmente há mais
    next_before_ts: oldest             // passe isso no próximo before_ts
  };
});
}



