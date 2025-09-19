// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT (onde está no fluxo, tempo no estágio, loops, gargalos)

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Query params:
   *  - q: busca por name ou user_id (telefone)
   *  - min_loops, min_time_sec, order_by, order_dir, page, pageSize
   *
   * SEMPRE oculta sessões humanas (não há mais opção de incluir).
   */
  // routes/botTracertRoutes.js
// Corrigir a query SQL na rota GET /tracert/customers

 fastify.get('/customers', async (req, reply) => {
    try {
      const {
        q,
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

      if (min_loops && Number.isFinite(Number(min_loops))) {
        params.push(parseInt(min_loops, 10));
        where.push(`v.loops_in_stage >= $${params.length}`);
      }

      if (min_time_sec && Number.isFinite(Number(min_time_sec))) {
        params.push(parseInt(min_time_sec, 10));
        where.push(`v.time_in_stage_sec >= $${params.length}`);
      }

      // SEMPRE ocultar sessões humanas
      where.push(`NOT (
        COALESCE(
          ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
          s.vars->>'current_block_type',
          t.block_type
        ) = 'human'
      )`);

      // REGRA 3: OCULTAR usuários no bloco "início" (fluxo concluído)
      where.push(`COALESCE(
        (f.data->'blocks'->>v.current_stage),
        s.vars->>'current_block_label',
        t.block_label
      ) != 'início'`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // total
      const countSql = `
        SELECT count(*)::int AS total
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        ${whereSql}
      `;
      const { rows: countRows } = await req.db.query(countSql, params);
      const total = countRows?.[0]?.total ?? 0;

      // dados
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
          -- Calcula loops considerando apenas eventos após último reset
          CASE 
            WHEN (SELECT MAX(bt.entered_at) FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.block_id IN ('reset_to_start', 'reset')) IS NOT NULL
            THEN (
              SELECT count(*)::int 
              FROM hmg.v_bot_user_journey j 
              WHERE j.user_id = v.user_id 
                AND j.stage = v.current_stage 
                AND j.entered_at > (SELECT MAX(bt.entered_at) FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.block_id IN ('reset_to_start', 'reset'))
            )
            ELSE v.loops_in_stage
          END AS loops_in_stage
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id
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
   * Retorna base + jornada + dwell.
   * - journey é retornada SOMENTE após o último reset (excluindo o evento de reset).
   * - se não houve reset, retorna jornada desde o início do fluxo.
   */
/**
 * GET /tracert/customers/:userId
 * Retorna base + jornada + dwell.
 * - Se houve reset: journey mostra APENAS eventos APÓS o reset (excluindo reset_to_start e tudo anterior)
 * - Se não houve reset: journey mostra TODOS os eventos desde o início
 */
fastify.get('/customers/:userId', async (req, reply) => {
  const { userId } = req.params;
  try {
    // base info
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
        f.data->>'start' AS flow_start_block,
        (
          SELECT MAX(bt.entered_at)
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.block_id IN ('reset_to_start', 'reset')
        ) AS last_reset_at
      FROM hmg.v_bot_customer_list v
      LEFT JOIN hmg.flows f ON f.active = true
      LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
      LEFT JOIN LATERAL (
        SELECT bt.block_label, bt.block_type
        FROM hmg.bot_transitions bt
        WHERE bt.user_id = v.user_id
        ORDER BY bt.entered_at DESC
        LIMIT 1
      ) t ON true
      WHERE v.user_id = $1
      LIMIT 1
    `;
    const { rows: baseRows } = await req.db.query(baseSql, [userId]);
    
    // REGRA 3: Se não encontrado OU está no bloco "início", retorna 404
    if (!baseRows || baseRows.length === 0 || 
        (baseRows[0].current_stage_label === 'início' && !baseRows[0].last_reset_at)) {
      return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
    }
    
    const base = baseRows[0];

    // Journey - lógica diferenciada para com/sem reset
    let journey = [];

    if (base.last_reset_at) {
      // REGRA 1: Com reset - mostrar apenas eventos APÓS o reset (EXCLUINDO reset_to_start e tudo anterior)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', j.stage,
              'timestamp', j.entered_at,
              'duration', j.duration_sec,
              'visits', (
                -- Contar visitas APENAS após o reset, excluindo eventos de reset
                SELECT count(*)::int
                FROM hmg.v_bot_user_journey j2
                WHERE j2.user_id = $1 
                  AND j2.stage = j.stage 
                  AND j2.entered_at > $2
                  AND j2.stage NOT IN ('reset_to_start', 'reset')
              )
            )
            ORDER BY j.entered_at
          ),
          '[]'::jsonb
        ) AS journey
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1 
          AND j.entered_at > $2
          AND j.stage NOT IN ('reset_to_start', 'reset')
      `;
      
      const { rows: journeyRows } = await req.db.query(journeySql, [userId, base.last_reset_at]);
      journey = journeyRows?.[0]?.journey ?? [];
    } else {
      // REGRA 2: Sem reset - mostrar TODOS os eventos (excluindo eventos de reset)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', j.stage,
              'timestamp', j.entered_at,
              'duration', j.duration_sec,
              'visits', (
                SELECT count(*)::int
                FROM hmg.v_bot_user_journey j2
                WHERE j2.user_id = $1 
                  AND j2.stage = j.stage
                  AND j2.stage NOT IN ('reset_to_start', 'reset')
              )
            )
            ORDER BY j.entered_at
          ),
          '[]'::jsonb
        ) AS journey
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1 
          AND j.stage NOT IN ('reset_to_start', 'reset')
      `;
      
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      journey = journeyRows?.[0]?.journey ?? [];
    }

    // dwell / diagnóstico atual
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
        AND dd.block = cd.block
        AND dd.entered_at = cd.entered_at
    `;
    
    const { rows: dwellRows } = await req.db.query(dwellSql, [userId, base.current_stage]);
    const dwell = dwellRows?.[0] || null;

    // Ajustar métricas se houve reset
    let timeInStageSec = base.time_in_stage_sec;
    let loopsInStage = base.loops_in_stage;

    if (base.last_reset_at) {
      // Recalcular time_in_stage_sec considerando apenas após o reset
      if (base.stage_entered_at && new Date(base.stage_entered_at) <= new Date(base.last_reset_at)) {
        const now = new Date();
        const resetTime = new Date(base.last_reset_at);
        timeInStageSec = Math.floor((now - resetTime) / 1000);
      }

      // Recalcular loops_in_stage considerando apenas após o reset
      const loopsSql = `
        SELECT COUNT(*)::int as loops_count
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1 
          AND j.stage = $2
          AND j.entered_at > $3
          AND j.stage NOT IN ('reset_to_start', 'reset')
      `;
      const { rows: loopsRows } = await req.db.query(loopsSql, [
        userId, 
        base.current_stage, 
        base.last_reset_at
      ]);
      loopsInStage = loopsRows?.[0]?.loops_count || 0;
    }

    return reply.send({
      ...base,
      time_in_stage_sec: timeInStageSec,
      loops_in_stage: loopsInStage,
      journey,
      dwell,
      reset_info: {
        has_reset: !!base.last_reset_at,
        last_reset_at: base.last_reset_at
      }
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
   * Força a sessão do user para o início do fluxo (flow.start).
   * - atualiza hmg.sessions.current_block = flow.start
   * - registra uma transição em hmg.bot_transitions (audit)
   * - opcional: limpa vars (set to {}), reseta ticket info
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;
    const now = new Date().toISOString();

    try {
      // 1) inserir transição de reset
      const insertSql = `
        INSERT INTO hmg.bot_transitions (
          user_id, channel, flow_id, block_id, block_label, entered_at, vars, ticket_number
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;
      await req.db.query(insertSql, [
        userId,
        null,
        null,
        'reset_to_start',
        'RESET TO START',
        now,
        JSON.stringify({ reset_by: req.user?.email || 'system' }),
        null
      ]);

      // 2) atualizar sessão para flow.start
      const { rows: frows } = await req.db.query('SELECT id, data FROM hmg.flows WHERE active = true LIMIT 1');
      const activeFlow = frows[0] || null;
      const startBlock = activeFlow ? (activeFlow.data?.start || null) : null;

      // atualiza sessão: current_block = startBlock, limpa vars
      const upSql = `
        INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET current_block = EXCLUDED.current_block,
                      last_flow_id = EXCLUDED.last_flow_id,
                      vars = EXCLUDED.vars,
                      updated_at = EXCLUDED.updated_at
      `;
      await req.db.query(upSql, [
        userId,
        startBlock || (activeFlow ? activeFlow.id : null),
        activeFlow ? activeFlow.id : null,
        JSON.stringify({}) // limpa variáveis de sessão
      ]);

      return reply.code(200).send({ ok: true, reset_at: now });
    } catch (err) {
      fastify.log.error('Erro ao resetar sessão do tracert:', err);
      return reply.code(500).send({ error: 'Falha ao resetar sessão' });
    }
  });

  /**
   * POST /tracert/customers/:userId/ticket
   * Cria um ticket para o usuário (não transfere, apenas cria ticket).
   */
  fastify.post('/customers/:userId/ticket', async (req, reply) => {
    const { userId } = req.params;
    const { queue } = req.body || {};
    const now = new Date().toISOString();

    try {
      // Aqui você implementaria a lógica de criação de ticket
      // Este é apenas um exemplo - adapte conforme sua estrutura de tickets
      const ticketSql = `
        INSERT INTO hmg.tickets (
          user_id, queue, status, created_at, created_by, priority
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING ticket_id, ticket_number
      `;
      
      const { rows: ticketRows } = await req.db.query(ticketSql, [
        userId,
        queue || 'Recepção',
        'open',
        now,
        req.user?.email || 'system',
        'normal'
      ]);

      const ticket = ticketRows?.[0];
      
      if (ticket) {
        // Opcional: registrar a criação do ticket nas transições do bot
        const transitionSql = `
          INSERT INTO hmg.bot_transitions (
            user_id, channel, flow_id, block_id, block_label, entered_at, vars, ticket_number
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        
        await req.db.query(transitionSql, [
          userId,
          null,
          null,
          'ticket_created',
          'TICKET CREATED',
          now,
          JSON.stringify({ created_by: req.user?.email || 'system', queue: queue || 'Recepção' }),
          ticket.ticket_number
        ]);
      }

      return reply.code(200).send({ 
        ok: true, 
        ticket_id: ticket?.ticket_id,
        ticket_number: ticket?.ticket_number,
        created_at: now 
      });
    } catch (err) {
      fastify.log.error('Erro ao criar ticket:', err);
      return reply.code(500).send({ error: 'Falha ao criar ticket' });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas de gargalo do bot
   * - retorna total (excluindo human SEMPRE), loopers, bottlenecks, loops e distribuição
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      // total (usuários visíveis, sem human - SEMPRE, e sem "início")
      const totalSql = `
        SELECT count(*)::int AS total
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id ORDER BY bt.entered_at DESC LIMIT 1
        ) t ON true
        WHERE NOT (
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) = 'human'
        )
        AND COALESCE(
          (f.data->'blocks'->>v.current_stage),
          s.vars->>'current_block_label',
          t.block_label
        ) != 'início'
      `;
      const { rows: totalR } = await req.db.query(totalSql);
      const total = totalR?.[0]?.total ?? 0;

      // loopers (também exclui "início")
      const loopersSql = `
        SELECT count(*)::int AS loopers
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id ORDER BY bt.entered_at DESC LIMIT 1
        ) t ON true
        WHERE v.loops_in_stage > 1
        AND NOT (
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) = 'human'
        )
        AND COALESCE(
          (f.data->'blocks'->>v.current_stage),
          s.vars->>'current_block_label',
          t.block_label
        ) != 'início'
      `;
      const { rows: loopRows } = await req.db.query(loopersSql);
      const loopers = loopRows?.[0]?.loopers ?? 0;

      // bottlenecks (p95) — top N
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10)));
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

      // loops médios por bloco
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

      // distribuição atual (exclui human SEMPRE e "início")
      const distSql = `
        SELECT current_stage AS block, count(*)::int AS users
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id ORDER BY bt.entered_at DESC LIMIT 1
        ) t ON true
        WHERE NOT (
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) = 'human'
        )
        AND COALESCE(
          (f.data->'blocks'->>v.current_stage),
          s.vars->>'current_block_label',
          t.block_label
        ) != 'início'
        GROUP BY current_stage
        ORDER BY count(*) DESC
      `;
      const { rows: distribution } = await req.db.query(distSql);

      // topStage (maior users)
      const topStage = distribution?.[0] || null;

      return reply.send({
        total,
        loopers,
        bottlenecks,
        loops,
        distribution,
        topStage,
      });
    } catch (error) {
      fastify.log.error('Erro ao calcular métricas do tracert do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao calcular métricas',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });
}

export default tracertRoutes;
