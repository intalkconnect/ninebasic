
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

fastify.get('/history/:id/pdf', async (req, reply) => {
    try {
      const { id } = req.params || {};

      // 1) ticket + cliente
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
      const ticket = tRes.rows[0];

      // 2) mensagens (ordem cronológica)
      const mRes = await req.db.query(
        `
        SELECT m.id::text AS id, m.direction, m."type", m."content", m."timestamp",
               m.metadata, m.assigned_to
          FROM messages m
         WHERE m.ticket_number = $1
         ORDER BY m."timestamp" ASC, m.id ASC
         LIMIT 2000
        `,
        [String(ticket.ticket_number || '')]
      );
      const rows = mRes.rows || [];

      // 3) headers + stream (enviar uma única vez)
      const num = ticket.ticket_number ? String(ticket.ticket_number).padStart(6, '0') : '—';
      const filename = `ticket-${num}.pdf`;
      reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`);

      const out = new PassThrough();
      reply.send(out); // ✅ inicia o streaming

      // 4) helpers
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

      // desenha um retângulo arredondado (compatível c/ versões antigas do pdfkit)
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

      // 5) PDF
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      doc.on('error', (e) => out.destroy(e));
      doc.pipe(out);

      // layout base (soft)
      const M = 40; // margem
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const contentW = pageW - M * 2;

      const gapY = 12;
      const bubblePadX = 10;
      const bubblePadY = 8;
      const maxBubbleW = Math.min(420, contentW * 0.78);

      // paleta neutra e suave
      const colText       = '#1F2937'; // slate-800
      const colMeta       = '#8A8F98'; // cinza brando
      const colSep        = '#E5E7EB'; // linha
      const colDayPill    = '#EEF2F7';
      const colIncomingBg = '#F6F7F9'; // bolha clara (cliente)
      const colOutgoingBg = '#ECEFF3'; // bolha clara (agente)

      // cabeçalho do ticket (fora de bolha)
      doc.fillColor(colText).font('Helvetica-Bold').fontSize(18)
         .text(`Ticket #${num}`, M, undefined, { width: contentW, align: 'left' });
      doc.moveDown(0.2);
      doc.fillColor(colMeta).font('Helvetica').fontSize(10)
         .text(`Criado em: ${new Date(ticket.created_at).toLocaleString('pt-BR')}`, {
           width: contentW, align: 'left'
         });
      doc.moveDown(0.6);

      // bloco infos (duas colunas)
      const leftX  = M;
      const rightX = M + contentW / 2;
      const lh     = 14;

      function labelValue(label, value, x, y) {
        doc.fillColor(colMeta).font('Helvetica-Bold').fontSize(9).text(label, x, y);
        doc.fillColor(colText).font('Helvetica').fontSize(11).text(value || '—', x, y + 10);
        return y + 10 + lh;
      }
      let y1 = doc.y, y2 = doc.y;
      y1 = labelValue('Cliente',  ticket.customer_name || ticket.user_id, leftX,  y1);
      y1 = labelValue('Contato',  ticket.customer_phone || ticket.customer_email || '—', leftX,  y1);
      y2 = labelValue('Fila',     ticket.fila,          rightX, y2);
      y2 = labelValue('Atendente',ticket.assigned_to,   rightX, y2);

      const yMax = Math.max(y1, y2);
      doc.strokeColor(colSep).lineWidth(1)
         .moveTo(M, yMax + 8).lineTo(M + contentW, yMax + 8).stroke();
      doc.y = yMax + 16;

      // título conversa
      doc.fillColor(colText).font('Helvetica-Bold').fontSize(12).text('Conversa', { width: contentW });
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
        // cabeçalho mínimo da continuação (texto pequeno, sem “bolha”)
        doc.fillColor(colMeta).font('Helvetica').fontSize(10)
           .text(`Ticket #${num} — continuação`, M, M);
        doc.moveDown(0.5);
      }

      // separador por dia (pílula central suave)
      let lastDay = '';
      function daySeparator(date) {
        const label = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const padX = 8, padY = 3;
        const w = doc.widthOfString(label) + padX * 2;
        const h = doc.currentLineHeight() + padY * 2;
        const x = M + (contentW - w) / 2;
        ensureSpace(h + 8);
        // “pílula” arredondada
        fillRoundedRect(doc, x, doc.y, w, h, 6, colDayPill);
        doc.fillColor('#4B5563').font('Helvetica').fontSize(9)
           .text(label, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
        doc.moveDown(0.6);
      }

      // desenha bolha (incoming à esquerda, outgoing à direita)
      function drawBubble({ who, when, side, body, links }) {
        const isRight = side === 'right';
        const bg = isRight ? colOutgoingBg : colIncomingBg;
        const metaLine = `${who} — ${when}`;
        const innerW = maxBubbleW - bubblePadX * 2;

        // medir alturas
        const metaH = doc.heightOfString(metaLine, { width: innerW, align: 'left' });
        const bodyH = body ? doc.heightOfString(body, { width: innerW, align: 'left' }) : 0;
        const linksH = (links && links.length)
          ? links.reduce((acc, l) => acc + doc.heightOfString(l.label, { width: innerW }) + 4, 0)
          : 0;

        const totalH = bubblePadY + metaH + (body ? 6 + bodyH : 0)
                     + (links && links.length ? 8 + linksH : 0) + bubblePadY;

        ensureSpace(totalH + gapY);

        const bx = isRight ? (M + contentW - maxBubbleW) : M;
        const by = doc.y;

        // “card” arredondado suave, sem borda
        fillRoundedRect(doc, bx, by, maxBubbleW, totalH, 10, bg);

        // meta (nome + horário)
        doc.fillColor(colMeta).font('Helvetica').fontSize(9)
           .text(metaLine, bx + bubblePadX, by + bubblePadY, { width: innerW });

        let cy = by + bubblePadY + metaH;

        // corpo
        if (body) {
          cy += 6;
          doc.fillColor(colText).font('Helvetica').fontSize(11)
             .text(body, bx + bubblePadX, cy, { width: innerW });
          cy = doc.y;
        }

        // links (mídias/anexos) — “Clique aqui para abrir a mídia”
        if (links && links.length) {
          cy += 8;
          doc.fillColor('#1D4ED8').font('Helvetica').fontSize(10);
          for (const l of links) {
            const label = l.filename ? `${l.filename} — Clique aqui para abrir a mídia`
                                     : 'Clique aqui para abrir a mídia';
            doc.text(label, bx + bubblePadX, cy, {
              width: innerW,
              link: l.url,
              underline: true
            });
            cy = doc.y + 4;
          }
        }

        doc.y = by + totalH + gapY;
      }

      // loop das mensagens
      for (const m of rows) {
        const ts = new Date(m.timestamp);
        const dayKey = ts.toISOString().slice(0, 10);
        if (dayKey !== lastDay) { daySeparator(ts); lastDay = dayKey; }

        const dir  = String(m.direction || '').toLowerCase(); // incoming | outgoing | system
        const type = String(m.type || '').toLowerCase();
        const meta = typeof m.metadata === 'string' ? safeParse(m.metadata) : (m.metadata || {});
        const c = normalize(m.content, meta, type);

        // eventos de sistema: pílula central (sem bolha)
        if (dir === 'system') {
          const text = (typeof c === 'string' ? c : (c?.text || c?.body || c?.caption || '[evento]'));
          const padX = 10, padY = 6;
          const w = Math.min(320, contentW * 0.6);
          const txtH = doc.heightOfString(text, { width: w - padX * 2 });
          const h = padY * 2 + txtH;
          ensureSpace(h + gapY);
          const x = M + (contentW - w) / 2;
          fillRoundedRect(doc, x, doc.y, w, h, 8, colDayPill);
          doc.fillColor('#4B5563').font('Helvetica').fontSize(10)
             .text(text, x + padX, doc.y + padY, { width: w - padX * 2, align: 'center' });
          doc.moveDown(0.5);
          continue;
        }

        // remetente/atendente
        const who = dir === 'outgoing'
          ? (m.assigned_to || ticket.assigned_to || 'Atendente')
          : (ticket.customer_name || ticket.user_id || 'Cliente');
        const when = ts.toLocaleString('pt-BR');

        // texto
        const body =
          typeof c === 'string' ? c :
          (c?.text || c?.body || c?.caption || null);

        // mídias como links
        const url = c?.url || null;
        const links = url ? [{
          url,
          filename: c?.filename || null
        }] : [];

        drawBubble({
          who,
          when,
          side: dir === 'outgoing' ? 'right' : 'left',
          body,
          links
        });
      }

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
