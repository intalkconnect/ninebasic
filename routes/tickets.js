
import amqplib from 'amqplib';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit'); // CJS carregado corretamente em ESM

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

// routes/tickets.js (trecho) — GET /tickets/history/:id/pdf


// GET /tickets/history/:id/pdf  -> gera e baixa o PDF do ticket (layout de chat)
fastify.get('/history/:id/pdf', async (req, reply) => {
  try {
    const { id } = req.params || {};

    // 1) Ticket + dados do cliente
    const tRes = await req.db.query(`
      SELECT t.id::text AS id, t.ticket_number, t.user_id, t.fila, t.assigned_to,
             t.status, t.created_at, t.updated_at,
             c.name  AS customer_name, c.email AS customer_email, c.phone AS customer_phone
        FROM tickets t
        LEFT JOIN clientes c ON c.user_id = t.user_id
       WHERE t.id::text = $1
    `, [String(id)]);
    if (!tRes.rowCount) return reply.code(404).send({ error: 'Ticket não encontrado' });
    const ticket = tRes.rows[0];

    // 2) Mensagens (ordem cronológica)
    const mRes = await req.db.query(`
      SELECT m.id::text AS id, m.direction, m."type", m."content", m."timestamp",
             m.metadata, m.assigned_to
        FROM messages m
       WHERE m.ticket_number = $1
       ORDER BY m."timestamp" ASC, m.id ASC
       LIMIT 2000
    `, [String(ticket.ticket_number || '')]);
    const rows = mRes.rows || [];

    // 3) Cabeçalhos HTTP + stream (uma única resposta)
    const num = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : '—';
    const filename = `ticket-${num}.pdf`;

    reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`);

    const out = new PassThrough();
    reply.send(out); // ✅ envia só uma vez

    // 4) PDF
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.on('error', (e) => out.destroy(e));
    doc.pipe(out); // PDF -> PassThrough -> cliente

    // ==== helpers de conteúdo ====
    const safeParse = (raw) => {
      if (raw == null) return null;
      if (typeof raw === 'object') return raw;
      const s = String(raw);
      try { return JSON.parse(s); } catch {
        if (/^https?:\/\//i.test(s)) return { url: s };
        return s;
      }
    };
    const normalize = (raw, meta, type) => {
      const c = safeParse(raw);
      const base = (c && typeof c === 'object' && !Array.isArray(c)) ? { ...c } :
                   (typeof c === 'string' ? { text: c } : {});
      const m = meta || {};
      base.url       ??= m.url || m.file_url || m.download_url || m.signed_url || m.public_url || null;
      base.filename  ??= m.filename || m.name || null;
      base.mime_type ??= m.mime || m.mimetype || m.content_type || null;
      base.caption   ??= m.caption || null;
      base.size      ??= m.size || m.filesize || null;
      return base;
    };
    const isImageUrl  = (u) => /\.(png|jpe?g)$/i.test(u || '');
    const isImageMime = (m) => /^image\/(png|jpe?g)$/i.test(String(m || ''));
    async function fetchImageBuffer(url) {
      try {
        const rsp = await fetch(url);
        if (!rsp.ok) return null;
        const ct = rsp.headers.get('content-type') || '';
        if (!/^image\/(png|jpe?g)/i.test(ct)) return null;
        const ab = await rsp.arrayBuffer();
        return Buffer.from(ab);
      } catch { return null; }
    }

    // ==== layout ====
    const M = 36;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;
    const maxBubbleW = Math.min(380, contentW * 0.78);
    const gapY = 10;
    const bubblePadX = 10;
    const bubblePadY = 8;

    const colIncomingBg = '#F3F4F6'; // esquerda (cliente)
    const colOutgoingBg = '#2563EB'; // direita (agente)
    const colOutgoingTx = '#FFFFFF';
    const colMeta       = '#6B7280';
    const colSystemBg   = '#E5E7EB';

    // Header
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(`Ticket #${num}`);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#6B7280')
       .text(`Criado em: ${new Date(ticket.created_at).toLocaleString('pt-BR')}`);
    doc.moveDown(0.4);

    // Info do cliente (duas colunas)
    const leftColX = M;
    const rightColX = M + contentW / 2;
    const lineH = 14;
    function labelValue(label, value, x, y) {
      doc.fillColor('#6B7280').font('Helvetica-Bold').fontSize(9).text(label, x, y);
      doc.fillColor('#111827').font('Helvetica').fontSize(11).text(value || '—', x, y + 10);
      return y + 10 + lineH;
    }
    let y = doc.y;
    const yStart = y;
    y  = labelValue('Cliente',  ticket.customer_name || ticket.user_id, leftColX,  y);
    y  = labelValue('Contato',  ticket.customer_phone || ticket.customer_email || '—', leftColX,  y);
    let y2 = yStart;
    y2 = labelValue('Fila',     ticket.fila,          rightColX,       y2);
    y2 = labelValue('Atendente',ticket.assigned_to,   rightColX,       y2);
    const yMax = Math.max(y, y2);
    doc.moveTo(M, yMax + 8).lineTo(M + contentW, yMax + 8).strokeColor('#E5E7EB').lineWidth(1).stroke();
    doc.y = yMax + 16;

    // Título "Conversa"
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12).text('Conversa');
    doc.moveDown(0.4);

    if (!rows.length) {
      doc.fillColor('#6B7280').fontSize(11)
         .text('Não há histórico de mensagens neste ticket.', { align: 'center', width: contentW });
      doc.end();
      return; // ✅ fim
    }

    // quebra de página
    function ensureSpace(need) {
      if (doc.y + need <= pageH - M) return;
      doc.addPage();
      doc.fillColor('#6B7280').font('Helvetica').fontSize(10)
         .text(`Ticket #${num} — continuação`, M, M);
      doc.moveDown(0.5);
    }

    // separador por dia
    let lastDay = '';
    function drawDaySeparator(date) {
      const label = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const pillPadX = 8, pillPadY = 3;
      const w = doc.widthOfString(label) + pillPadX * 2;
      const x = M + (contentW - w) / 2;
      const h = doc.currentLineHeight() + pillPadY * 2;
      ensureSpace(h + 8);
      doc.save();
      doc.roundedRect(x, doc.y, w, h, 6).fill(colSystemBg);
      doc.fillColor('#374151').fontSize(9)
         .text(label, x + pillPadX, doc.y + pillPadY, { width: w - pillPadX * 2, align: 'center' });
      doc.restore();
      doc.moveDown(0.6);
    }

    // desenha uma bolha (incoming/outgoing) ou pílula system
    async function drawBubble({ who, when, side, text, imageBuf, links }) {
      if (side === 'center') {
        const pill = text || `${who} — ${when}`;
        const w = Math.min(300, contentW * 0.6);
        const padX = 10, padY = 6;
        const h = doc.heightOfString(pill, { width: w - padX * 2 }) + padY * 2;
        ensureSpace(h + gapY);
        const x = M + (contentW - w) / 2;
        doc.save();
        doc.roundedRect(x, doc.y, w, h, 8).fill(colSystemBg);
        doc.fillColor('#374151').font('Helvetica').fontSize(10)
           .text(pill, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
        doc.restore();
        doc.moveDown(0.5);
        return;
      }

      const isRight = side === 'right';
      const bg      = isRight ? colOutgoingBg : colIncomingBg;
      const txtCol  = isRight ? colOutgoingTx : '#111827';
      const metaCol = isRight ? '#DDE7FF' : colMeta;

      const innerW = maxBubbleW - bubblePadX * 2;
      const meta = `${who} — ${when}`;

      const metaH  = doc.heightOfString(meta,  { width: innerW });
      const textH  = text ? doc.heightOfString(text, { width: innerW }) : 0;
      const linksH = links.length
        ? links.reduce((acc, l) => acc + doc.heightOfString(l.label, { width: innerW }) + 4, 0)
        : 0;

      const totalH = bubblePadY + metaH + (text ? 6 + textH : 0) + (imageBuf ? 8 + 180 : 0) + (links.length ? 6 + linksH : 0) + bubblePadY;
      ensureSpace(totalH + gapY);

      const bx = isRight ? (M + contentW - maxBubbleW) : M;
      const by = doc.y;

      doc.save();
      doc.roundedRect(bx, by, maxBubbleW, totalH, 10).fill(bg);

      doc.fillColor(metaCol).font('Helvetica').fontSize(9)
         .text(meta, bx + bubblePadX, by + bubblePadY, { width: innerW });
      let cy = by + bubblePadY + metaH;

      if (text) {
        cy += 6;
        doc.fillColor(txtCol).font('Helvetica').fontSize(11)
           .text(text, bx + bubblePadX, cy, { width: innerW });
        cy = doc.y;
      }

      if (imageBuf) {
        cy += 8;
        doc.image(imageBuf, bx + bubblePadX, cy, { width: innerW });
        cy += 180; // reserva aproximada
      }

      if (links.length) {
        cy += 6;
        doc.font('Helvetica').fontSize(10).fillColor(isRight ? '#E0E7FF' : '#1D4ED8');
        for (const l of links) {
          doc.text(l.label, bx + bubblePadX, cy, { width: innerW, link: l.url, underline: true });
          cy = doc.y + 4;
        }
      }

      doc.restore();
      doc.y = by + totalH + gapY;
    }

    // 5) Loop das mensagens
    for (const m of rows) {
      const ts = new Date(m.timestamp);
      const dayKey = ts.toISOString().slice(0, 10);
      if (dayKey !== lastDay) { drawDaySeparator(ts); lastDay = dayKey; }

      const dir  = String(m.direction || '').toLowerCase();
      const type = String(m.type || '').toLowerCase();
      const meta = typeof m.metadata === 'string' ? safeParse(m.metadata) : (m.metadata || {});
      const c    = normalize(m.content, meta, type);

      // quem/onde
      const who = dir === 'outgoing'
        ? (m.assigned_to || ticket.assigned_to || 'Atendente')
        : dir === 'system'
        ? 'Sistema'
        : (ticket.customer_name || ticket.user_id || 'Cliente');

      const when = ts.toLocaleString('pt-BR');

      const text =
        typeof c === 'string' ? c :
        (c?.text || c?.body || c?.caption || null);

      const url  = c?.url || null;
      const mime = c?.mime_type || null;

      // imagem inline (png/jpg) ou links para outros tipos
      let imageBuf = null;
      if (url && (isImageUrl(url) || isImageMime(mime))) {
        imageBuf = await fetchImageBuffer(url);
      }

      const links = [];
      if (url && !imageBuf) {
        let name = c?.filename;
        if (!name) {
          try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arquivo'); }
          catch { name = 'arquivo'; }
        }
        links.push({ label: name, url });
      }

      await drawBubble({
        who,
        when,
        side: dir === 'system' ? 'center' : (dir === 'outgoing' ? 'right' : 'left'),
        text,
        imageBuf,
        links
      });
    }

    doc.end(); // ✅ fecha o PDF e o PassThrough termina a resposta
  } catch (err) {
    req.log.error({ err }, 'Erro ao gerar PDF');
    if (!reply.sent) reply.code(500).send({ error: 'Erro ao gerar PDF' });
  }
});



