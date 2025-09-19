// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT (onde está no fluxo, tempo no estágio, loops, gargalos)
//
// Pré-requisito DB (execute uma migration):
// ALTER TABLE hmg.bot_transitions ADD COLUMN IF NOT EXISTS visible boolean DEFAULT true;
// -- Opcional: criar índice em (user_id, entered_at) e em visible se necessário.

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Params:
   *  - q: busca por name ou user_id
   *  - stage: filtra pelo bloco atual (exato)
   *  - exclude_human: se 'true' oculta sessões atualmente em atendimento humano
   *  - min_loops: número mínimo de loops no estágio atual
   *  - min_time_sec: tempo mínimo em segundos no estágio atual
   *  - order_by: campo para ordenar (time_in_stage_sec|loops_in_stage|name|stage_entered_at). Default: time_in_stage_sec
   *  - order_dir: asc|desc (default: desc)
   *  - page (default 1), pageSize (default 20)
   */
  fastify.get('/customers', async (req, reply) => {
    const {
      q,
      stage,
      exclude_human,
      min_loops,
      min_time_sec,
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
      // NOTE: aqui esperaremos que o front envie o label exato (current_stage_label) ou o id do bloco, conforme seu frontend.
      // Se quiser filtrar por label em vez de id, troque a condição para comparar a COALESCE(...) usada abaixo.
      params.push(String(stage).trim());
      where.push(`(
        v.current_stage = $${params.length}
        OR COALESCE((f.data->'blocks'->>v.current_stage), s.vars->>'current_block_label', t.block_label) = $${params.length}
      )`);
    }

    if (exclude_human && String(exclude_human) === 'true') {
      // assumimos que v.bot_mode/human flag está na view; se não houver, filtre pela session vars.handover.status = 'open'
      where.push(`NOT (s.vars->'handover'->>'status' = 'open')`);
    }

    if (min_loops && Number.isFinite(Number(min_loops))) {
      params.push(parseInt(min_loops, 10));
      where.push(`v.loops_in_stage >= $${params.length}`);
    }

    if (min_time_sec && Number.isFinite(Number(min_time_sec))) {
      params.push(parseInt(min_time_sec, 10));
      where.push(`v.time_in_stage_sec >= $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      // total
      const countSql = `
        SELECT count(*)::int AS total
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN LATERAL (
          SELECT bt.block_label
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.visible = true
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        ${whereSql}
      `;
      const { rows: countRows } = await req.db.query(countSql, params);
      const total = countRows?.[0]?.total ?? 0;

      // dados — busca label/type com fallback e última transição visível
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
          SELECT bt.block_label, bt.block_type
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
   * Detalhes para o modal: posição atual + jornada + diagnóstico do dwell atual
   * -> retornará a jornada *apenas* com transições onde visible = true
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    const { userId } = req.params;

    try {
      // Info base (linha do grid) para este user (com fallback de label/type como acima)
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
          s.vars AS session_vars
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
        WHERE v.user_id = $1
        LIMIT 1
      `;
      const { rows: baseRows } = await req.db.query(baseSql, [userId]);
      if (baseRows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
      }
      const base = baseRows[0];

      // Jornada completa — construímos a partir de bot_transitions (apenas visible = true)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', bt.block_label,
              'block_id', bt.block_id,
              'type', bt.block_type,
              'timestamp', bt.entered_at,
              'duration', EXTRACT(EPOCH FROM (bt.left_at - bt.entered_at))::int,
              'vars', bt.vars,
              'ticket_number', bt.ticket_number
            ) ORDER BY bt.entered_at
          ), '[]'::jsonb
        ) AS journey
        FROM hmg.bot_transitions bt
        WHERE bt.user_id = $1 AND bt.visible = true
      `;
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      const journey = journeyRows?.[0]?.journey ?? [];

      // Diagnóstico do dwell atual (intervalo do estágio atual) - mesma lógica anterior (view)
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

      // last_reset_at: tenta ler da session vars ou detectar a primeira transição do tipo 'RESET' na tabela
      let lastResetAt = null;
      try {
        if (base.session_vars && base.session_vars.last_reset_at) {
          lastResetAt = base.session_vars.last_reset_at;
        } else {
          const { rows: rr } = await req.db.query(
            `SELECT entered_at FROM hmg.bot_transitions WHERE user_id = $1 AND block_id = 'RESET' ORDER BY entered_at DESC LIMIT 1`,
            [userId]
          );
          if (rr && rr[0]) lastResetAt = rr[0].entered_at;
        }
      } catch (err) {
        // swallow
      }

      return reply.send({
        ...base,
        journey,
        dwell,
        last_reset_at: lastResetAt,
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
   * Reseta a sessão do cliente:
   *  - marca transições anteriores visible = false (oculta)
   *  - insere uma transição "RESET" visível
   *  - atualiza sessions (current_block -> flow.start; vars.last_reset_at)
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;
    const client = req.db; // pool / client

    // transação para manter consistência
    const tx = await client.connect();
    try {
      await tx.query('BEGIN');

      // Verifica se existe usuário na view (opcional)
      const { rows: existRows } = await tx.query('SELECT user_id FROM hmg.v_bot_customer_list WHERE user_id = $1 LIMIT 1', [userId]);
      if (!existRows || existRows.length === 0) {
        await tx.query('ROLLBACK');
        tx.release();
        return reply.code(404).send({ error: 'Cliente não encontrado' });
      }

      const now = new Date().toISOString();

      // 1) marca previous visible = false
      await tx.query(
        `UPDATE hmg.bot_transitions SET visible = false WHERE user_id = $1 AND visible = true`,
        [userId]
      );

      // 2) pega flow ativo (se houver) para preencher flow_id e start block
      const { rows: flowRows } = await tx.query(`SELECT id, data->>'start' AS start_block FROM hmg.flows WHERE active = true LIMIT 1`);
      const activeFlowId = flowRows?.[0]?.id || null;
      const startBlock = flowRows?.[0]?.start_block || null;

      // 3) insere uma transição RESET visível (marca ponto a partir do qual a jornada será exibida)
      await tx.query(
        `INSERT INTO hmg.bot_transitions
          (user_id, channel, flow_id, block_id, block_label, entered_at, vars, ticket_number, visible)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, true)`,
        [
          userId,
          null, // channel unknown here; you can pass channel in body if desired
          activeFlowId,
          'RESET',
          'RESET',
          JSON.stringify({ manual_reset: true, by: req.user?.email || null }), // vars
          null
        ]
      );

      // 4) atualiza sessão: current_block -> startBlock (se existir), e marca last_reset_at em vars
      if (startBlock) {
        // atualiza current_block e last_reset_at
        await tx.query(
          `INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             current_block = EXCLUDED.current_block,
             last_flow_id = EXCLUDED.last_flow_id,
             vars = jsonb_set(coalesce(sessions.vars, '{}'::jsonb), '{last_reset_at}', to_jsonb(NOW()::timestamptz), true),
             updated_at = NOW()
           `,
          [userId, startBlock, activeFlowId, JSON.stringify({ last_reset_at: now })]
        );
      } else {
        // se não há startBlock, apenas grava last_reset_at na sessão
        await tx.query(
          `INSERT INTO hmg.sessions (user_id, vars, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             vars = jsonb_set(coalesce(sessions.vars, '{}'::jsonb), '{last_reset_at}', to_jsonb(NOW()::timestamptz), true),
             updated_at = NOW()
           `,
          [userId, JSON.stringify({ last_reset_at: now })]
        );
      }

      await tx.query('COMMIT');
      tx.release();

      return reply.send({ ok: true, reset_at: now });
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      tx.release();
      fastify.log.error('Erro ao resetar sessão do cliente:', error);
      return reply.code(500).send({
        error: 'Erro interno ao resetar sessão do cliente',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas de gargalo do bot: p95/avg por estágio, taxa média de loops, top estágios por p95
   * (mantido como antes)
   */
  fastify.get('/metrics', async (req, reply) => {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10)));
    try {
      const dwellAggSql = `
        SELECT
          block,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_sec) AS p95_sec,
          avg(duration_sec)::int AS avg_sec,
          count(*) AS samples
        FROM hmg.v_bot_stage_dwells
        GROUP BY block
        ORDER BY p95_sec DESC
        LIMIT $1
      `;
      const { rows: bottlenecks } = await req.db.query(dwellAggSql, [limit]);

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
   * Retorna a lista de blocos conhecidos (label/type), filtra por transições visíveis
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
