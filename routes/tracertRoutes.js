// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Params: q, stage, min_loops, min_time_sec, exclude_human, order_by, order_dir, page, pageSize
   */
  fastify.get('/customers', async (req, reply) => {
    const {
      q,
      stage,
      min_loops,
      min_time_sec,
      exclude_human = 'true',
      order_by = 'time_in_stage_sec',
      order_dir = 'desc',
      page = '1',
      pageSize = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sizeNum = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
    const offset = (pageNum - 1) * sizeNum;

    const allowedOrderBy = new Set(['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at']);
    const orderByKey = allowedOrderBy.has(String(order_by)) ? String(order_by) : 'time_in_stage_sec';
    const orderBySql = orderByKey === 'stage_entered_at' ? 'v.stage_entered_at' : `v.${orderByKey}`;
    const orderDir = String(order_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const where = [];
    const params = [];

    if (q && String(q).trim() !== '') {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      where.push(`(lower(v.name) LIKE $${params.length} OR lower(v.user_id) LIKE $${params.length})`);
    }

    if (stage && String(stage).trim() !== '') {
      params.push(String(stage).trim());
      // note: stage here is matched against current_stage (id) OR label depending on your front-end.
      // if front sends label, you'd need to resolve label->id; here we assume stage === block_id or label stored equivalently
      where.push(`v.current_stage = $${params.length}`);
    }

    if (min_loops && Number.isFinite(Number(min_loops))) {
      params.push(parseInt(min_loops, 10));
      where.push(`v.loops_in_stage >= $${params.length}`);
    }

    if (min_time_sec && Number.isFinite(Number(min_time_sec))) {
      params.push(parseInt(min_time_sec, 10));
      where.push(`v.time_in_stage_sec >= $${params.length}`);
    }

    if (String(exclude_human).toLowerCase() === 'true') {
      // exclude rows whose current stage is a human queue (we rely on current_stage_type populated in view)
      where.push(`(v.current_stage_type IS NULL OR v.current_stage_type <> 'human')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      // total
      const countSql = `
        SELECT count(*)::int AS total
        FROM hmg.v_bot_customer_list v
        ${whereSql}
      `;
      const { rows: countRows } = await req.db.query(countSql, params);
      const total = countRows?.[0]?.total ?? 0;

      // data — pega label/type do fluxo ativo OR sessions.vars OR última transição visível (lateral)
      const dataSql = `
        SELECT
          v.cliente_id,
          v.user_id,
          v.name,
          v.channel,
          v.current_stage,
          COALESCE(
            (f.data->'blocks'->>v.current_stage),
            s.vars->>'current_block_label',
            t.block_label
          ) AS current_stage_label,
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS current_stage_type,
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type, bt.entered_at
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.visible = true
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        ${whereSql}
        ORDER BY ${orderBySql} ${orderDir}, v.user_id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      const { rows } = await req.db.query(dataSql, [...params, sizeNum, offset]);

      return reply.send({
        page: pageNum,
        pageSize: sizeNum,
        total,
        rows,
      });
    } catch (error) {
      fastify.log.error('Erro ao listar tracert do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao listar tracert do bot',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes para modal — retorna journey (visible=true) e dwell (último dwell do estágio atual)
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    const { userId } = req.params;

    try {
      // base info (linha do grid) para este user
      const baseSql = `
        SELECT
          v.cliente_id,
          v.user_id,
          v.name,
          v.channel,
          v.current_stage,
          COALESCE(
            (f.data->'blocks'->>v.current_stage),
            s.vars->>'current_block_label',
            t.block_label
          ) AS current_stage_label,
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS current_stage_type,
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage,
          s.vars->>'last_reset_at' AS last_reset_at -- optional if you store this
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type, bt.entered_at
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.visible = true
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        WHERE v.user_id = $1
        LIMIT 1
      `;
      const { rows: baseRows } = await req.db.query(baseSql, [userId]);
      if (baseRows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
      }
      const base = baseRows[0];

      // Journey: usa left_at quando disponível, senão recorre a lead(entered_at)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', bt.block_label,
              'block_id', bt.block_id,
              'type', bt.block_type,
              'timestamp', bt.entered_at,
              'duration_sec',
              bt.vars,
              'visible', bt.visible
            ) ORDER BY bt.entered_at
          ),
          '[]'::jsonb
        ) AS journey
        FROM (
          SELECT
            bt.*,
            -- prioridade: left_at; fallback lead(entered_at) (próxima entered_at) - bt.entered_at
            COALESCE(
              EXTRACT(EPOCH FROM (bt.left_at - bt.entered_at)),
              EXTRACT(EPOCH FROM (lead(bt.entered_at) OVER (PARTITION BY bt.user_id ORDER BY bt.entered_at) - bt.entered_at))
            )::int AS duration_sec
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = $1
            AND bt.visible = true
          ORDER BY bt.entered_at
        ) bt;
      `;
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      const journey = journeyRows?.[0]?.journey ?? [];

      // Diagnóstico do dwell atual (último dwell para o bloco atual) - usando view v_bot_stage_dwells
      const dwellSql = `
        WITH current_dwell AS (
          SELECT d.*
          FROM hmg.v_bot_stage_dwells d
          WHERE d.user_id = $1 AND d.block = $2
          ORDER BY d.entered_at DESC
          LIMIT 1
        )
        SELECT
          cd.user_id,
          cd.block,
          cd.entered_at,
          cd.left_at,
          cd.duration_sec,
          dd.bot_msgs,
          dd.user_msgs,
          dd.validation_fails,
          dd.max_user_response_gap_sec
        FROM current_dwell cd
        LEFT JOIN hmg.v_bot_dwell_diagnostics dd
          ON dd.user_id = cd.user_id
         AND dd.block    = cd.block
         AND dd.entered_at = cd.entered_at
      `;
      const { rows: dwellRows } = await req.db.query(dwellSql, [userId, base.current_stage]);
      const dwell = dwellRows?.[0] || null;

      return reply.send({
        ...base,
        journey,
        dwell,
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar detalhes do tracert do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar detalhes do tracert do bot',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Marca transições antigas como visible = false e insere evento RESET.
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;
    const client = req.db;

    try {
      await client.query('BEGIN');

      // 1) marca todas as transições anteriores como invisíveis
      await client.query(
        `UPDATE hmg.bot_transitions
         SET visible = false
         WHERE user_id = $1 AND visible = true`,
        [userId]
      );

      // 2) registra evento RESET (visível) para indicar novo início
      await client.query(
        `INSERT INTO hmg.bot_transitions
          (user_id, channel, flow_id, block_id, block_label, block_type, entered_at, vars, ticket_number, visible)
         VALUES ($1, null, null, 'start', 'RESET TO START', 'system', now(), '{}'::jsonb, null, true)`,
        [userId]
      );

      await client.query('COMMIT');
      return reply.send({ ok: true, reset_at: new Date().toISOString() });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) {}
      fastify.log.error('Erro ao resetar sessão do tracert:', err);
      return reply.code(500).send({ error: 'Falha ao resetar sessão' });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas: p95/avg por bloco, loops, distribuição atual
   */
  fastify.get('/metrics', async (req, reply) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '10', 10)));
    try {
      // p95 / avg (usa left_at quando houver, fallback lead())
      const dwellAggSql = `
        SELECT
          block,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_sec) AS p95_sec,
          avg(duration_sec)::int AS avg_sec,
          count(*) AS samples
        FROM (
          SELECT
            COALESCE(bt.block_label, bt.block_id) AS block,
            COALESCE(
              EXTRACT(EPOCH FROM (bt.left_at - bt.entered_at)),
              EXTRACT(EPOCH FROM (lead(bt.entered_at) OVER (PARTITION BY bt.user_id ORDER BY bt.entered_at) - bt.entered_at))
            )::int AS duration_sec
          FROM hmg.bot_transitions bt
          WHERE bt.visible = true
        ) x
        WHERE x.duration_sec IS NOT NULL
        GROUP BY block
        ORDER BY p95_sec DESC
        LIMIT $1
      `;
      const { rows: bottlenecks } = await req.db.query(dwellAggSql, [limit]);

      // média de loops por bloco (a partir de v_bot_loops)
      const loopsSql = `
        SELECT
          block,
          avg(entries)::numeric(10,2) AS avg_loops
        FROM hmg.v_bot_loops
        GROUP BY block
        ORDER BY avg_loops DESC
        LIMIT $1
      `;
      const { rows: loops } = await req.db.query(loopsSql, [limit]);

      // distribuição atual (quantos usuários por bloco)
      const distSql = `
        SELECT current_stage AS block, count(*)::int AS users
        FROM hmg.v_bot_customer_list
        GROUP BY current_stage
        ORDER BY users DESC
      `;
      const { rows: distribution } = await req.db.query(distSql);

      return reply.send({
        bottlenecks,
        loops,
        distribution,
      });
    } catch (error) {
      fastify.log.error('Erro ao calcular métricas do tracert do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao calcular métricas',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/stages
   * Retorna lista de estágios (label + type) baseados nas transições visíveis e fluxos ativos.
   */
  fastify.get('/stages', async (req, reply) => {
    try {
      const stagesSql = `
        SELECT DISTINCT
          COALESCE(
            (f.data->'blocks'->>v.current_stage),
            s.vars->>'current_block_label',
            t.block_label
          ) AS label,
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS type
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.visible = true
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        WHERE v.current_stage IS NOT NULL
        ORDER BY label ASC
      `;
      const { rows } = await req.db.query(stagesSql);
      const labelsAndTypes = (rows || []).filter(r => r.label).map(r => ({ label: r.label, type: r.type || null }));
      return reply.send(labelsAndTypes);
    } catch (error) {
      fastify.log.error('Erro ao listar estágios do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao listar estágios',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });
}

export default tracertRoutes;
