// routes/pausas.js
async function pausasRoutes(fastify, _opts) {
  // ========== CRUD: pause_reasons ==========
  fastify.get('/', async (req, reply) => {
    try {
      const { active } = req.query || {};
      let q = `SELECT id, code, label, max_minutes, active, created_at, updated_at
               FROM pause_reasons`;
      const params = [];
      if (typeof active !== 'undefined') {
        q += ` WHERE active = $1`;
        params.push(String(active).toLowerCase() === 'true');
      }
      q += ` ORDER BY label`;
      const { rows } = await req.db.query(q, params);
      return reply.send(rows);
    } catch (err) {
      req.log.error(err, '[pausas] list');
      return reply.code(500).send({ error: 'Erro ao listar pausas' });
    }
  });

  fastify.get('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, code, label, max_minutes, active, created_at, updated_at
         FROM pause_reasons WHERE id = $1`,
        [id]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      req.log.error(err, '[pausas] get one');
      return reply.code(500).send({ error: 'Erro ao buscar motivo de pausa' });
    }
  });

  fastify.post('/', async (req, reply) => {
    const { code, label, max_minutes = 0, active = true } = req.body || {};
    if (!code || !label) {
      return reply.code(400).send({ error: 'code e label são obrigatórios' });
    }
    try {
      const { rows } = await req.db.query(
        `INSERT INTO pause_reasons (code, label, max_minutes, active)
         VALUES ($1, $2, $3, $4)
         RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        [code, label, max_minutes, !!active]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      req.log.error(err, '[pausas] create');
      const msg = /duplicate key/i.test(String(err)) ? 'code já existente' : 'Erro ao criar motivo';
      return reply.code(400).send({ error: msg });
    }
  });

  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { code, label, max_minutes = 0, active = true } = req.body || {};
    if (!code || !label) {
      return reply.code(400).send({ error: 'code e label são obrigatórios' });
    }
    try {
      const { rowCount } = await req.db.query(
        `UPDATE pause_reasons SET code=$2, label=$3, max_minutes=$4, active=$5, updated_at=now()
         WHERE id=$1`,
        [id, code, label, max_minutes, !!active]
      );
      if (!rowCount) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[pausas] update');
      return reply.code(500).send({ error: 'Erro ao atualizar motivo' });
    }
  });

  fastify.patch('/:id', async (req, reply) => {
    const { id } = req.params;
    const { code, label, max_minutes, active } = req.body || {};
    const sets = [];
    const vals = [id];
    let idx = 2;
    if (typeof code !== 'undefined') { sets.push(`code=$${idx++}`); vals.push(code); }
    if (typeof label !== 'undefined') { sets.push(`label=$${idx++}`); vals.push(label); }
    if (typeof max_minutes !== 'undefined') { sets.push(`max_minutes=$${idx++}`); vals.push(max_minutes); }
    if (typeof active !== 'undefined') { sets.push(`active=$${idx++}`); vals.push(!!active); }
    if (!sets.length) return reply.code(400).send({ error: 'Nada para atualizar' });

    try {
      const { rowCount } = await req.db.query(
        `UPDATE pause_reasons SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`,
        vals
      );
      if (!rowCount) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[pausas] patch');
      return reply.code(500).send({ error: 'Erro ao atualizar motivo' });
    }
  });

  fastify.patch('/:id/toggle', async (req, reply) => {
    const { id } = req.params;
    try {
      const { rows } = await req.db.query(
        `UPDATE pause_reasons
           SET active = NOT active, updated_at = now()
         WHERE id=$1
         RETURNING id, code, label, max_minutes, active, created_at, updated_at`,
        [id]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      req.log.error(err, '[pausas] toggle');
      return reply.code(500).send({ error: 'Erro ao alternar ativo/inativo' });
    }
  });

  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      // bloqueia se houver sessões vinculadas
      const dep = await req.db.query(
        `SELECT 1 FROM atendente_pause_sessions WHERE reason_id=$1 LIMIT 1`,
        [id]
      );
      if (dep.rowCount) {
        return reply.code(409).send({ error: 'Há sessões vinculadas a este motivo' });
      }
      const { rowCount } = await req.db.query(`DELETE FROM pause_reasons WHERE id=$1`, [id]);
      if (!rowCount) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[pausas] delete');
      return reply.code(500).send({ error: 'Erro ao remover motivo' });
    }
  });

  // ========== SESSÕES DE PAUSA DO ATENDENTE ==========
  // Sessão ativa
  fastify.get('/atendentes/:email/current', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT s.id, s.email, s.reason_id, r.code, r.label, r.max_minutes, s.started_at, s.ended_at, s.duration_sec, s.notes
           FROM atendente_pause_sessions s
           JOIN pause_reasons r ON r.id = s.reason_id
          WHERE s.email = $1 AND s.ended_at IS NULL
          ORDER BY s.started_at DESC
          LIMIT 1`,
        [email]
      );
      return reply.send(rows[0] || null);
    } catch (err) {
      req.log.error(err, '[pausas] current');
      return reply.code(500).send({ error: 'Erro ao buscar pausa atual' });
    }
  });

  // Histórico
  fastify.get('/atendentes/:email/historico', async (req, reply) => {
    const { email } = req.params;
    const { limit = 50, from } = req.query || {};
    const params = [email];
    let where = `WHERE s.email = $1`;
    if (from) {
      params.push(from);
      where += ` AND s.started_at >= $2`;
    }
    try {
      const { rows } = await req.db.query(
        `SELECT s.id, s.email, s.reason_id, r.code, r.label, r.max_minutes, s.started_at, s.ended_at, s.duration_sec, s.notes
           FROM atendente_pause_sessions s
           JOIN pause_reasons r ON r.id = s.reason_id
          ${where}
          ORDER BY s.started_at DESC
          LIMIT ${Number(limit) || 50}`,
        params
      );
      return reply.send(rows);
    } catch (err) {
      req.log.error(err, '[pausas] historico');
      return reply.code(500).send({ error: 'Erro ao listar histórico de pausas' });
    }
  });

  // Iniciar pausa
  fastify.post('/atendentes/:email/start', async (req, reply) => {
    const { email } = req.params;
    const { reason_id, notes } = req.body || {};
    if (!reason_id) return reply.code(400).send({ error: 'reason_id é obrigatório' });

    try {
      // já tem pausa ativa?
      const active = await req.db.query(
        `SELECT id FROM atendente_pause_sessions WHERE email=$1 AND ended_at IS NULL LIMIT 1`,
        [email]
      );
      if (active.rowCount) {
        return reply.code(409).send({ error: 'Já existe pausa ativa' });
      }

      // motivo existe e ativo?
      const reason = await req.db.query(
        `SELECT id, active FROM pause_reasons WHERE id=$1`,
        [reason_id]
      );
      if (!reason.rowCount) return reply.code(404).send({ error: 'Motivo de pausa não encontrado' });
      if (!reason.rows[0].active) return reply.code(409).send({ error: 'Motivo de pausa inativo' });

      // cria sessão
      const ins = await req.db.query(
        `INSERT INTO atendente_pause_sessions (email, reason_id, notes)
         VALUES ($1, $2, $3)
         RETURNING id, email, reason_id, started_at, ended_at, duration_sec, notes`,
        [email, reason_id, notes || null]
      );

      // seta status = 'pausa'
      await req.db.query(
        `UPDATE atendentes SET status='pausa' WHERE email=$1`,
        [email]
      );

      return reply.code(201).send(ins.rows[0]);
    } catch (err) {
      req.log.error(err, '[pausas] start');
      return reply.code(500).send({ error: 'Erro ao iniciar pausa' });
    }
  });

  // Encerrar pausa
  fastify.patch('/atendentes/:email/:id/end', async (req, reply) => {
    const { email, id } = req.params;
    const { ended_at } = req.body || {};
    try {
      // pega sessão
      const { rows } = await req.db.query(
        `SELECT id, started_at, ended_at
           FROM atendente_pause_sessions
          WHERE id=$1 AND email=$2`,
        [id, email]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Sessão de pausa não encontrada' });
      const sess = rows[0];

      if (sess.ended_at) {
        // já encerrada → ok idempotente
        return reply.send({ success: true, id, alreadyEnded: true });
      }

      const endTs = ended_at ? new Date(ended_at) : new Date();
      const dur = Math.max(0, Math.floor((endTs - new Date(sess.started_at)) / 1000));

      await req.db.query(
        `UPDATE atendente_pause_sessions
            SET ended_at=$2, duration_sec=$3
          WHERE id=$1`,
        [id, endTs, dur]
      );

      // volta status para 'online' (ajuste se quiser respeitar status anterior)
      await req.db.query(
        `UPDATE atendentes SET status='online' WHERE email=$1`,
        [email]
      );

      return reply.send({ success: true, id, duration_sec: dur });
    } catch (err) {
      req.log.error(err, '[pausas] end');
      return reply.code(500).send({ error: 'Erro ao encerrar pausa' });
    }
  });
}

export default pausasRoutes;
