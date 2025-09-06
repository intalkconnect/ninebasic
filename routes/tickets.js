
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

// routes/tickets.js (versão simplificada corrigida) — GET /tickets/history/:id/pdf
fastify.get('/history/:id/pdf', async (req, reply) => {
  try {
    const { id } = req.params || {};

    // 1) Buscar dados do ticket e mensagens
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
    const num = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : '';
    const filename = `ticket-${num}.pdf`;
    
    reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`);

    // 3) Configuração do PDF
    const doc = new PDFDocument({ 
      size: 'A4', 
      margin: 40,
      info: {
        Title: `Ticket #${num}`,
        Subject: 'Histórico de Atendimento',
        Producer: 'Sistema de Tickets'
      }
    });

    // Stream para capturar os chunks do PDF
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      reply.send(pdfBuffer);
    });
    doc.on('error', (err) => {
      req.log.error({ err }, 'Erro no documento PDF');
      if (!reply.sent) reply.code(500).send({ error: 'Erro ao gerar PDF' });
    });

    // ==== CONSTANTES DE LAYOUT ====
    const M = 40; // margem
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;
    const maxBubbleW = Math.min(320, contentW * 0.65); // Diminuído o tamanho das bolhas
    const gapY = 10;
    const bubblePadX = 12;
    const bubblePadY = 8;

    // CORES SIMPLES
    const colors = {
      primary: '#1F2937',
      secondary: '#6B7280', 
      accent: '#3B82F6',
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

    // ==== HELPER FUNCTIONS ====
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
      base.url = base.url || m.url || m.file_url || m.download_url || m.signed_url || m.public_url || null;
      base.filename = base.filename || m.filename || m.name || null;
      base.mime_type = base.mime_type || m.mime || m.mimetype || m.content_type || null;
      base.caption = base.caption || m.caption || null;
      base.size = base.size || m.size || m.filesize || null;
      return base;
    };

    const isImageUrl = (u) => /\.(png|jpe?g|webp|gif)$/i.test(u || '');
    const isImageMime = (m) => /^image\/(png|jpe?g|webp|gif)$/i.test(String(m || ''));

    // Função para sanitizar texto UTF-8
    const sanitizeText = (text) => {
      if (!text) return '';
      return String(text)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove caracteres de controle
        .replace(/[\uFFF0-\uFFFF]/g, '') // Remove caracteres especiais problemáticos
        .trim();
    };

    const cleanupForwardPrefix = (s) => {
      if (!s) return s;
      const cleaned = String(s).replace(/^\*[^:*]{1,60}:\*\s*/i, '');
      return sanitizeText(cleaned);
    };

    function ensureSpace(need) {
      if (doc.y + need <= pageH - M) return;
      doc.addPage();
      // Header da página
      doc.save();
      doc.fillColor(colors.secondary).fontSize(9).font('Helvetica');
      doc.text(`Ticket #${num} - Página ${doc.bufferedPageRange().count}`, M, M);
      doc.moveTo(M, M + 15).lineTo(M + contentW, M + 15)
         .strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      doc.restore();
      doc.y = M + 25;
    }

    function drawSectionTitle(title) {
      ensureSpace(30);
      doc.save();
      const bgHeight = 24;
      doc.rect(M, doc.y, contentW, bgHeight)
         .fill(colors.system.bg)
         .strokeColor(colors.system.border)
         .lineWidth(1)
         .stroke();
      
      doc.fillColor(colors.primary)
         .font('Helvetica-Bold')
         .fontSize(11);
      doc.text(sanitizeText(title), M + 10, doc.y + 6);
      doc.restore();
      doc.y += bgHeight + 10;
    }

    // ==== CABEÇALHO PRINCIPAL ====
    ensureSpace(80);
    
    doc.save();
    doc.rect(M, doc.y, contentW, 40)
       .fill(colors.accent)
       .stroke();
    
    doc.fillColor('#FFFFFF')
       .font('Helvetica-Bold')
       .fontSize(18);
    doc.text(`Ticket #${num}`, M + 15, doc.y + 8);
    
    doc.fontSize(10)
       .font('Helvetica');
    doc.text(`Criado em ${new Date(ticket.created_at).toLocaleString('pt-BR')}`, M + 15, doc.y + 6);
    doc.restore();
    doc.y += 50;

    // ==== INFORMAÇÕES DO TICKET ====
    drawSectionTitle('Informações do Ticket');
    
    const infoItems = [
      ['Cliente', sanitizeText(ticket.customer_name || ticket.user_id || '')],
      ['Status', sanitizeText(ticket.status || '')],
      ['Contato', sanitizeText(ticket.customer_phone || ticket.customer_email || '')],
      ['Fila', sanitizeText(ticket.fila || '')],
      ['Atendente', sanitizeText(ticket.assigned_to || '')],
      ['Atualizado', new Date(ticket.updated_at).toLocaleString('pt-BR')]
    ];

    let infoY = doc.y;
    for (const [label, value] of infoItems) {
      doc.save();
      doc.fillColor(colors.secondary)
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(`${label}:`, M, infoY);
      
      doc.fillColor(colors.primary)
         .font('Helvetica')
         .fontSize(10)
         .text(value || '—', M + 80, infoY);
      doc.restore();
      infoY += 15;
    }
    
    doc.y = infoY + 10;

    // ==== SEÇÃO DE CONVERSA ====
    drawSectionTitle('Histórico da Conversa');

    if (!rows.length) {
      doc.save();
      doc.rect(M, doc.y, contentW, 40)
         .fill('#FEF3F2')
         .strokeColor('#FECACA')
         .stroke();
      doc.fillColor('#DC2626')
         .fontSize(11)
         .font('Helvetica');
      doc.text('Não há mensagens registradas neste ticket.', 
               M + 15, doc.y + 15, { width: contentW - 30, align: 'center' });
      doc.restore();
      doc.end();
      return;
    }

    // ==== FUNÇÃO PARA DESENHAR BOLHAS SIMPLES ====
    function drawSimpleBubble({ who, when, side, text, hasAttachment, attachmentUrl, type }) {
      if (side === 'center') {
        const pill = sanitizeText(text || `${who} - ${when}`);
        const w = Math.min(300, contentW * 0.6);
        const h = 20;
        ensureSpace(h + gapY);
        
        const x = M + (contentW - w) / 2;
        doc.save()
          .roundedRect(x, doc.y, w, h, 8)
          .fill(colors.system.bg)
          .strokeColor(colors.system.border)
          .lineWidth(1)
          .stroke();
        
        doc.fillColor(colors.system.text)
           .font('Helvetica')
           .fontSize(9)
           .text(pill, x + 10, doc.y + 6, { width: w - 20, align: 'center' });
        doc.restore();
        doc.y += h + gapY;
        return;
      }

      const isRight = side === 'right';
      const theme = isRight ? colors.outgoing : colors.incoming;
      const innerW = maxBubbleW - bubblePadX * 2;

      // Calcular dimensões
      const meta = sanitizeText(`${who} • ${when}`);
      const body = sanitizeText(cleanupForwardPrefix(text));
      const metaH = doc.heightOfString(meta, { width: innerW });
      const textH = body ? doc.heightOfString(body, { width: innerW }) : 0;
      const attachmentH = hasAttachment ? 15 : 0;

      const totalH = bubblePadY + metaH + (body ? 6 + textH : 0) + attachmentH + bubblePadY;
      
      ensureSpace(totalH + gapY);

      const bx = isRight ? (M + contentW - maxBubbleW) : M;
      const by = doc.y;

      // Desenhar bolha simples
      doc.save();
      doc.roundedRect(bx, by, maxBubbleW, totalH, 8)
         .fill(theme.bg)
         .strokeColor(theme.border)
         .lineWidth(1)
         .stroke();

      // Metadados (quem/quando)
      doc.fillColor(theme.meta)
         .font('Helvetica-Bold')
         .fontSize(8)
         .text(meta, bx + bubblePadX, by + bubblePadY, { width: innerW });
      let cy = by + bubblePadY + metaH;

      // Texto da mensagem
      if (body) {
        cy += 6;
        doc.fillColor(theme.text)
           .font('Helvetica')
           .fontSize(10)
           .text(body, bx + bubblePadX, cy, { width: innerW });
        cy = doc.y;
      }

      // Anexo/Link simples
      if (hasAttachment && attachmentUrl) {
        cy += 4;
        doc.fillColor(theme.text)
           .fontSize(9);
        
        if (isImageUrl(attachmentUrl) || isImageMime(type)) {
          doc.text('📷 Clique aqui para ver imagem', bx + bubblePadX, cy, {
            link: attachmentUrl,
            underline: true,
            width: innerW
          });
        } else {
          doc.text('📎 Clique aqui para ver anexo', bx + bubblePadX, cy, {
            link: attachmentUrl,
            underline: true,
            width: innerW
          });
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
        label = 'Hoje';
      } else if (dateStr === yesterday.toDateString()) {
        label = 'Ontem';
      } else {
        label = date.toLocaleDateString('pt-BR', { 
          day: '2-digit', 
          month: 'long', 
          year: 'numeric' 
        });
      }
      
      const w = Math.min(200, contentW * 0.5);
      const h = 18;
      ensureSpace(h + 12);
      
      const x = M + (contentW - w) / 2;
      doc.save()
        .roundedRect(x, doc.y, w, h, 8)
        .fill('#EEF2FF')
        .strokeColor('#C7D2FE')
        .lineWidth(1)
        .stroke();
      
      doc.fillColor('#4338CA')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(sanitizeText(label), x + 10, doc.y + 5, { width: w - 20, align: 'center' });
      doc.restore();
      doc.y += h + 12;
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

      const who = sanitizeText(
        dir === 'outgoing' ? (m.assigned_to || ticket.assigned_to || 'Atendente') :
        dir === 'system' ? 'Sistema' :
        (ticket.customer_name || ticket.user_id || 'Cliente')
      );

      const when = ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const text = typeof c === 'string' ? c : (c?.text || c?.body || c?.caption || '');

      const url = c?.url || null;
      const hasAttachment = !!url;

      const side = dir === 'outgoing' ? 'right' : dir === 'incoming' ? 'left' : 'center';

      drawSimpleBubble({
        who, when, side, text, type,
        hasAttachment,
        attachmentUrl: url
      });
    }

    // ==== RODAPÉ FINAL ====
    ensureSpace(40);
    doc.y += 15;
    
    doc.save();
    doc.moveTo(M, doc.y).lineTo(M + contentW, doc.y)
       .strokeColor('#E5E7EB').lineWidth(1).stroke();
    
    doc.fillColor(colors.secondary)
       .fontSize(8)
       .font('Helvetica');
    doc.text(`Relatório gerado em ${new Date().toLocaleString('pt-BR')}`, M, doc.y + 8);
    doc.text(`Total: ${rows.length} mensagem(ns)`, M + contentW - 100, doc.y + 8);
    doc.restore();

    doc.end();
  } catch (err) {
    req.log.error({ err }, 'Erro ao gerar PDF');
    if (!reply.sent) reply.code(500).send({ error: 'Erro ao gerar PDF' });
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
