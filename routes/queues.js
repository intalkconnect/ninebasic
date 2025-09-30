// routes/queueRules.js
async function queueRulesRoutes(fastify) {
  // ---------------- Helpers ----------------
  function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function validateConditions(conditions) {
    if (!Array.isArray(conditions)) return { ok: false, error: 'conditions deve ser um array' };
    for (const c of conditions) {
      if (!isPlainObject(c)) return { ok: false, error: 'cada condition deve ser um objeto' };
      const { type, variable } = c;
      if (!type || !variable) {
        return { ok: false, error: 'cada condition precisa de "type" e "variable"' };
      }
      // (opcional) validar types conhecidos
      const okTypes = new Set([
        'equals','not_equals','contains','starts_with','ends_with',
        'exists','not_exists','in','not_in','regex','gt','gte','lt','lte'
      ]);
      if (!okTypes.has(String(type).toLowerCase())) {
        return { ok: false, error: `type inválido: ${type}` };
      }
    }
    return { ok: true };
  }

  // ---------------- CRUD ----------------

  // 📄 Listar todas as regras
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
           FROM queue_rules
          ORDER BY queue_name ASC`
      );
      return reply.send({ data: rows });
    } catch (err) {
      fastify.log.error(err, 'GET /queue-rules');
      return reply.code(500).send({ error: 'Erro ao listar regras' });
    }
  });

  // 🔎 Obter uma regra por nome de fila
  fastify.get('/:queue_name', async (req, reply) => {
    const queueName = String(req.params?.queue_name || '').trim();
    if (!queueName) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    try {
      const { rows } = await req.db.query(
        `SELECT queue_name, enabled, conditions, created_at, updated_at
           FROM queue_rules
          WHERE queue_name = $1
          LIMIT 1`,
        [queueName]
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'Regra não encontrada' });
      return reply.send({ data: row });
    } catch (err) {
      fastify.log.error(err, 'GET /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao obter regra' });
    }
  });

  // ➕ Criar regra (falha se já existir)
  fastify.post('/', async (req, reply) => {
    const { queue_name, enabled = true, conditions = [] } = req.body || {};
    const queueName = String(queue_name || '').trim();
    if (!queueName) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    const v = validateConditions(conditions);
    if (!v.ok) return reply.code(400).send({ error: v.error });

    try {
      const { rows } = await req.db.query(
        `INSERT INTO queue_rules (queue_name, enabled, conditions)
         VALUES ($1, $2, $3::jsonb)
         RETURNING queue_name, enabled, conditions, created_at, updated_at`,
        [queueName, !!enabled, JSON.stringify(conditions)]
      );
      return reply.code(201).send({ data: rows[0] });
    } catch (err) {
      fastify.log.error(err, 'POST /queue-rules');
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Já existe regra para essa fila' });
      }
      return reply.code(500).send({ error: 'Erro ao criar regra' });
    }
  });

  // ✏️ Atualizar (upsert) regra da fila
  fastify.put('/:queue_name', async (req, reply) => {
    const queueName = String(req.params?.queue_name || '').trim();
    if (!queueName) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    let { enabled, conditions } = req.body || {};
    // Se vier conditions, valida
    if (typeof conditions !== 'undefined') {
      const v = validateConditions(conditions);
      if (!v.ok) return reply.code(400).send({ error: v.error });
    }

    // Monta SET dinâmico
    const sets = [];
    const vals = [queueName];
    let i = 1;

    if (typeof enabled !== 'undefined') {
      sets.push(`enabled = $${++i}`);
      vals.push(!!enabled);
    }
    if (typeof conditions !== 'undefined') {
      sets.push(`conditions = $${++i}::jsonb`);
      vals.push(JSON.stringify(conditions));
    }

    if (!sets.length) {
      return reply.code(400).send({ error: 'Nada para atualizar' });
    }

    try {
      // Tenta update; se não existir, insere (com defaults sensatos)
      const sqlUpd = `
        UPDATE queue_rules
           SET ${sets.join(', ')}, updated_at = now()
         WHERE queue_name = $1
         RETURNING queue_name, enabled, conditions, created_at, updated_at
      `;
      const rUpd = await req.db.query(sqlUpd, vals);
      if (rUpd.rows.length) return reply.send({ data: rUpd.rows[0] });

      // não existia -> cria (enabled default = true se não foi enviado)
      const enabledFinal = typeof enabled === 'undefined' ? true : !!enabled;
      const condsFinal = typeof conditions === 'undefined' ? [] : conditions;

      const { rows } = await req.db.query(
        `INSERT INTO queue_rules (queue_name, enabled, conditions)
         VALUES ($1, $2, $3::jsonb)
         RETURNING queue_name, enabled, conditions, created_at, updated_at`,
        [queueName, enabledFinal, JSON.stringify(condsFinal)]
      );
      return reply.code(201).send({ data: rows[0] });
    } catch (err) {
      fastify.log.error(err, 'PUT /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao salvar regra' });
    }
  });

  // 🗑️ Excluir regra da fila
  fastify.delete('/:queue_name', async (req, reply) => {
    const queueName = String(req.params?.queue_name || '').trim();
    if (!queueName) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    try {
      const { rows } = await req.db.query(
        `DELETE FROM queue_rules
          WHERE queue_name = $1
          RETURNING queue_name`,
        [queueName]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Regra não encontrada' });
      return reply.send({ ok: true, queue_name: rows[0].queue_name });
    } catch (err) {
      fastify.log.error(err, 'DELETE /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao excluir regra' });
    }
  });
}

export default queueRulesRoutes;
