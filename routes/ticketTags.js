// routes/ticketTags.js
/**
 * Endpoints:
 * - GET    /tags/ticket/catalog?fila=NomeDaFila&q=&active=true|false&page=&page_size=
 * - POST   /tags/ticket/catalog         → cria/ativa/atualiza tag em uma fila { fila, tag, label?, color?, active? }
 * - PATCH  /tags/ticket/catalog/:fila/:tag
 * - DELETE /tags/ticket/catalog/:fila/:tag
 *
 * - GET    /tags/ticket/:ticket_number          → lista tags do ticket
 * - GET    /tags/ticket/:ticket_number/catalog  → lista catálogo aplicável (fila do ticket)
 * - POST   /tags/ticket/:ticket_number          → adiciona 1..N tags ao ticket { tags: [...] }
 * - DELETE /tags/ticket/:ticket_number/:tag     → remove 1 tag do ticket
 */

async function ticketTagsRoutes(fastify) {
  // ===== Helpers =====
  async function getFilaIdByNome(db, nomeFila) {
    const { rows } = await db.query(
      `SELECT id FROM filas WHERE nome = $1 LIMIT 1`,
      [nomeFila]
    );
    return rows[0]?.id || null;
  }

  async function getTicketFilaNome(db, ticketNumber) {
    const { rows } = await db.query(
      `SELECT fila FROM tickets WHERE ticket_number = $1 LIMIT 1`,
      [ticketNumber]
    );
    return rows[0]?.fila || null;
  }

  // ============================
  // Catálogo por fila (queue_ticket_tag_catalog)
  // ============================

  // GET /tags/ticket/catalog?fila=NomeDaFila&q=&active=true|false&page=&page_size=
  fastify.get('/ticket/catalog', async (req, reply) => {
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

      const sqlCount = `SELECT COUNT(*)::bigint AS total FROM queue_ticket_tag_catalog ${whereSql}`;
      const sqlList  = `
        SELECT fila_id, tag, label, color, active, created_at
          FROM queue_ticket_tag_catalog
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
  fastify.post('/ticket/catalog', async (req, reply) => {
    const { fila, tag, label = null, color = null, active = true } = req.body || {};
    const f = String(fila || '').trim();
    const t = String(tag || '').trim();
    if (!f || !t) return reply.code(400).send({ error: 'Campos fila e tag são obrigatórios' });

    try {
      const filaId = await getFilaIdByNome(req.db, f);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      const sql = `
        INSERT INTO queue_ticket_tag_catalog (fila_id, tag, label, color, active)
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
  fastify.patch('/ticket/catalog/:fila/:tag', async (req, reply) => {
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
        UPDATE queue_ticket_tag_catalog
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
  fastify.delete('/ticket/catalog/:fila/:tag', async (req, reply) => {
    const fila = String(req.params?.fila || '').trim();
    const tag  = String(req.params?.tag  || '').trim();
    if (!fila || !tag) return reply.code(400).send({ error: 'Parâmetros fila e tag são obrigatórios' });

    try {
      const filaId = await getFilaIdByNome(req.db, fila);
      if (!filaId) return reply.code(404).send({ error: 'Fila não encontrada' });

      // impedir exclusão se estiver em uso
      const inUse = await req.db.query(
        `SELECT 1 FROM ticket_tags WHERE fila_id = $1 AND tag = $2 LIMIT 1`,
        [filaId, tag]
      );
      if (inUse.rowCount) {
        return reply.code(409).send({ error: 'Tag está vinculada a tickets — remova os vínculos antes' });
      }

      const { rowCount } = await req.db.query(
        `DELETE FROM queue_ticket_tag_catalog WHERE fila_id = $1 AND tag = $2`,
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
  fastify.get('/ticket/:ticket_number', async (req, reply) => {
    const { ticket_number } = req.params || {};
    const tn = String(ticket_number || '').trim();
    if (!tn) return reply.code(400).send({ error: 'ticket_number é obrigatório' });

    try {
      // checa ticket + resolve fila
      const { rows: rt } = await req.db.query(
        `SELECT ticket_number, fila FROM tickets WHERE ticket_number = $1 LIMIT 1`,
        [tn]
      );
      const t = rt[0];
      if (!t) return reply.code(404).send({ error: 'Ticket não encontrado' });

      const { rows } = await req.db.query(
        `SELECT tt.ticket_number, tt.fila_id, qttc.tag, qttc.label, qttc.color, qttc.active, tt.created_at,
                f.nome AS fila
           FROM ticket_tags tt
           JOIN queue_ticket_tag_catalog qttc
             ON qttc.fila_id = tt.fila_id AND qttc.tag = tt.tag
           JOIN filas f ON f.id = tt.fila_id
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
  fastify.get('/ticket/:ticket_number/catalog', async (req, reply) => {
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
           FROM queue_ticket_tag_catalog
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
  fastify.post('/ticket/:ticket_number', async (req, reply) => {
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
        `SELECT tag FROM queue_ticket_tag_catalog
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
        INSERT INTO ticket_tags (ticket_number, fila_id, tag)
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
  fastify.delete('/ticket/:ticket_number/:tag', async (req, reply) => {
    const tn  = String(req.params?.ticket_number || '').trim();
    const tag = String(req.params?.tag || '').trim();
    if (!tn || !tag) return reply.code(400).send({ error: 'ticket_number e tag são obrigatórios' });

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM ticket_tags WHERE ticket_number = $1 AND tag = $2`,
        [tn, tag]
      );
      return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'Vínculo não encontrado' });
    } catch (err) {
      req.log.error({ err }, 'DELETE /tags/ticket/:ticket_number/:tag');
      return reply.code(500).send({ error: 'Erro ao remover tag do ticket' });
    }
  });
}

export default ticketTagsRoutes;
