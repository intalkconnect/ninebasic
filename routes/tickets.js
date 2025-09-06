
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

// routes/tickets.js (versão melhorada) — GET /tickets/history/:id/pdf
fastify.get('/history/:id/pdf', async (req, reply) => {
  try {
    const { id } = req.params || {};

    // 1) Buscar dados do ticket e mensagens (mesmo código original)
    const tRes = await req.db.query(
      `SELECT t.id::text AS id, t.ticket_number, t.user_id, t.fila, t.assigned_to,
              t.status, t.created_at, t.updated_at,
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM tickets t
       LEFT JOIN clientes c ON c.user_id = t.user_id
       WHERE t.id::text = $1`,
      [String(id)]
    );
    if (!tRes.rowCount) return reply.code(404).send({ error: 'Ticket não encontrado' });
    const ticket = tRes.rows[0];

    const mRes = await req.db.query(
      `SELECT m.id::text AS id, m.direction, m."type", m."content", m."timestamp",
              m.metadata, m.assigned_to
       FROM messages m
       WHERE m.ticket_number = $1
       ORDER BY m."timestamp" ASC, m.id ASC
       LIMIT 2000`,
      [String(ticket.ticket_number || '')]
    );
    const rows = mRes.rows || [];

    // 2) Setup da resposta HTTP
    const num = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : '—';
    const filename = `ticket-${num}.pdf`;
    reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`);

    const out = new PassThrough();
    reply.send(out);

    // 3) Configuração do PDF melhorada
    const doc = new PDFDocument({ 
      size: 'A4', 
      margin: 40,
      info: {
        Title: `Ticket #${num}`,
        Subject: 'Histórico de Atendimento',
        Producer: 'Sistema de Tickets'
      }
    });
    doc.on('error', (e) => out.destroy(e));
    doc.pipe(out);

    // ==== CONSTANTES DE LAYOUT MELHORADAS ====
    const M = 40; // margem
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;
    const maxBubbleW = Math.min(420, contentW * 0.82);
    const gapY = 14;
    const bubblePadX = 16;
    const bubblePadY = 12;

    // CORES REFINADAS
    const colors = {
      primary: '#1F2937',
      secondary: '#6B7280', 
      accent: '#3B82F6',
      success: '#10B981',
      warning: '#F59E0B',
      error: '#EF4444',
      // Bolhas de chat
      incoming: {
        bg: '#F8FAFC',
        border: '#E2E8F0',
        text: '#1F2937',
        meta: '#64748B'
      },
      outgoing: {
        bg: '#3B82F6',
        border: '#2563EB', 
        text: '#FFFFFF',
        meta: '#DBEAFE'
      },
      system: {
        bg: '#F1F5F9',
        border: '#CBD5E1',
        text: '#475569'
      }
    };

    // ==== HELPER FUNCTIONS MELHORADAS ====
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
      base.url ??= m.url || m.file_url || m.download_url || m.signed_url || m.public_url || null;
      base.filename ??= m.filename || m.name || null;
      base.mime_type ??= m.mime || m.mimetype || m.content_type || null;
      base.caption ??= m.caption || null;
      base.size ??= m.size || m.filesize || null;
      return base;
    };

    const isImageUrl = (u) => /\.(png|jpe?g|webp|gif)$/i.test(u || '');
    const isImageMime = (m) => /^image\/(png|jpe?g|webp|gif)$/i.test(String(m || ''));

    async function fetchImageBuffer(url) {
      try {
        const rsp = await fetch(url);
        if (!rsp.ok) return null;
        const ct = rsp.headers.get('content-type') || '';
        if (!/^image\/(png|jpe?g|webp|gif)/i.test(ct)) return null;
        const ab = await rsp.arrayBuffer();
        return Buffer.from(ab);
      } catch { return null; }
    }

    const cleanupForwardPrefix = (s) => {
      if (!s) return s;
      return String(s).replace(/^\*[^:*]{1,60}:\*\s*/i, '');
    };

    function ensureSpace(need) {
      if (doc.y + need <= pageH - M) return;
      doc.addPage();
      // Header da página
      doc.save();
      doc.fillColor(colors.secondary).fontSize(9).font('Helvetica');
      doc.text(`Ticket #${num} — Página ${doc.bufferedPageRange().count}`, M, M);
      doc.moveTo(M, M + 15).lineTo(M + contentW, M + 15)
         .strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      doc.restore();
      doc.y = M + 25;
    }

    function drawSectionTitle(title, icon = '') {
      ensureSpace(35);
      doc.save();
      const bgHeight = 28;
      doc.rect(M, doc.y, contentW, bgHeight)
         .fill(colors.system.bg)
         .strokeColor(colors.system.border)
         .lineWidth(1)
         .stroke();
      
      doc.fillColor(colors.primary)
         .font('Helvetica-Bold')
         .fontSize(12);
      doc.text(`${icon} ${title}`, M + 12, doc.y + 8);
      doc.restore();
      doc.y += bgHeight + 12;
    }

    // ==== CABEÇALHO PRINCIPAL MELHORADO ====
    ensureSpace(120);
    
    // Logo/Título principal
    doc.save();
    doc.rect(M, doc.y, contentW, 50)
       .fill(colors.accent)
       .stroke();
    
    doc.fillColor('#FFFFFF')
       .font('Helvetica-Bold')
       .fontSize(22);
    doc.text(`Ticket #${num}`, M + 20, doc.y + 12);
    
    doc.fontSize(11)
       .font('Helvetica');
    doc.text(`Criado em ${new Date(ticket.created_at).toLocaleString('pt-BR')}`, M + 20, doc.y + 8);
    doc.restore();
    doc.y += 60;

    // ==== INFORMAÇÕES DO TICKET (LAYOUT EM GRID) ====
    drawSectionTitle('Informações do Ticket', '📋');
    
    const gridCols = 2;
    const colWidth = (contentW - 20) / gridCols;
    const rowHeight = 45;
    
    function drawInfoCard(label, value, x, y, width = colWidth) {
      doc.save();
      // Card background
      doc.roundedRect(x, y, width, rowHeight, 6)
         .fill('#FFFFFF')
         .strokeColor('#E5E7EB')
         .lineWidth(1)
         .stroke();
      
      // Label
      doc.fillColor(colors.secondary)
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(label.toUpperCase(), x + 12, y + 8);
      
      // Value
      doc.fillColor(colors.primary)
         .font('Helvetica')
         .fontSize(11)
         .text(value || '—', x + 12, y + 22, { width: width - 24 });
      doc.restore();
    }

    let gridY = doc.y;
    const infoItems = [
      ['Cliente', ticket.customer_name || ticket.user_id],
      ['Status', ticket.status],
      ['Contato', ticket.customer_phone || ticket.customer_email || '—'],
      ['Fila', ticket.fila],
      ['Atendente', ticket.assigned_to || '—'],
      ['Atualizado', new Date(ticket.updated_at).toLocaleString('pt-BR')]
    ];

    for (let i = 0; i < infoItems.length; i += 2) {
      const leftX = M;
      const rightX = M + colWidth + 10;
      
      drawInfoCard(infoItems[i][0], infoItems[i][1], leftX, gridY);
      if (infoItems[i + 1]) {
        drawInfoCard(infoItems[i + 1][0], infoItems[i + 1][1], rightX, gridY);
      }
      gridY += rowHeight + 8;
    }
    
    doc.y = gridY + 10;

    // ==== SEÇÃO DE CONVERSA MELHORADA ====
    drawSectionTitle('Histórico da Conversa', '💬');

    if (!rows.length) {
      doc.save();
      doc.roundedRect(M, doc.y, contentW, 60, 8)
         .fill('#FEF3F2')
         .strokeColor('#FECACA')
         .stroke();
      doc.fillColor('#DC2626')
         .fontSize(12)
         .font('Helvetica');
      doc.text('⚠️  Não há mensagens registradas neste ticket.', 
               M + 20, doc.y + 22, { width: contentW - 40, align: 'center' });
      doc.restore();
      doc.end();
      return;
    }

    // ==== FUNÇÃO PARA DESENHAR BOLHAS MELHORADAS ====
    async function drawEnhancedBubble({ who, when, side, text, imageBuf, imageUrl, links, type }) {
      if (side === 'center') {
        const pill = text || `${who} — ${when}`;
        const w = Math.min(400, contentW * 0.8);
        const padX = 16, padY = 10;
        const h = doc.heightOfString(pill, { width: w - padX * 2 }) + padY * 2;
        ensureSpace(h + gapY);
        
        const x = M + (contentW - w) / 2;
        doc.save()
          .roundedRect(x, doc.y, w, h, 12)
          .fill(colors.system.bg)
          .strokeColor(colors.system.border)
          .lineWidth(1)
          .stroke();
        
        doc.fillColor(colors.system.text)
           .font('Helvetica')
           .fontSize(10)
           .text(pill, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
        doc.restore();
        doc.y += h + gapY;
        return;
      }

      const isRight = side === 'right';
      const theme = isRight ? colors.outgoing : colors.incoming;
      const innerW = maxBubbleW - bubblePadX * 2;

      // Calcular dimensões
      const meta = `${who} • ${when}`;
      const body = cleanupForwardPrefix(text);
      const metaH = doc.heightOfString(meta, { width: innerW });
      const textH = body ? doc.heightOfString(body, { width: innerW }) : 0;
      const imgBudget = imageBuf ? Math.min(200, innerW * 0.8) : 0;
      const linksH = (links?.length || 0) * 18;

      const totalH = bubblePadY + metaH + (body ? 8 + textH : 0) + 
                     (imageBuf ? 10 + imgBudget : 0) + (linksH ? 8 + linksH : 0) + bubblePadY;
      
      ensureSpace(totalH + gapY);

      const bx = isRight ? (M + contentW - maxBubbleW) : M;
      const by = doc.y;

      // Desenhar bolha com sombra sutil
      doc.save();
      
      // Sombra
      const shadowOffset = 2;
      doc.roundedRect(bx + shadowOffset, by + shadowOffset, maxBubbleW, totalH, 12)
         .fill('#00000008');
      
      // Bolha principal
      doc.roundedRect(bx, by, maxBubbleW, totalH, 12)
         .fill(theme.bg)
         .strokeColor(theme.border)
         .lineWidth(1)
         .stroke();

      // Indicador de tipo de mensagem
      if (type && type !== 'text') {
        const typeIcons = {
          image: '🖼️',
          document: '📎',
          audio: '🎵',
          video: '🎥',
          location: '📍'
        };
        const icon = typeIcons[type] || '📄';
        doc.fillColor(theme.meta)
           .fontSize(10)
           .text(icon, bx + bubblePadX - 2, by + bubblePadY - 2);
      }

      // Metadados (quem/quando)
      doc.fillColor(theme.meta)
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(meta, bx + bubblePadX, by + bubblePadY, { width: innerW });
      let cy = by + bubblePadY + metaH;

      // Texto da mensagem
      if (body) {
        cy += 8;
        doc.fillColor(theme.text)
           .font('Helvetica')
           .fontSize(11)
           .text(body, bx + bubblePadX, cy, { width: innerW });
        cy = doc.y;
      }

      // Imagem
      if (imageBuf) {
        cy += 10;
        try {
          doc.roundedRect(bx + bubblePadX, cy, innerW, imgBudget, 6)
             .stroke('#E5E7EB');
          doc.image(imageBuf, bx + bubblePadX + 2, cy + 2, { 
            width: innerW - 4, 
            height: imgBudget - 4 
          });
        } catch (e) {
          // Fallback se imagem falhar
          doc.fillColor(theme.text)
             .fontSize(10)
             .text('🖼️ Imagem não pôde ser exibida', bx + bubblePadX, cy);
        }
        cy += imgBudget;

        if (imageUrl) {
          cy += 6;
          doc.fillColor(theme.text)
             .fontSize(9)
             .text('🔗 ', bx + bubblePadX, cy, { continued: true });
          doc.fillColor(isRight ? '#BFDBFE' : colors.accent)
             .text('Ver imagem original', { link: imageUrl, underline: true });
          cy = doc.y;
        }
      }

      // Links/anexos
      if (links && links.length) {
        cy += 8;
        for (const l of links) {
          doc.fillColor(theme.text)
             .fontSize(10)
             .text('📎 Anexo - ', bx + bubblePadX, cy, { continued: true });
          doc.fillColor(isRight ? '#BFDBFE' : colors.accent)
             .text('Download', { link: l.url, underline: true });
          cy += 18;
        }
      }

      doc.restore();
      doc.y = by + totalH + gapY;
    }

    // ==== PROCESSAR MENSAGENS COM SEPARADORES DE DATA ====
    let lastDay = '';
    
    function drawDateSeparator(date) {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      let label;
      const dateStr = date.toDateString();
      if (dateStr === today.toDateString()) {
        label = '🗓️ Hoje';
      } else if (dateStr === yesterday.toDateString()) {
        label = '🗓️ Ontem';
      } else {
        label = `🗓️ ${date.toLocaleDateString('pt-BR', { 
          weekday: 'long', 
          day: '2-digit', 
          month: 'long', 
          year: 'numeric' 
        })}`;
      }
      
      const w = Math.min(300, contentW * 0.6);
      const h = 24;
      ensureSpace(h + 16);
      
      const x = M + (contentW - w) / 2;
      doc.save()
        .roundedRect(x, doc.y, w, h, 12)
        .fill('#EEF2FF')
        .strokeColor('#C7D2FE')
        .lineWidth(1)
        .stroke();
      
      doc.fillColor('#4338CA')
         .font('Helvetica-Bold')
         .fontSize(10)
         .text(label, x + 12, doc.y + 7, { width: w - 24, align: 'center' });
      doc.restore();
      doc.y += h + 16;
    }

    // Processar cada mensagem
    for (const m of rows) {
      const ts = new Date(m.timestamp);
      const dayKey = ts.toISOString().slice(0, 10);
      
      if (dayKey !== lastDay) {
        drawDateSeparator(ts);
        lastDay = dayKey;
      }

      const dir = String(m.direction || '').toLowerCase();
      const type = String(m.type || '').toLowerCase();
      const meta = typeof m.metadata === 'string' ? safeParse(m.metadata) : (m.metadata || {});
      const c = normalize(m.content, meta, type);

      const who = dir === 'outgoing' ? (m.assigned_to || ticket.assigned_to || 'Atendente') :
                  dir === 'system' ? 'Sistema' :
                  (ticket.customer_name || ticket.user_id || 'Cliente');

      const when = ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const text = typeof c === 'string' ? c : (c?.text || c?.body || c?.caption || null);

      const url = c?.url || null;
      const mime = c?.mime_type || null;

      let imageBuf = null;
      let imageUrl = null;
      if (url && (isImageUrl(url) || isImageMime(mime))) {
        imageBuf = await fetchImageBuffer(url);
        imageUrl = url;
      }

      const fileLinks = [];
      if (url && !imageBuf) {
        fileLinks.push({ url });
      }

      const side = dir === 'outgoing' ? 'right' : dir === 'incoming' ? 'left' : 'center';

      await drawEnhancedBubble({
        who, when, side, text, type,
        imageBuf, imageUrl,
        links: fileLinks
      });
    }

    // ==== RODAPÉ FINAL ====
    ensureSpace(60);
    doc.y += 20;
    
    doc.save();
    doc.moveTo(M, doc.y).lineTo(M + contentW, doc.y)
       .strokeColor('#E5E7EB').lineWidth(1).stroke();
    
    doc.fillColor(colors.secondary)
       .fontSize(9)
       .font('Helvetica');
    doc.text(`Relatório gerado em ${new Date().toLocaleString('pt-BR')}`, M, doc.y + 10);
    doc.text(`Total: ${rows.length} mensagem(ns)`, M + contentW - 120, doc.y);
    doc.restore();

    doc.end();
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
