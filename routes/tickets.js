
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

  // helper: valida e resolve ticket_number existente
  async function ensureTicketExistsByNumber(db, ticket_number) {
    const num = String(ticket_number || '').trim();
    if (!/^\d+$/.test(num)) return null;
    const r = await db.query(
      `SELECT ticket_number FROM tickets WHERE ticket_number = $1`,
      [num]
    );
    return r.rowCount ? num : null;
  }

async function ticketsRoutes(fastify, options) {
  // Validação simples do formato do user_id
  function isValidUserId(user_id) {
    return /^[\w\d]+@[\w\d.-]+$/.test(user_id);
  }

   async function getFilaIdByNome(db, nomeFila) {
    const { rows } = await db.query(
      `SELECT id FROM hmg.filas WHERE nome = $1 LIMIT 1`,
      [nomeFila]
    );
    return rows[0]?.id || null;
  }

  async function getTicketFilaNome(db, ticketNumber) {
    const { rows } = await db.query(
      `SELECT fila FROM hmg.tickets WHERE ticket_number = $1 LIMIT 1`,
      [ticketNumber]
    );
    return rows[0]?.fila || null;
  }

  function normalizeTicketTag(raw) {
    if (raw == null) return null;
    const t = String(raw).trim().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t.length > 40) return t.slice(0, 40);
    if (/[^\S\r\n]*[\r\n]/.test(t)) return null;
    return t;
  }

 fastify.get('/history/:id/pdf', async (req, reply) => {
  let doc;
  try {
    const { id } = req.params || {};

    // 1) Ticket + cliente
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

    // 2) Mensagens
    const mRes = await req.db.query(`
      SELECT m.id::text AS id, m.direction, m."type", m."content", m."timestamp",
             m.metadata, m.assigned_to
        FROM messages m
       WHERE m.ticket_number = $1
       ORDER BY m."timestamp" ASC, m.id ASC
       LIMIT 2000
    `, [String(ticket.ticket_number || '')]);
    const rows = mRes.rows || [];

    // 2.1) Resolver nomes de atendentes (users.email -> name + lastname)
    const agentEmailsSet = new Set();
    if (ticket.assigned_to) agentEmailsSet.add(String(ticket.assigned_to).toLowerCase());
    for (const r of rows) if (r.assigned_to) agentEmailsSet.add(String(r.assigned_to).toLowerCase());
    const agentEmails = [...agentEmailsSet];
    const agentNameByEmail = new Map();
    if (agentEmails.length) {
      const uRes = await req.db.query(
        `SELECT LOWER(email) AS email,
                COALESCE(NULLIF(TRIM(name || ' ' || lastname), ''), name, lastname, email) AS full_name
           FROM users
          WHERE LOWER(email) = ANY($1)`,
        [agentEmails]
      );
      for (const u of (uRes.rows || [])) agentNameByEmail.set(u.email, u.full_name || u.email);
    }
    const resolveAgent = (email) => {
      if (!email) return 'Atendente';
      const key = String(email).toLowerCase();
      return agentNameByEmail.get(key) || email;
    };

    // 3) Hijack + headers (evita "write after end")
    const num = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : '—';
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="ticket-${num}.pdf"`
    });

    // 4) PDF
    doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(reply.raw);
    doc.on('error', (e) => { try { reply.raw.destroy(e); } catch {} });

    // ---------- Helpers ----------
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

    // INSERIR PONTOS DE QUEBRA EM PALAVRAS MUITO LONGAS (evita overflow)
    function softWrapLongTokens(str, max = 28) {
      if (!str) return str;
      return String(str)
        .split(/(\s+)/) // preserva espaços
        .map(tok => (tok.trim().length > max ? tok.replace(new RegExp(`(.{1,${max}})`, 'g'), '$1\u200B') : tok))
        .join('');
    }

    // Retângulo arredondado compatível
    function fillRoundedRect(doc, x, y, w, h, r, color) {
      doc.save();
      doc.fillColor(color);
      doc.moveTo(x + r, y);
      doc.lineTo(x + w - r, y);
      doc.quadraticCurveTo(x + w, y, x + w, y + r);
      doc.lineTo(x + w, y + h - r);
      doc.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      doc.lineTo(x + r, y + h);
      doc.quadraticCurveTo(x, y + h, x, y + h - r);
      doc.lineTo(x, y + r);
      doc.quadraticCurveTo(x, y, x + r, y);
      doc.fill();
      doc.restore();
    }

    // ---------- Layout/Cores ----------
    const M = 40;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;

    const gapY = 10;
    const bubblePadX = 12;
    const bubblePadY = 8;
    const maxBubbleW = Math.min(340, contentW * 0.66);

    const colText       = '#1F2937';
    const colMeta       = '#8A8F98';
    const colSep        = '#E5E7EB';
    const colDayPill    = '#EEF2F7';
    const colIncomingBg = '#F6F7F9';
    const colOutgoingBg = '#ECEFF3';
    const colLink       = '#4B5563';

    // Header
    const headerAgent = resolveAgent(ticket.assigned_to);
    doc.fillColor(colText).font('Helvetica-Bold').fontSize(18)
       .text(`Ticket #${num}`, M, undefined, { width: contentW });
    doc.moveDown(0.2);
    doc.fillColor(colMeta).font('Helvetica').fontSize(10)
       .text(`Criado em: ${new Date(ticket.created_at).toLocaleString('pt-BR')}`, { width: contentW });
    doc.moveDown(0.6);

    // Dados (duas colunas)
    const leftX  = M;
    const rightX = M + contentW / 2;
    const lh = 14;
    function labelValue(label, value, x, y) {
      doc.fillColor(colMeta).font('Helvetica-Bold').fontSize(9).text(label, x, y);
      doc.fillColor(colText).font('Helvetica').fontSize(11).text(value || '—', x, y + 10);
      return y + 10 + lh;
    }
    let y1 = doc.y, y2 = doc.y;
    y1 = labelValue('Cliente',   ticket.customer_name || ticket.user_id, leftX,  y1);
    y1 = labelValue('Contato',   ticket.customer_phone || ticket.customer_email || '—', leftX,  y1);
    y2 = labelValue('Fila',      ticket.fila,          rightX, y2);
    y2 = labelValue('Atendente', headerAgent,          rightX, y2);

    const yMax = Math.max(y1, y2);
    doc.strokeColor(colSep).lineWidth(1)
       .moveTo(M, yMax + 8).lineTo(M + contentW, yMax + 8).stroke();
    doc.y = yMax + 16;

    // Título conversa
    doc.fillColor(colText).font('Helvetica-Bold').fontSize(12).text('Conversa');
    doc.moveDown(0.3);

    if (!rows.length) {
      doc.fillColor(colMeta).font('Helvetica').fontSize(11)
         .text('Não há histórico de mensagens neste ticket.', { width: contentW, align: 'center' });
      doc.end();
      return;
    }

    function ensureSpace(need) {
      if (doc.y + need <= pageH - M) return;
      doc.addPage();
      doc.fillColor(colMeta).font('Helvetica').fontSize(10)
         .text(`Ticket #${num} — continuação`, M, M);
      doc.moveDown(0.5);
    }

    // Separador por dia
    let lastDay = '';
    function daySeparator(date) {
      const label = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const padX = 8, padY = 3;
      const w = doc.widthOfString(label) + padX * 2;
      const h = doc.currentLineHeight() + padY * 2;
      const x = M + (contentW - w) / 2;
      ensureSpace(h + 8);
      fillRoundedRect(doc, x, doc.y, w, h, 6, colDayPill);
      doc.fillColor('#4B5563').font('Helvetica').fontSize(9)
         .text(label, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
      doc.moveDown(0.6);
    }

    // Link labels
    const buildLinkLabels = (links) =>
      (links || []).map(l => {
        const base = l?.filename ? `${l.filename} — Clique aqui para abrir a mídia`
                                 : 'Clique aqui para abrir a mídia';
        return softWrapLongTokens(base, 28);
      });

    // Função para calcular altura do texto com quebras
    function calculateTextHeight(text, options) {
      const { width, fontSize = 11, font = 'Helvetica' } = options;
      doc.save();
      doc.font(font).fontSize(fontSize);
      const height = doc.heightOfString(text, { width, align: 'left' });
      doc.restore();
      return height;
    }

    // Bolha
    function drawBubble({ who, when, side, body, links }) {
      // normaliza texto e quebra tokens longos
      const txt = softWrapLongTokens((body || '').toString().trim(), 28);
      const hasLinks = (links && links.length > 0);
      if (!txt && !hasLinks) return;

      const isRight = side === 'right';
      const bg = isRight ? colOutgoingBg : colIncomingBg;
      const metaLine = softWrapLongTokens(`${who} — ${when}`, 36);
      const innerW = maxBubbleW - bubblePadX * 2;

      const linkLabels = buildLinkLabels(links);

      // Calcular alturas com as mesmas configurações de fonte
      const metaH  = calculateTextHeight(metaLine, { width: innerW, fontSize: 9, font: 'Helvetica' });
      const bodyH  = txt ? calculateTextHeight(txt, { width: innerW, fontSize: 11, font: 'Helvetica' }) : 0;
      
      let linksH = 0;
      if (linkLabels.length) {
        doc.save();
        doc.font('Helvetica').fontSize(10);
        linkLabels.forEach(label => {
          linksH += doc.heightOfString(label, { width: innerW }) + 4;
        });
        doc.restore();
      }

      const totalH = bubblePadY + metaH + (txt ? 6 + bodyH : 0)
                   + (linkLabels.length ? 8 + linksH : 0) + bubblePadY;

      ensureSpace(totalH + gapY);

      const bx = isRight ? (M + contentW - maxBubbleW) : M;
      const by = doc.y;

      fillRoundedRect(doc, bx, by, maxBubbleW, totalH, 10, bg);

      doc.fillColor(colMeta).font('Helvetica').fontSize(9)
         .text(metaLine, bx + bubblePadX, by + bubblePadY, { 
           width: innerW,
           align: 'left'
         });

      let cy = by + bubblePadY + metaH;

      if (txt) {
        cy += 6;
        doc.fillColor(colText).font('Helvetica').fontSize(11)
           .text(txt, bx + bubblePadX, cy, { 
             width: innerW,
             align: 'left'
           });
        cy = doc.y;
      }

      if (linkLabels.length) {
        cy += 8;
        doc.fillColor(colLink).font('Helvetica').fontSize(10);
        for (let i = 0; i < linkLabels.length; i++) {
          doc.text(linkLabels[i], bx + bubblePadX, cy, {
            width: innerW,
            link: links[i].url,
            underline: true,
            align: 'left'
          });
          cy = doc.y + 4;
        }
      }

      doc.y = by + totalH + gapY;
    }

    // 5) Loop
    for (const m of rows) {
      const ts = new Date(m.timestamp);
      const dayKey = ts.toISOString().slice(0, 10);
      if (dayKey !== lastDay) { daySeparator(ts); lastDay = dayKey; }

      const dir  = String(m.direction || '').toLowerCase(); // incoming | outgoing | system
      const type = String(m.type || '').toLowerCase();
      const meta = typeof m.metadata === 'string' ? safeParse(m.metadata) : (m.metadata || {});
      const c = normalize(m.content, meta, type);

      const rawText = (typeof c === 'string' ? c : (c?.text || c?.body || c?.caption || '')) || '';
      const trimmed = rawText.toString().trim();

      if (dir === 'system') {
        // “Ticket #000041” -> apenas texto central (sem pílula)
        const ticketStartRegex = new RegExp(`^\\s*ticket\\s*#?${num}\\s*$`, 'i');
        if (ticketStartRegex.test(trimmed)) {
          const t = softWrapLongTokens(trimmed, 36);
          ensureSpace(doc.currentLineHeight() + 6);
          doc.fillColor(colMeta).font('Helvetica').fontSize(10)
             .text(t, M, doc.y, { width: contentW, align: 'center' });
          doc.moveDown(0.4);
          continue;
        }

        // Demais eventos: pílula
        const text = softWrapLongTokens(trimmed || '[evento]', 36);
        const padX = 10, padY = 6;
        const w = Math.min(320, contentW * 0.6);
        const txtH = calculateTextHeight(text, { width: w - padX * 2, fontSize: 10 });
        const h = padY * 2 + txtH;
        ensureSpace(h + gapY);
        const x = M + (contentW - w) / 2;
        fillRoundedRect(doc, x, doc.y, w, h, 8, colDayPill);
        doc.fillColor('#4B5563').font('Helvetica').fontSize(10)
           .text(text, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
        doc.moveDown(0.5);
        continue;
      }

      const who = dir === 'outgoing'
        ? resolveAgent(m.assigned_to || ticket.assigned_to)
        : (ticket.customer_name || ticket.user_id || 'Cliente');

      const when = ts.toLocaleString('pt-BR');
      const url = c?.url || null;
      const links = url ? [{ url, filename: c?.filename || null }] : [];

      drawBubble({
        who,
        when,
        side: dir === 'outgoing' ? 'right' : 'left',
        body: trimmed,
        links
      });
    }

    doc.end();

  } catch (err) {
    req.log.error({ err }, 'Erro ao gerar PDF');
    if (doc) { try { doc.end(); } catch {} }
    else if (!reply.sent) reply.code(500).send({ error: 'Erro ao gerar PDF' });
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
  // POST /tickets/transferir → fecha atual e cria novo em outra fila
fastify.post('/transferir', async (req, reply) => {
  const { from_user_id, to_fila, to_assigned_to, transferido_por } = req.body;

  if (!from_user_id || !to_fila || !transferido_por) {
    return reply.code(400).send({ error: 'Campos obrigatórios: from_user_id, to_fila, transferido_por' });
  }

  const client = req.db;                 // << já é o client conectado
  let inTx = false;

  try {
    await client.query('BEGIN');         // usa a MESMA conexão
    inTx = true;

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

    const rCreate = await client.query(
      `SELECT create_ticket($1, $2, $3) AS ticket_number`,
      [from_user_id, nomeDaFila, to_assigned_to || null]
    );

    const novoTicket = await client.query(
      `SELECT user_id, ticket_number, fila, assigned_to, status
         FROM tickets
        WHERE ticket_number = $1`,
      [rCreate.rows[0].ticket_number]
    );

    await client.query('COMMIT');
    inTx = false;

    return reply.code(201).send({
      sucesso: true,
      transferido_por,      // já que é obrigatório, devolvemos também
      novo_ticket: novoTicket.rows[0],
    });
  } catch (err) {
    if (inTx) { try { await client.query('ROLLBACK'); } catch {} }
    fastify.log.error({ err, body: req.body }, 'Erro em POST /tickets/transferir');
    return reply.code(500).send({ error: 'Erro ao transferir atendimento' });
  }
  // nada de client.release(); // << NÃO existe nesse client
});


  // GET /tickets/history → lista de tickets fechados (com busca e período)
fastify.get('/history', async (req, reply) => {
  const { q = '', page = 1, page_size = 10, from = '', to = '' } = req.query || {};

  const allowed  = new Set([10, 20, 30, 40]);
  const pageSize = allowed.has(Number(page_size)) ? Number(page_size) : 10;
  const pageNum  = Math.max(1, Number(page) || 1);
  const offset   = (pageNum - 1) * pageSize;

  // WHERE com alias 't' para tickets
  const where  = [`t.status = 'closed'`];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    const qi = params.length;
    where.push(`(
      LOWER(COALESCE(t.ticket_number::text,'')) LIKE LOWER($${qi})
      OR LOWER(COALESCE(t.user_id::text,''))    LIKE LOWER($${qi})
      OR LOWER(COALESCE(t.fila,''))             LIKE LOWER($${qi})
      OR LOWER(COALESCE(t.assigned_to,''))      LIKE LOWER($${qi})
      OR LOWER(COALESCE(c."name",''))           LIKE LOWER($${qi})  -- nome do cliente
      OR LOWER(COALESCE(c.phone,''))            LIKE LOWER($${qi})  -- telefone do cliente (opcional)
      OR LOWER(COALESCE(ua.name,''))            LIKE LOWER($${qi})  -- nome do atendente
      OR LOWER(COALESCE(ua.lastname,''))        LIKE LOWER($${qi})  -- sobrenome do atendente
      OR LOWER(COALESCE((ua.name || ' ' || ua.lastname),'')) LIKE LOWER($${qi})
    )`);
  }

  if (from) {
    params.push(from + ' 00:00:00');
    where.push(`t.updated_at >= $${params.length}`);
  }
  if (to) {
    params.push(to + ' 23:59:59.999');
    where.push(`t.updated_at <= $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // JOINs:
  //  c  -> clientes (por id::text OU por clientes.user_id)
  //  ua -> users (atendentes) por e-mail em assigned_to
  const joinSql = `
    LEFT JOIN clientes c ON (c.id::text = t.user_id OR c.user_id = t.user_id)
    LEFT JOIN users    ua ON ua.email   = t.assigned_to
  `;

  // COUNT precisa dos mesmos JOINs para a busca por nome funcionar no total
  const sqlCount = `
    SELECT COUNT(*)::bigint AS total
    FROM tickets t
    ${joinSql}
    ${whereSql}
  `;

  // Na lista, devolvemos "user_id" já como NOME do cliente
  // e "assigned_to" já como NOME do atendente
  const sqlList = `
    SELECT
      t.id,
      t.ticket_number,
      COALESCE(NULLIF(c."name", ''), c.phone, t.user_id) AS user_id,  -- nome do cliente no lugar do id
      t.fila,
      COALESCE(
        NULLIF(TRIM(ua.name || ' ' || ua.lastname), ''),
        ua.name,
        t.assigned_to
      ) AS assigned_to,                                               -- nome do atendente no lugar do e-mail
      t.created_at,
      t.updated_at
    FROM tickets t
    ${joinSql}
    ${whereSql}
    ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
    LIMIT  $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  try {
    const rCount = await req.db.query(sqlCount, params);
    const total  = Number(rCount.rows?.[0]?.total || 0);

    const rList  = await req.db.query(sqlList, [...params, pageSize, offset]);
    const data   = rList.rows || [];

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

    /* =======================
     TAGS DO TICKET (tickets)
     ======================= */

  
 

  // GET /tickets/:ticket_number/tags
  fastify.get('/:ticket_number/tags', async (req, reply) => {
    const { ticket_number } = req.params;

    try {
      const tn = await ensureTicketExistsByNumber(req.db, ticket_number);
      if (!tn) return reply.code(404).send({ error: 'Ticket não encontrado' });

      const { rows } = await req.db.query(
        `SELECT tag FROM ticket_tags WHERE ticket_number = $1 ORDER BY tag ASC`,
        [tn]
      );
      return reply.send({ ticket_number: tn, tags: rows.map(r => r.tag) });
    } catch (err) {
      req.log.error({ err }, 'Erro em GET /tickets/:ticket_number/tags');
      return reply.code(500).send({ error: 'Erro interno ao listar tags do ticket' });
    }
  });

  // PUT /tickets/:ticket_number/tags { tags: string[] } (substitui)
  fastify.put('/:ticket_number/tags', async (req, reply) => {
    const { ticket_number } = req.params;
    const { tags } = req.body || {};

    if (!Array.isArray(tags)) {
      return reply.code(400).send({ error: 'Payload inválido. Envie { tags: string[] }' });
    }

    try {
      const tn = await ensureTicketExistsByNumber(req.db, ticket_number);
      if (!tn) return reply.code(404).send({ error: 'Ticket não encontrado' });

      const norm = [...new Set(tags.map(normalizeTicketTag).filter(Boolean))];

      await req.db.query('BEGIN');
      await req.db.query(`DELETE FROM ticket_tags WHERE ticket_number = $1`, [tn]);

      if (norm.length) {
        const values = norm.map((_, i) => `($1, $${i + 2})`).join(', ');
        await req.db.query(
          `INSERT INTO ticket_tags (ticket_number, tag) VALUES ${values} ON CONFLICT DO NOTHING`,
          [tn, ...norm]
        );
      }
      await req.db.query('COMMIT');

      return reply.send({ ok: true, ticket_number: tn, tags: norm });
    } catch (err) {
      try { await req.db.query('ROLLBACK'); } catch {}
      req.log.error({ err }, 'Erro em PUT /tickets/:ticket_number/tags');
      return reply.code(500).send({ error: 'Erro ao salvar tags do ticket' });
    }
  });

  // POST /tickets/:ticket_number/tags { tag: string } (adiciona)
  fastify.post('/:ticket_number/tags', async (req, reply) => {
    const { ticket_number } = req.params;
    const { tag } = req.body || {};
    const t = normalizeTicketTag(tag);

    if (!t) return reply.code(400).send({ error: 'Tag inválida' });

    try {
      const tn = await ensureTicketExistsByNumber(req.db, ticket_number);
      if (!tn) return reply.code(404).send({ error: 'Ticket não encontrado' });

      await req.db.query(
        `INSERT INTO ticket_tags (ticket_number, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [tn, t]
      );
      return reply.code(201).send({ ok: true, ticket_number: tn, tag: t });
    } catch (err) {
      req.log.error({ err }, 'Erro em POST /tickets/:ticket_number/tags');
      return reply.code(500).send({ error: 'Erro ao adicionar tag do ticket' });
    }
  });

  // DELETE /tickets/:ticket_number/tags/:tag
  fastify.delete('/:ticket_number/tags/:tag', async (req, reply) => {
    const { ticket_number, tag } = req.params;
    const t = normalizeTicketTag(tag);

    if (!t) return reply.code(400).send({ error: 'Tag inválida' });

    try {
      const tn = await ensureTicketExistsByNumber(req.db, ticket_number);
      if (!tn) return reply.code(404).send({ error: 'Ticket não encontrado' });

      const { rowCount } = await req.db.query(
        `DELETE FROM ticket_tags WHERE ticket_number = $1 AND tag = $2`,
        [tn, t]
      );
      if (rowCount === 0) return reply.code(404).send({ error: 'Tag não encontrada para este ticket' });

      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err }, 'Erro em DELETE /tickets/:ticket_number/tags/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do ticket' });
    }
  });


  // ============================
  // Catálogo por fila (queue_ticket_tag_catalog)
  // ============================

  // GET /tags/ticket/catalog?fila=NomeDaFila&q=&active=true|false&page=&page_size=
  fastify.get('/catalog', async (req, reply) => {
    const { fila = '', q = '', active, page = 1, page_size = 20 } = req.query || {};
    if (!fila.trim()) return reply.code(400).send({ error: 'Parâmetro fila é obrigatório' });

    const pageNum  = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);
    const offset   = (pageNum - 1) * pageSize;

    try {
      const filaId = await getFilaIdByNome(req.db, fila);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      const where = [`fila_id = $1`];
      const params = [filaId];

      if (q) {
        params.push(`%${q}%`);
        where.push(`(LOWER(tag) LIKE LOWER($${params.length}) OR LOWER(COALESCE(label,'')) LIKE LOWER($${params.length}))`);
      }
      if (active === 'true' || active === true) {
        where.push(`active IS TRUE`);
      } else if (active === 'false' || active === false) {
        where.push(`active IS FALSE`);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const sqlCount = `SELECT COUNT(*)::bigint AS total FROM hmg.queue_ticket_tag_catalog ${whereSql}`;
      const sqlList  = `
        SELECT fila_id, tag, label, color, active, created_at
          FROM hmg.queue_ticket_tag_catalog
          ${whereSql}
         ORDER BY tag ASC
         LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `;

      const rCount = await req.db.query(sqlCount, params);
      const total  = Number(rCount.rows?.[0]?.total || 0);
      const rList  = await req.db.query(sqlList, [...params, pageSize, offset]);

      return reply.send({
        fila,
        fila_id: filaId,
        data: rList.rows || [],
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (err) {
      req.log.error({ err }, 'GET /tags/ticket/catalog');
      return reply.code(500).send({ error: 'Erro ao listar catálogo de tags por fila' });
    }
  });

  // POST /tags/ticket/catalog { fila, tag, label?, color?, active? }
  fastify.post('/catalog', async (req, reply) => {
    const { fila, tag, label = null, color = null, active = true } = req.body || {};
    const f = String(fila || '').trim();
    const t = String(tag || '').trim();
    if (!f || !t) return reply.code(400).send({ error: 'Campos fila e tag são obrigatórios' });

    try {
      const filaId = await getFilaIdByNome(req.db, f);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      const sql = `
        INSERT INTO hmg.queue_ticket_tag_catalog (fila_id, tag, label, color, active)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (fila_id, tag) DO UPDATE
          SET label = EXCLUDED.label,
              color = EXCLUDED.color,
              active = EXCLUDED.active
        RETURNING fila_id, tag, label, color, active, created_at
      `;
      const { rows } = await req.db.query(sql, [filaId, t, label, color, Boolean(active)]);
      return reply.code(201).send({ fila, fila_id: filaId, ...rows[0] });
    } catch (err) {
      req.log.error({ err }, 'POST /tags/ticket/catalog');
      return reply.code(500).send({ error: 'Erro ao criar/atualizar tag de fila' });
    }
  });

  // PATCH /tags/ticket/catalog/:fila/:tag  { label?, color?, active? }
  fastify.patch('/catalog/:fila/:tag', async (req, reply) => {
    const fila = String(req.params?.fila || '').trim();
    const tag  = String(req.params?.tag  || '').trim();
    if (!fila || !tag) return reply.code(400).send({ error: 'Parâmetros fila e tag são obrigatórios' });

    const allowed = ['label', 'color', 'active'];
    const upd = {};
    for (const k of allowed) {
      if (k in req.body) upd[k] = req.body[k];
    }
    if (!Object.keys(upd).length) {
      return reply.code(400).send({ error: 'Nada para atualizar' });
    }

    try {
      const filaId = await getFilaIdByNome(req.db, fila);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      const sets = [];
      const vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(upd)) {
        sets.push(`${k} = $${i++}`);
        vals.push(k === 'active' ? Boolean(v) : v);
      }
      vals.push(filaId, tag);

      const sql = `
        UPDATE hmg.queue_ticket_tag_catalog
           SET ${sets.join(', ')}
         WHERE fila_id = $${i++} AND tag = $${i}
         RETURNING fila_id, tag, label, color, active, created_at
      `;
      const { rows } = await req.db.query(sql, vals);
      if (!rows[0]) return reply.code(404).send({ error: 'Tag do catálogo não encontrada para esta fila' });
      return reply.send({ fila, fila_id: filaId, ...rows[0] });
    } catch (err) {
      req.log.error({ err }, 'PATCH /tags/ticket/catalog/:fila/:tag');
      return reply.code(500).send({ error: 'Erro ao atualizar tag do catálogo da fila' });
    }
  });

  // DELETE /tags/ticket/catalog/:fila/:tag
  fastify.delete('/catalog/:fila/:tag', async (req, reply) => {
    const fila = String(req.params?.fila || '').trim();
    const tag  = String(req.params?.tag  || '').trim();
    if (!fila || !tag) return reply.code(400).send({ error: 'Parâmetros fila e tag são obrigatórios' });

    try {
      const filaId = await getFilaIdByNome(req.db, fila);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      // impedir exclusão se estiver em uso
      const inUse = await req.db.query(
        `SELECT 1 FROM hmg.ticket_tags WHERE fila_id = $1 AND tag = $2 LIMIT 1`,
        [filaId, tag]
      );
      if (inUse.rowCount) {
        return reply.code(409).send({ error: 'Tag está vinculada a tickets — remova os vínculos antes' });
      }

      const { rowCount } = await req.db.query(
        `DELETE FROM hmg.queue_ticket_tag_catalog WHERE fila_id = $1 AND tag = $2`,
        [filaId, tag]
      );
      return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Tag de fila não encontrada' });
    } catch (err) {
      req.log.error({ err }, 'DELETE /tags/ticket/catalog/:fila/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do catálogo da fila' });
    }
  });

  // ============================
  // Vínculo ticket ⇄ tag (ticket_tags)
  // ============================

  // GET /tags/ticket/:ticket_number
  fastify.get('/:ticket_number', async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || '').trim();
    if (!tn) return reply.code(400).send({ error: 'ticket_number é obrigatório' });

    try {
      // checa ticket + resolve fila
      const { rows: rt } = await req.db.query(
        `SELECT ticket_number, fila FROM hmg.tickets WHERE ticket_number = $1 LIMIT 1`,
        [tn]
      );
      const t = rt[0];
      if (!t) return reply.code(404).send({ error: 'Ticket não encontrado' });

      const { rows } = await req.db.query(
        `SELECT tt.ticket_number, tt.fila_id, qttc.tag, qttc.label, qttc.color, qttc.active, tt.created_at,
                f.nome AS fila
           FROM hmg.ticket_tags tt
           JOIN hmg.queue_ticket_tag_catalog qttc
             ON qttc.fila_id = tt.fila_id AND qttc.tag = tt.tag
           JOIN hmg.filas f ON f.id = tt.fila_id
          WHERE tt.ticket_number = $1
          ORDER BY qttc.tag ASC`,
        [tn]
      );
      return reply.send({ ticket_number: tn, fila: t.fila, tags: rows || [] });
    } catch (err) {
      req.log.error({ err }, 'GET /tags/ticket/:ticket_number');
      return reply.code(500).send({ error: 'Erro ao listar tags do ticket' });
    }
  });

  // GET /tags/ticket/:ticket_number/catalog  → catálogo aplicável (fila do ticket)
  fastify.get('/:ticket_number/catalog', async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || '').trim();
    if (!tn) return reply.code(400).send({ error: 'ticket_number é obrigatório' });

    try {
      const filaNome = await getTicketFilaNome(req.db, tn);
      if (!filaNome) return reply.code(404).send({ error: 'Ticket não encontrado ou sem fila' });

      const filaId = await getFilaIdByNome(req.db, filaNome);
      if (!filaId) return reply.code(404).send({ error: 'Fila do ticket não encontrada' });

      const { rows } = await req.db.query(
        `SELECT fila_id, tag, label, color, active, created_at
           FROM hmg.queue_ticket_tag_catalog
          WHERE fila_id = $1 AND active IS TRUE
          ORDER BY tag ASC`,
        [filaId]
      );
      return reply.send({ ticket_number: tn, fila: filaNome, fila_id: filaId, catalog: rows || [] });
    } catch (err) {
      req.log.error({ err }, 'GET /tags/ticket/:ticket_number/catalog');
      return reply.code(500).send({ error: 'Erro ao listar catálogo de tags da fila do ticket' });
    }
  });

  // POST /tags/ticket/:ticket_number  { tags: ["agendamento","reclamacao"] }
  fastify.post('/:ticket_number', async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || '').trim();
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(x => String(x).trim()).filter(Boolean) : [];
    if (!tn) return reply.code(400).send({ error: 'ticket_number é obrigatório' });
    if (!tags.length) return reply.code(400).send({ error: 'tags é obrigatório (array não-vazio)' });

    try {
      const filaNome = await getTicketFilaNome(req.db, tn);
      if (!filaNome) return reply.code(404).send({ error: 'Ticket não encontrado ou sem fila' });

      const filaId = await getFilaIdByNome(req.db, filaNome);
      if (!filaId) return reply.code(404).send({ error: 'Fila do ticket não encontrada' });

      // só permite tags existentes/ativas no catálogo da fila
      const rKnown = await req.db.query(
        `SELECT tag FROM hmg.queue_ticket_tag_catalog
          WHERE fila_id = $1 AND tag = ANY($2::text[]) AND active IS TRUE`,
        [filaId, tags]
      );
      const known = new Set((rKnown.rows || []).map(r => r.tag));
      const unknown = tags.filter(t => !known.has(t));
      if (unknown.length) {
        return reply.code(400).send({ error: 'Tags não pertencem ao catálogo da fila ou estão inativas', unknown });
      }

      // upsert
      const values = [];
      const params = [];
      let i = 1;
      for (const t of tags) {
        // fila_id é exigido pela PK (ticket_number, tag) + (fila_id, tag) para o FK do catálogo
        params.push(tn, filaId, t);
        values.push(`($${i++}, $${i++}, $${i++})`);
      }
      const sql = `
        INSERT INTO hmg.ticket_tags (ticket_number, fila_id, tag)
        VALUES ${values.join(', ')}
        ON CONFLICT (ticket_number, tag) DO NOTHING
        RETURNING ticket_number, fila_id, tag, created_at
      `;
      const { rows } = await req.db.query(sql, params);
      return reply.code(201).send({ added: rows.length, items: rows, fila: filaNome, fila_id: filaId });
    } catch (err) {
      req.log.error({ err }, 'POST /tags/ticket/:ticket_number');
      return reply.code(500).send({ error: 'Erro ao vincular tags ao ticket' });
    }
  });

  // DELETE /tags/ticket/:ticket_number/:tag
  fastify.delete('/:ticket_number/:tag', async (req, reply) => {
    const tn  = String(req.params?.ticket_number || '').trim();
    const tag = String(req.params?.tag || '').trim();
    if (!tn || !tag) return reply.code(400).send({ error: 'ticket_number e tag são obrigatórios' });

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM hmg.ticket_tags WHERE ticket_number = $1 AND tag = $2`,
        [tn, tag]
      );
      return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Vínculo não encontrado' });
    } catch (err) {
      req.log.error({ err }, 'DELETE /tags/ticket/:ticket_number/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do ticket' });
    }
  });

}

export default ticketsRoutes;
