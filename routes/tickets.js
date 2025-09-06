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

// GET /tickets/history/:id/pdf -> download de PDF com layout "chat"
// - outbound (outgoing/system) à direita (azul)
// - inbound (incoming) à esquerda (cinza)
// - título centralizado
// - imagens embutidas; demais anexos com link "Baixar"
fastify.get('/history/:id/pdf', async (req, reply) => {
  const { createRequire } = await import('node:module');
  const require     = createRequire(import.meta.url);
  const PDFDocument = require('pdfkit');

  const { id } = req.params || {};

  // ========== Ticket + Cliente ==========
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

  // ========== Mensagens ==========
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

  // ========== Helpers ==========
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

  const extractMeta = (metaLike) => {
    try { return typeof metaLike === 'string' ? JSON.parse(metaLike || '{}') || {} : (metaLike || {}); }
    catch { return {}; }
  };

  const extractUrlAndFile = (metaLike, contentType, contentUrlMaybe) => {
    const meta = extractMeta(metaLike);
    const url  = meta.url || meta.file_url || meta.public_url || meta.download_url || contentUrlMaybe || null;
    let filename = meta.filename || meta.name || null;
    const mime = meta.mime || meta.mimetype || meta.content_type || null;
    let size = meta.size || meta.filesize || null;

    if (!filename && url) {
      try { const u = new URL(url); filename = decodeURIComponent(u.pathname.split('/').pop() || 'arquivo'); }
      catch { filename = 'arquivo'; }
    }
    return { url, filename, mime, size, type: (contentType || '').toLowerCase() };
  };

  const looksLikeImage = ({ mime, url, type }) => {
    if (type === 'image') return true;
    if (mime && /^image\//i.test(mime)) return true;
    if (url && /\.(png|jpe?g|gif|webp)$/i.test(url)) return true;
    return false;
  };

  // Pequenas rotinas para descobrir dimensão de PNG/JPEG a partir do Buffer (sem dependências)
  const getPngSize = (buf) => {
    const sig = '89504e470d0a1a0a';
    if (buf.length >= 24 && buf.slice(0,8).toString('hex') === sig) {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      return { width: w, height: h };
    }
    return null;
  };
  const getJpegSize = (buf) => {
    // Procura SOF0/2
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i+1];
      const len = buf.readUInt16BE(i+2);
      if (marker === 0xC0 || marker === 0xC2) {
        const h = buf.readUInt16BE(i+5), w = buf.readUInt16BE(i+7);
        return { width: w, height: h };
      }
      i += 2 + len;
    }
    return null;
  };
  const getImageSize = (buf) => getPngSize(buf) || getJpegSize(buf) || null;

  // fetch com fallback (Node >= 18 já tem global fetch)
  let doFetch = globalThis.fetch;
  if (!doFetch) {
    try { doFetch = (await import('undici')).fetch; } catch { /* sem fetch -> sem imagem inline */ }
  }

  // Precarrega buffers de imagens quando fizer sentido (para medir altura antes de desenhar a bolha)
  async function loadImageIfAny(meta, isImage) {
    if (!isImage || !meta.url || !doFetch) return null;
    try {
      const res = await doFetch(meta.url);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    }
  }

  // ========== Constrói o PDF (em memória) ==========
  function buildPdf(ticket, messages) {
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 36 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        // Paleta e métricas
        const palette = {
          inboundBg:  '#F1F5F9',   // cinza p/ inbound (esquerda)
          inboundText:'#0f172a',
          outboundBg: '#2563eb',   // azul p/ outbound (direita)
          outboundText:'#ffffff',
          subText:    '#64748b',
          divider:    '#e5e7eb',
          dateChipBg: '#e2e8f0',
          link:       '#2563eb',
        };
        const MARGIN = 36;
        const PAGE_W = doc.page.width, PAGE_H = doc.page.height;
        const CONTENT_X = MARGIN;
        const CONTENT_W = PAGE_W - MARGIN * 2;
        const BUBBLE_MAX_W = Math.round(CONTENT_W * 0.72);
        const PAD_X = 10, PAD_Y = 8;
        const GAP_Y = 10;
        const BUBBLE_R = 10;
        const IMG_MAX_H = 280;

        const ensurePage = (neededH = 0) => {
          const bottom = doc.y + neededH + 10;
          if (bottom > PAGE_H - MARGIN) {
            doc.addPage();
            doc.y = MARGIN;
          }
        };

        // ===== Cabeçalho central =====
        const title = `Ticket #${num ?? '—'}`;
        doc.font('Helvetica-Bold').fontSize(18);
        const titleW = doc.widthOfString(title);
        doc.text(title, CONTENT_X + (CONTENT_W - titleW) / 2, doc.y, { width: titleW, align: 'center' });
        doc.moveDown(0.25);
        doc.font('Helvetica').fontSize(10).fillColor(palette.subText)
           .text(`Criado em: ${new Date(ticket.created_at).toLocaleString('pt-BR')}`, {
             align: 'center',
             width: CONTENT_W
           });
        doc.moveDown(0.8).fillColor('#000');

        // ===== Info compacta do ticket =====
        const infoKVs = [
          ['Cliente', ticket.customer_name || ticket.user_id || '—'],
          ['Contato', [ticket.customer_phone, ticket.customer_email].filter(Boolean).join(' · ') || '—'],
          ['Fila', ticket.fila || '—'],
          ['Atendente', ticket.assigned_to || '—'],
          ['Status', ticket.status || '—'],
          ['Última atualização', new Date(ticket.updated_at).toLocaleString('pt-BR')],
        ];

        doc.font('Helvetica').fontSize(10);
        infoKVs.forEach(([k, v], idx) => {
          doc.font('Helvetica-Bold').fillColor(palette.subText).text(k.toUpperCase(), { width: CONTENT_W });
          doc.font('Helvetica').fillColor('#000').text(v, { width: CONTENT_W });
          if (idx === 1) {
            doc.moveDown(0.2);
            doc.save(); doc.rect(CONTENT_X, doc.y, CONTENT_W, 1).fill(palette.divider); doc.restore();
            doc.moveDown(0.4);
          } else {
            doc.moveDown(0.4);
          }
        });

        // ===== Título "Conversa" =====
        doc.moveDown(0.6);
        doc.font('Helvetica-Bold').fontSize(12).text('Conversa', { width: CONTENT_W });
        doc.moveDown(0.3);

        if (!messages.length) {
          doc.font('Helvetica').fontSize(10).fillColor(palette.subText)
             .text('Não há histórico de mensagens para este ticket.', { width: CONTENT_W });
          doc.end();
          return;
        }

        // ===== Separador por dia =====
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

        // ===== Bolha =====
        const drawBubble = ({ who, when, text, meta, isOutbound, imgBuf, imgSize }) => {
          // Alinhamento
          const maxW   = BUBBLE_MAX_W;
          const innerW = maxW - PAD_X * 2;
          const x      = isOutbound
            ? CONTENT_X + CONTENT_W - maxW  // direita (outbound)
            : CONTENT_X;                    // esquerda (inbound)

          // Medidas de conteúdo
          doc.font('Helvetica').fontSize(8);
          const headH = doc.heightOfString(`${who} — ${when}`, { width: innerW });

          let textH = 0;
          if (text) {
            doc.font('Helvetica').fontSize(11);
            textH = doc.heightOfString(text, { width: innerW, align: 'left' });
          }

          let imageH = 0;
          let drawImage = false;
          let imageDrawW = 0, imageDrawH = 0;
          if (imgBuf && imgSize && imgSize.width && imgSize.height) {
            // ajusta à largura interna e limita a altura
            imageDrawW = Math.min(innerW, imgSize.width);
            const ratio = imageDrawW / imgSize.width;
            imageDrawH = Math.round(imgSize.height * ratio);
            if (imageDrawH > IMG_MAX_H) {
              const scale = IMG_MAX_H / imageDrawH;
              imageDrawH = Math.round(imageDrawH * scale);
              imageDrawW = Math.round(imageDrawW * scale);
            }
            imageH = imageDrawH + 4; // +4 de respiro
            drawImage = true;
          }

          // Se houver URL de anexo (para não-imagem), exibir "Baixar"
          let attachH = 0;
          const hasDownload = !!(meta && meta.url && !drawImage);
          if (hasDownload) {
            doc.font('Helvetica').fontSize(10);
            const line1 = meta.filename ? `📎 ${meta.filename}` : '📎 Anexo';
            attachH = doc.heightOfString(line1, { width: innerW })
                    + doc.heightOfString('Baixar', { width: innerW });
          }

          const bubbleH = PAD_Y*2 + headH + (text ? (textH + 6) : 0) + imageH + (hasDownload ? (attachH + 6) : 0);

          ensurePage(bubbleH);

          // Fundo
          doc.save();
          doc.fillColor(isOutbound ? palette.outboundBg : palette.inboundBg)
             .roundedRect(x, doc.y, maxW, bubbleH, BUBBLE_R).fill();

          // Cabeçalho
          doc.fillColor(isOutbound ? '#bfdbfe' : palette.subText)
             .font('Helvetica-Bold').fontSize(8)
             .text(`${who} — ${when}`, x + PAD_X, doc.y + PAD_Y, { width: innerW });

          // Texto
          let cursorY = doc.y + PAD_Y + headH + 4;
          if (text) {
            doc.font('Helvetica').fontSize(11)
               .fillColor(isOutbound ? palette.outboundText : palette.inboundText)
               .text(text, x + PAD_X, cursorY, { width: innerW });
            cursorY = doc.y + 6;
          }

          // Imagem
          if (drawImage) {
            try {
              doc.image(imgBuf, x + PAD_X, cursorY, { width: imageDrawW, height: imageDrawH });
              cursorY += (imageDrawH + 6);
            } catch {
              // se falhar, cai para link de download
              if (meta && meta.url) {
                doc.font('Helvetica').fontSize(10)
                   .fillColor(isOutbound ? '#dbeafe' : '#111827')
                   .text(meta.filename ? `📎 ${meta.filename}` : '📎 Anexo', x + PAD_X, cursorY, { width: innerW });
                doc.fillColor(palette.link)
                   .text('Baixar', x + PAD_X, doc.y, { width: innerW, link: meta.url, underline: true });
                cursorY = doc.y + 6;
              }
            }
          }

          // Download (para não-imagem)
          if (hasDownload) {
            doc.font('Helvetica').fontSize(10)
               .fillColor(isOutbound ? '#dbeafe' : '#111827')
               .text(meta.filename ? `📎 ${meta.filename}` : '📎 Anexo', x + PAD_X, cursorY, { width: innerW });
            doc.fillColor(palette.link)
               .text('Baixar', x + PAD_X, doc.y, { width: innerW, link: meta.url, underline: true });
          }

          doc.restore();
          doc.y = (doc.y + bubbleH + GAP_Y);
        };

        // ===== Loop: agrupa por dia e desenha =====
        let lastDayKey = '';
        for (const m of messages) {
          const dir = String(m.direction || '').toLowerCase();
          const isOutbound = (dir === 'outgoing' || dir === 'system'); // direita
          const who = isOutbound ? (m.assigned_to || 'Atendente')
                                 : (ticket.customer_name || 'Cliente');
          const when = new Date(m.timestamp).toLocaleString('pt-BR');

          // separador por dia
          const dayKey = new Date(m.timestamp).toISOString().slice(0, 10);
          if (dayKey !== lastDayKey) {
            drawDayChip(dayKey);
            lastDayKey = dayKey;
          }

          const txt  = parseText(m.content);
          const meta = extractMeta(m.metadata);
          const merged = extractUrlAndFile(meta, m.type, meta?.url);

          // se for imagem, tenta baixar buffer para embutir
          let imgBuf = null, imgSize = null;
          if (looksLikeImage(merged)) {
            imgBuf = await loadImageIfAny(merged, true);
            if (imgBuf) imgSize = getImageSize(imgBuf);
          }

          drawBubble({ who, when, text: txt, meta: merged, isOutbound, imgBuf, imgSize });
        }

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
