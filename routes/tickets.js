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

// GET /tickets/history/:id/pdf  -> download de PDF com layout "chat"
fastify.get('/history/:id/pdf', async (req, reply) => {
  const { createRequire } = await import('node:module');
  const require     = createRequire(import.meta.url);
  const PDFDocument = require('pdfkit');

  const { id } = req.params || {};

  // 1) Ticket + cliente
  const tRes = await req.db.query(
    `
    SELECT t.id::text AS id, t.ticket_number, t.user_id, t.fila, t.assigned_to,
           t.status, t.created_at, t.updated_at,
           c.name  AS customer_name, c.email AS customer_email, c.phone AS customer_phone
      FROM tickets t
      LEFT JOIN clientes c ON c.user_id = t.user_id
     WHERE t.id::text = $1
    `,
    [String(id)]
  );
  if (!tRes.rowCount) return reply.code(404).send({ error: 'Ticket não encontrado' });
  const ticket   = tRes.rows[0];
  const num      = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : null;
  const filename = num ? `ticket-${num}.pdf` : `ticket-sem-numero.pdf`;

  // 2) Mensagens
  const mRes = await req.db.query(
    `
    SELECT m.id::text AS id, m.direction, m."type", m."content", m."timestamp",
           m.metadata, m.assigned_to
      FROM messages m
     WHERE m.ticket_number = $1
     ORDER BY m."timestamp" ASC, m.id ASC
     LIMIT 1000
    `,
    [String(ticket.ticket_number || '')]
  );
  const msgs = mRes.rows || [];

  // 3) helpers de conteúdo
  const parseText = (raw) => {
    try {
      if (!raw) return '';
      if (typeof raw === 'object') {
        const t = raw.text || raw.body || raw.caption || raw.message;
        return typeof t === 'string' ? t : (t ? String(t) : JSON.stringify(raw));
      }
      const s = String(raw);
      try { const o = JSON.parse(s); return o?.text || o?.body || o?.caption || s; }
      catch { return s; }
    } catch { return ''; }
  };
  const extractUrlAndFile = (metaLike) => {
    const meta = typeof metaLike === 'string'
      ? (JSON.parse(metaLike || '{}') || {}) : (metaLike || {});
    const url = meta.url || meta.file_url || meta.public_url || meta.download_url || null;
    let filename = meta.filename || meta.name || null;
    if (!filename && url) {
      try { const u = new URL(url); filename = decodeURIComponent(u.pathname.split('/').pop() || 'arquivo'); }
      catch { filename = 'arquivo'; }
    }
    const mime = meta.mime || meta.mimetype || meta.content_type || null;
    const size = meta.size || meta.filesize || null;
    return { url, filename, mime, size };
  };

  // 4) Geração do PDF em buffer com layout de chat
  function buildPdf(t, messages) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 36 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        // Paleta e métricas
        const palette = {
          agentBg:     '#F1F5F9',  // cinza claro (agente/sistema)
          agentText:   '#0f172a',
          custBg:      '#2563eb',  // azul (cliente)
          custText:    '#ffffff',
          subText:     '#64748b',
          divider:     '#e5e7eb',
          dateChipBg:  '#e2e8f0',
          link:        '#2563eb',
        };
        const MARGIN = 36;
        const PAGE_W = doc.page.width, PAGE_H = doc.page.height;
        const CONTENT_X = MARGIN;
        const CONTENT_W = PAGE_W - MARGIN * 2;
        const BUBBLE_MAX_W = Math.round(CONTENT_W * 0.72);
        const PAD_X = 10, PAD_Y = 8;
        const GAP_Y = 10;
        const BUBBLE_R = 10;

        const ensurePage = (neededH = 0) => {
          const bottom = doc.y + neededH + 10;
          if (bottom > PAGE_H - MARGIN) {
            doc.addPage();
            doc.y = MARGIN;
          }
        };

        // Cabeçalho do ticket
        doc.font('Helvetica-Bold').fontSize(18).text(`Ticket #${num ?? '—'}`);
        doc.moveDown(0.25);
        doc.font('Helvetica').fontSize(10).fillColor(palette.subText)
           .text(`Criado em: ${new Date(t.created_at).toLocaleString('pt-BR')}`);
        doc.moveDown(0.6).fillColor('#000');

        // Cartão do cliente (compacto)
        const info = (label, value) => {
          doc.font('Helvetica-Bold').fontSize(10).text(label);
          doc.font('Helvetica').fontSize(11).text(value || '—');
          doc.moveDown(0.2);
        };
        info('Cliente', t.customer_name || t.user_id || '—');
        doc.font('Helvetica').fontSize(10).fillColor(palette.subText)
           .text([t.customer_phone, t.customer_email].filter(Boolean).join(' · ') || '—');
        doc.moveDown(0.4).fillColor('#000');
        const startX = doc.x, startY = doc.y;

        // Mini grade com Fila, Atendente, Status, Atualizado
        const colW = Math.floor(CONTENT_W / 2);
        const drawKV = (k, v) => {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(palette.subText).text(k.toUpperCase());
          doc.font('Helvetica').fontSize(11).fillColor('#000').text(v || '—');
        };
        const gTop = doc.y;
        doc.save();
        doc.rect(CONTENT_X, gTop, CONTENT_W, 1).fill(palette.divider).restore();
        doc.moveDown(0.5);

        const y1 = doc.y;
        doc.x = CONTENT_X; doc.y = y1; drawKV('Fila', t.fila);
        const colHeight1 = doc.y - y1;

        doc.x = CONTENT_X + colW; doc.y = y1; drawKV('Atendente', t.assigned_to);
        const colHeight2 = doc.y - y1;

        const rowH1 = Math.max(colHeight1, colHeight2);
        doc.y = y1 + rowH1 + 6;

        const y2 = doc.y;
        doc.x = CONTENT_X; doc.y = y2; drawKV('Status', t.status);
        const colHeight3 = doc.y - y2;

        doc.x = CONTENT_X + colW; doc.y = y2;
        drawKV('Última atualização', new Date(t.updated_at).toLocaleString('pt-BR'));
        const colHeight4 = doc.y - y2;

        doc.y = y2 + Math.max(colHeight3, colHeight4) + 10;

        // Título "Conversa"
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(12).text('Conversa');
        doc.moveDown(0.3);

        if (!messages.length) {
          doc.font('Helvetica').fontSize(10).fillColor(palette.subText)
             .text('Não há histórico de mensagens para este ticket.');
          doc.end();
          return;
        }

        // Separador por dia (pílula central)
        const drawDayChip = (dateStr) => {
          const label = new Date(dateStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const w = doc.widthOfString(label, { font: 'Helvetica-Bold', size: 9 }) + 16;
          const h = 16;
          const x = CONTENT_X + (CONTENT_W - w) / 2;
          ensurePage(h + 12);
          doc.save();
          doc.fillColor(palette.dateChipBg).roundedRect(x, doc.y, w, h, 8).fill();
          doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9)
             .text(label, x, doc.y + 3, { width: w, align: 'center' });
          doc.restore();
          doc.moveDown(1);
        };

        // Bolha de mensagem
        const drawBubble = ({ who, when, text, url, filename, isCustomer }) => {
          const maxW = BUBBLE_MAX_W;
          const innerW = maxW - PAD_X * 2;

          // Medir altura do texto principal
          doc.font('Helvetica').fontSize(11);
          const textH = text
            ? doc.heightOfString(text, { width: innerW, align: 'left' })
            : 0;

          // Medir “Baixar …” se houver anexo
          let attachH = 0;
          const hasAttach = !!url;
          if (hasAttach) {
            doc.font('Helvetica').fontSize(10);
            const attachLine = filename ? `📎 ${filename}` : '📎 Anexo';
            attachH = doc.heightOfString(attachLine, { width: innerW })
                    + doc.heightOfString('Baixar', { width: innerW }); // link na linha seguinte
          }

          // Medir cabeçalho (quem + hora)
          doc.font('Helvetica').fontSize(8);
          const headH = doc.heightOfString(`${who} — ${when}`, { width: innerW });

          const bubbleH = headH + (text ? textH + 6 : 0) + (hasAttach ? attachH + 6 : 0) + PAD_Y * 2;

          ensurePage(bubbleH);

          const x = isCustomer
            ? CONTENT_X + CONTENT_W - maxW  // direita
            : CONTENT_X;                    // esquerda
          const y = doc.y;

          // Caixa
          doc.save();
          doc.fillColor(isCustomer ? palette.custBg : palette.agentBg)
             .roundedRect(x, y, maxW, bubbleH, BUBBLE_R).fill();

          // Cabeçalho
          doc.fillColor(isCustomer ? '#bfdbfe' : palette.subText)
             .font('Helvetica-Bold').fontSize(8)
             .text(`${who} — ${when}`, x + PAD_X, y + PAD_Y, { width: innerW });

          // Texto
          if (text) {
            doc.font('Helvetica').fontSize(11)
               .fillColor(isCustomer ? palette.custText : palette.agentText)
               .text(text, x + PAD_X, doc.y + 4, { width: innerW });
          }

          // Anexo, se houver
          if (hasAttach) {
            doc.moveDown(0.2);
            doc.font('Helvetica').fontSize(10)
               .fillColor(isCustomer ? '#dbeafe' : '#111827')
               .text(filename ? `📎 ${filename}` : '📎 Anexo', x + PAD_X, doc.y, { width: innerW });

            doc.fillColor(palette.link)
               .text('Baixar', x + PAD_X, doc.y, { width: innerW, link: url, underline: true });
          }

          doc.restore();
          doc.y = y + bubbleH + GAP_Y;
        };

        // Loop de mensagens (agrupa por dia)
        let lastDayKey = '';
        messages.forEach((m, idx) => {
          const dir = String(m.direction || '').toLowerCase();
          const isCustomer = !(dir === 'outgoing' || dir === 'system'); // incoming = cliente
          const who = dir === 'outgoing' ? (m.assigned_to || 'Atendente')
                    : dir === 'system'   ? 'Sistema'
                    : (t.customer_name || 'Cliente');
          const when = new Date(m.timestamp).toLocaleString('pt-BR');

          // separador por dia
          const dayKey = new Date(m.timestamp).toISOString().slice(0, 10);
          if (dayKey !== lastDayKey) {
            drawDayChip(dayKey);
            lastDayKey = dayKey;
          }

          // conteúdo textual e anexo
          const txt = parseText(m.content);
          const { url, filename } = extractUrlAndFile(m.metadata);

          drawBubble({ who, when, text: txt, url, filename, isCustomer });
        });

        doc.end();
      } catch (e) { reject(e); }
    });
  }

  const pdfBuffer = await buildPdf(ticket, msgs);

  return reply
    .type('application/pdf')
    .header('Cache-Control', 'no-store')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Content-Length', String(pdfBuffer.length))
    .send(pdfBuffer);
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