fastify.get('/history/:id', async (req, reply) => {
  const { id } = req.params || {};
  const { include, messages_limit } = req.query || {};

  const idStr = String(id);
  const limit = Math.min(Math.max(parseInt(messages_limit || '100', 10) || 100, 1), 500);

  // include=messages,attachments
  const includes = String(include || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const withMessages    = includes.includes('messages');
  const withAttachments = includes.includes('attachments');

  try {
    // 1) Ticket + dados do cliente
    const tRes = await req.db.query(
      `
      SELECT
        t.id::text        AS id,
        t.ticket_number,
        t.user_id,
        t.fila,
        t.assigned_to,
        t.status,
        t.created_at,
        t.updated_at,
        -- dados do cliente (podem ser NULL)
        c.name            AS customer_name,
        c.email           AS customer_email,
        c.phone           AS customer_phone,
        c.channel         AS customer_channel
      FROM tickets t
      LEFT JOIN clientes c ON c.user_id = t.user_id
      WHERE t.id::text = $1
      `,
      [idStr]
    );

    if (tRes.rowCount === 0) {
      return reply.code(404).send({ error: 'Ticket não encontrado' });
    }

    const ticket = tRes.rows[0];
    ticket.tags = ticket.tags || []; // reservado para futuro

    // Helpers
    const safeParse = (raw) => {
      if (raw == null) return null;
      if (typeof raw === 'object') return raw;
      const s = String(raw);
      try { return JSON.parse(s); } catch {
        // se a content for uma URL direta
        if (/^https?:\/\//i.test(s)) return { url: s };
        return s; // texto puro
      }
    };

    const mergeContent = (rawContent, meta, type) => {
      const c = safeParse(rawContent);
      const out =
        (c && typeof c === 'object' && !Array.isArray(c)) ? { ...c } :
        (typeof c === 'string' ? { text: c } : {});
      const m = meta || {};
      out.url        ??= m.url || m.file_url || m.download_url || m.signed_url || m.public_url || null;
      out.filename   ??= m.filename || m.name || null;
      out.mime_type  ??= m.mime || m.mimetype || m.content_type || null;
      out.caption    ??= m.caption || null;
      out.voice      ??= m.voice || (String(type).toLowerCase() === 'audio' ? true : undefined);
      out.size       ??= m.size || m.filesize || null;
      out.width      ??= m.width || null;
      out.height     ??= m.height || null;
      out.duration   ??= m.duration || m.audio_duration || null;
      return out;
    };

    const deriveStatus = (row) => {
      if (row.read_at) return 'read';
      if (row.delivered_at) return 'delivered';
      if (String(row.direction).toLowerCase() === 'outgoing') return 'sent';
      return 'received';
    };

    // 2) Precisaremos carregar mensagens se pediram messages ou attachments
    if ((withMessages || withAttachments) && ticket.ticket_number) {
      // se pediram APENAS attachments, ainda assim buscamos mensagens,
      // mas os campos já cobrem os dois casos
      const mRes = await req.db.query(
        `
        SELECT
          m.id::text      AS id,
          m.user_id,
          m.message_id,
          m.direction,
          m."type",
          m."content",
          m."timestamp",
          m.channel,
          m.ticket_number,
          m.assigned_to,
          m.delivered_at,
          m.read_at,
          m.reply_to,
          m.metadata
        FROM messages m
        WHERE m.ticket_number = $1
        ORDER BY m."timestamp" ASC, m.id ASC
        LIMIT $2
        `,
        [String(ticket.ticket_number), limit]
      );

      const rows = mRes.rows || [];

      // 3) Mapeia mensagens (somente se pediram messages)
      if (withMessages) {
        ticket.messages = rows.map((m) => {
          const dir = String(m.direction || '').toLowerCase();
          const type = String(m.type || '').toLowerCase();
          const content = mergeContent(m.content, m.metadata, type);

          return {
            id: m.id,
            direction: dir,
            type,                          // preserva o tipo original (text, image, document, ...)
            content,                       // objeto/string normalizado
            text:
              typeof content === 'string' ? content :
              (content.text || content.body || content.caption || null),
            timestamp: m.timestamp,        // compatível com ChatWindow
            created_at: m.timestamp,
            channel: m.channel,
            message_id: m.message_id,
            ticket_number: m.ticket_number,
            from_agent: dir === 'outgoing' || dir === 'system',
            sender_name: dir === 'outgoing'
              ? (m.assigned_to || ticket.assigned_to || 'Atendente')
              : (dir === 'system' ? 'Sistema' : null), // NÃO mostrar “Cliente”
            delivered_at: m.delivered_at,
            read_at: m.read_at,
            status: deriveStatus(m),       // 'read' | 'delivered' | 'sent' | 'received'
            metadata: m.metadata || null,
            reply_to: m.reply_to || m.metadata?.context?.message_id || null,
            context: m.metadata?.context || null
          };
        });
      }

      // 4) Deriva anexos a partir das mensagens (sempre que pedirem attachments)
      if (withAttachments) {
        const attachments = rows.map((m) => {
          const type = String(m.type || '').toLowerCase();
          const c = mergeContent(m.content, m.metadata, type); // garante url/mimetype/filename/size...
          const url = c?.url;

          // tipos que usualmente geram arquivo
          const isAttachType = ['document', 'image', 'audio', 'video', 'sticker', 'file'].includes(type);
          if (!isAttachType && !url) return null;

          if (!url) return null; // sem URL não há o que baixar

          let filename = c.filename || null;
          if (!filename) {
            try {
              const u = new URL(url);
              filename = decodeURIComponent(u.pathname.split('/').pop() || 'arquivo');
            } catch { filename = 'arquivo'; }
          }

          return {
            id: m.id,
            type,
            url,
            filename,
            mime_type: c.mime_type || null,
            size: c.size || null,
            timestamp: m.timestamp,
            direction: m.direction,
            sender_name: (String(m.direction).toLowerCase() === 'outgoing')
              ? (m.assigned_to || ticket.assigned_to || 'Atendente')
              : null
          };
        }).filter(Boolean);

        ticket.attachments = attachments;
      }
    } else {
      // não pediram nada = mantém mensagens/attachments ausentes
      if (withMessages)    ticket.messages = [];
      if (withAttachments) ticket.attachments = [];
    }

    return reply.send(ticket);
  } catch (err) {
    req.log.error({ err }, 'Erro em GET /tickets/history/:id');
    return reply.code(500).send({
      error: 'Erro interno ao buscar ticket',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});


  // GET /tickets/last/:user_id → retorna o ticket mais recente do usuário
  fastify.get('/last/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
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

  // GET /tickets/:user_id → Consulta ticket aberto por user_id
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
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

  // GET /tickets/user/:user_id → tickets fechados do usuário
  fastify.get('/user/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({ error: 'Formato de user_id inválido. Use: usuario@dominio' });
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

  // PUT /tickets/:user_id → fechar último ticket aberto do user_id e publicar evento
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

      const ch = await ensureAMQPIncoming();
      ch.sendToQueue(
        INCOMING_QUEUE,
        Buffer.from(JSON.stringify({
          kind: 'system_event',
          event: {
            type: 'ticket_status',
            userId: user_id,
            status: 'closed',
            ticketNumber: updated.ticket_number,
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

  // POST /tickets/transferir → fecha atual e cria novo em outra fila
  fastify.post('/transferir', async (req, reply) => {
    const { from_user_id, to_fila, to_assigned_to, transferido_por } = req.body;

    if (!from_user_id || !to_fila || !transferido_por) {
      return reply.code(400).send({ error: 'Campos obrigatórios: from_user_id, to_fila, transferido_por' });
    }

    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

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

      const filaResult = await client.query(
        `SELECT nome FROM filas WHERE nome = $1`,
        [to_fila]
      );

      if (filaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Fila destino não encontrada' });
      }

      const nomeDaFila = filaResult.rows[0].nome;

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

  // GET /tickets/history → lista de tickets fechados (com busca e período)
  fastify.get('/history', async (req, reply) => {
    const { q = '', page = 1, page_size = 10, from = '', to = '' } = req.query || {};

    const allowed = new Set([10, 20, 30, 40]);
    const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
    const pageNum  = Math.max(1, Number(page) || 1);
    const offset   = (pageNum - 1) * pageSize;

    const where = [`status = 'closed'`];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        LOWER(COALESCE(ticket_number::text,'')) LIKE LOWER($${params.length})
        OR LOWER(COALESCE(user_id,''))          LIKE LOWER($${params.length})
        OR LOWER(COALESCE(fila,''))             LIKE LOWER($${params.length})
        OR LOWER(COALESCE(assigned_to,''))      LIKE LOWER($${params.length})
      )`);
    }

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
