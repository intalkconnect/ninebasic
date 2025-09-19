// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT com controle de visibilidade

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Mostra apenas usuários com registros visíveis e não está no bloco "início"
   */
  fastify.get('/customers', async (req, reply) => {
    try {
      fastify.log.info('Iniciando busca de customers tracert');
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

      // OCULTAR usuários no bloco "início" (fluxo concluído)
      where.push(`COALESCE(
        (f.data->'blocks'->>v.current_stage),
        s.vars->>'current_block_label',
        t.block_label
      ) != 'início'`);

      // MOSTRAR APENAS usuários com registros visíveis
      where.push(`EXISTS (
        SELECT 1 FROM hmg.bot_transitions bt 
        WHERE bt.user_id = v.user_id AND bt.visible = true
      )`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      fastify.log.info('Query parameters:', { params, whereSql });

      // total
      const countSql = `
        SELECT count(*)::int AS total
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
      `;
      const { rows: countRows } = await req.db.query(countSql, params);
      const total = countRows?.[0]?.total ?? 0;
      
      fastify.log.info('Count query executed successfully, total:', total);

      // CORREÇÃO: Construir a query com os parâmetros corretos
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      
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
          -- Calcula loops considerando apenas registros visíveis
          (
            SELECT count(*)::int 
            FROM hmg.v_bot_user_journey j 
            WHERE j.user_id = v.user_id 
              AND j.stage = v.current_stage 
              AND j.visible = true
          ) AS loops_in_stage
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
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `;

      // CORREÇÃO: Passar os parâmetros corretamente
      const queryParams = [...params, sizeNum, offset];
      
      fastify.log.info('Executing data query with params:', { 
        queryParams, 
        sqlPreview: dataSql.substring(0, 200) + '...' 
      });
      
      const { rows } = await req.db.query(dataSql, queryParams);
      
      fastify.log.info('Data query executed successfully, rows count:', rows.length);

      return reply.send({
        page: pageNum,
        pageSize: sizeNum,
        total,
        rows,
      });
    } catch (error) {
      fastify.log.error('Erro ao listar tracert do bot:', {
        error: error.message,
        stack: error.stack,
        query: error.query || 'No query info',
        params: error.parameters || 'No params info'
      });
      return reply.code(500).send({
        error: 'Erro interno ao listar tracert do bot',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Retorna base + jornada + dwell.
   * Mostra APENAS registros com visible = true (após último reset)
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    const { userId } = req.params;
    try {
      // base info - busca apenas registros visíveis
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
            WHERE bt.user_id = v.user_id AND bt.block_id IN ('reset_to_start', 'reset') AND bt.visible = true
          ) AS last_reset_at
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
      
      // Se não encontrado OU está no bloco "início" sem reset, retorna 404
      if (!baseRows || baseRows.length === 0 || 
          (baseRows[0].current_stage_label === 'início' && !baseRows[0].last_reset_at)) {
        return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
      }
      
      const base = baseRows[0];

      // Journey - mostra APENAS registros visíveis
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
                  AND j2.visible = true
              )
            )
            ORDER BY j.entered_at
          ),
          '[]'::jsonb
        ) AS journey
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1 AND j.visible = true
      `;
      
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      const journey = journeyRows?.[0]?.journey ?? [];

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

      // Recalcular loops_in_stage considerando apenas registros visíveis
      const loopsSql = `
        SELECT COUNT(*)::int as loops_count
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1 
          AND j.stage = $2
          AND j.visible = true
      `;
      const { rows: loopsRows } = await req.db.query(loopsSql, [userId, base.current_stage]);
      const loopsInStage = loopsRows?.[0]?.loops_count || 0;

      return reply.send({
        ...base,
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
   * Força a sessão do user para o início do fluxo.
   * Marca todos os registros anteriores como invisible e cria um novo reset visible
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;
    const now = new Date().toISOString();

    try {
      // 1) Marcar todos os registros anteriores como invisible
      const hidePreviousSql = `
        UPDATE hmg.bot_transitions 
        SET visible = false 
        WHERE user_id = $1 AND visible = true
      `;
      await req.db.query(hidePreviousSql, [userId]);

      // 2) Inserir transição de reset (visible)
      const insertSql = `
        INSERT INTO hmg.bot_transitions (
          user_id, channel, flow_id, block_id, block_label, entered_at, vars, ticket_number, visible
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
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

      // 3) Atualizar sessão para flow.start
      const { rows: frows } = await req.db.query('SELECT id, data FROM hmg.flows WHERE active = true LIMIT 1');
      const activeFlow = frows[0] || null;
      const startBlock = activeFlow ? (activeFlow.data?.start || null) : null;

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
        JSON.stringify({})
      ]);

      return reply.code(200).send({ ok: true, reset_at: now });
    } catch (err) {
      fastify.log.error('Erro ao resetar sessão do tracert:', err);
      return reply.code(500).send({ error: 'Falha ao resetar sessão' });
    }
  });

  /**
   * POST /tracert/customers/:userId/ticket
   * Cria um ticket para o usuário
   */
  fastify.post('/customers/:userId/ticket', async (req, reply) => {
    const { userId } = req.params;
    const { queue } = req.body || {};
    const now = new Date().toISOString();

    try {
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
        const transitionSql = `
          INSERT INTO hmg.bot_transitions (
            user_id, channel, flow_id, block_id, block_label, entered_at, vars, ticket_number, visible
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
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
   * Considera apenas registros visíveis
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      // total (usuários visíveis, sem human, sem "início")
      const totalSql = `
        SELECT count(*)::int AS total
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.visible = true ORDER BY bt.entered_at DESC LIMIT 1
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
        AND EXISTS (
          SELECT 1 FROM hmg.bot_transitions bt 
          WHERE bt.user_id = v.user_id AND bt.visible = true
        )
      `;
      const { rows: totalR } = await req.db.query(totalSql);
      const total = totalR?.[0]?.total ?? 0;

      // loopers
      const loopersSql = `
        SELECT count(*)::int AS loopers
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.visible = true ORDER BY bt.entered_at DESC LIMIT 1
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

      // bottlenecks (p95)
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10)));
      const dwellAggSql = `
        SELECT
          block,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_sec) AS p95_sec,
          avg(duration_sec)::int AS avg_sec,
          count(*) AS samples
        FROM hmg.v_bot_stage_dwells
        WHERE duration_sec IS NOT NULL
        GROUP BY block
        HAVING count(*) > 0
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
        WHERE entries IS NOT NULL
        GROUP BY block
        HAVING count(*) > 0
        ORDER BY avg_loops DESC
        LIMIT $1
      `;
      const { rows: loops } = await req.db.query(loopsSql, [limit]);

      // distribuição atual
      const distSql = `
        SELECT current_stage AS block, count(*)::int AS users
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.visible = true ORDER BY bt.entered_at DESC LIMIT 1
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

      const topStage = distribution?.[0] || null;

      return reply.send({
        total,
        loopers,
        bottlenecks: bottlenecks || [],
        loops: loops || [],
        distribution: distribution || [],
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
