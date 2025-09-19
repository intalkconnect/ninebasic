// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT com controle de visibilidade

async function tracertRoutes(fastify, options) {
  
  /**
   * GET /tracert/customers
   * Lista paginada - mostra apenas usuários com registros visíveis
   */
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

      const allowedOrderBy = ['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at'];
      const orderByKey = allowedOrderBy.includes(String(order_by)) ? String(order_by) : 'time_in_stage_sec';
      const orderBySql = orderByKey === 'stage_entered_at' ? 'v.stage_entered_at' : `v.${orderByKey}`;
      const orderDir = String(order_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      let whereConditions = [];
      let queryParams = [];

      // Filtro de busca
      if (q && String(q).trim() !== '') {
        queryParams.push(`%${String(q).trim().toLowerCase()}%`);
        whereConditions.push(`(lower(v.name) LIKE $${queryParams.length} OR lower(v.user_id) LIKE $${queryParams.length})`);
      }

      // Filtro de loops mínimos
      if (min_loops && !isNaN(min_loops)) {
        queryParams.push(parseInt(min_loops));
        whereConditions.push(`v.loops_in_stage >= $${queryParams.length}`);
      }

      // Filtro de tempo mínimo
      if (min_time_sec && !isNaN(min_time_sec)) {
        queryParams.push(parseInt(min_time_sec));
        whereConditions.push(`v.time_in_stage_sec >= $${queryParams.length}`);
      }

      // Ocultar humanos
      whereConditions.push(`NOT (
        COALESCE(
          ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
          s.vars->>'current_block_type',
          t.block_type
        ) = 'human'
      )`);

      // Ocultar início
      whereConditions.push(`COALESCE(
        (f.data->'blocks'->>v.current_stage),
        s.vars->>'current_block_label',
        t.block_label
      ) != 'início'`);

      // Apenas usuários com registros visíveis
      whereConditions.push(`EXISTS (
        SELECT 1 FROM hmg.bot_transitions bt 
        WHERE bt.user_id = v.user_id AND bt.visible = true
      )`);

      const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Query de count
      const countSql = `
        SELECT COUNT(*)::int AS total
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

      const countResult = await req.db.query(countSql, queryParams);
      const total = countResult.rows[0]?.total || 0;

      // Query principal
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
          -- Loops considerando apenas registros visíveis
          (
            SELECT COUNT(*)::int 
            FROM hmg.bot_transitions bt
            WHERE bt.user_id = v.user_id 
              AND bt.block_id = v.current_stage 
              AND bt.visible = true
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
        ORDER BY ${orderBySql} ${orderDir}
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
      `;

      const dataParams = [...queryParams, sizeNum, offset];
      const dataResult = await req.db.query(dataSql, dataParams);

      return reply.send({
        page: pageNum,
        pageSize: sizeNum,
        total,
        rows: dataResult.rows,
      });

    } catch (error) {
      fastify.log.error('Erro ao listar tracert:', error);
      return reply.code(500).send({ error: 'Erro interno ao listar tracert' });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes do cliente - mostra apenas registros com visible = true
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    try {
      const { userId } = req.params;

      // Informações base do usuário
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

      const baseResult = await req.db.query(baseSql, [userId]);
      
      if (!baseResult.rows.length) {
        return reply.code(404).send({ error: 'Cliente não encontrado' });
      }

      const base = baseResult.rows[0];

      // Journey - apenas registros visíveis
      const journeySql = `
        SELECT
          stage,
          entered_at,
          duration_sec,
          (
            SELECT COUNT(*)::int
            FROM hmg.bot_transitions bt
            WHERE bt.user_id = $1 
              AND bt.block_id = j.stage 
              AND bt.visible = true
          ) AS visits
        FROM hmg.v_bot_user_journey j
        WHERE user_id = $1 AND visible = true
        ORDER BY entered_at
      `;

      const journeyResult = await req.db.query(journeySql, [userId]);
      const journey = journeyResult.rows;

      // Dwell - apenas registros visíveis
      const dwellSql = `
        SELECT
          block,
          entered_at,
          left_at,
          duration_sec,
          bot_msgs,
          user_msgs,
          validation_fails,
          max_user_response_gap_sec
        FROM hmg.v_bot_stage_dwells
        WHERE user_id = $1 AND block = $2 AND visible = true
        ORDER BY entered_at DESC
        LIMIT 1
      `;

      const dwellResult = await req.db.query(dwellSql, [userId, base.current_stage]);
      const dwell = dwellResult.rows[0] || null;

      // Recalcular loops considerando apenas visíveis
      const loopsSql = `
        SELECT COUNT(*)::int as loops_count
        FROM hmg.bot_transitions bt
        WHERE bt.user_id = $1 
          AND bt.block_id = $2
          AND bt.visible = true
      `;

      const loopsResult = await req.db.query(loopsSql, [userId, base.current_stage]);
      const loopsInStage = loopsResult.rows[0]?.loops_count || 0;

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
      fastify.log.error('Erro ao buscar detalhes:', error);
      return reply.code(500).send({ error: 'Erro interno ao buscar detalhes' });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Reset - marca registros anteriores como invisible e cria novo reset
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    try {
      const { userId } = req.params;
      const now = new Date().toISOString();

      // 1. Marcar todos os registros anteriores como invisible
      const hideSql = `
        UPDATE hmg.bot_transitions 
        SET visible = false 
        WHERE user_id = $1 AND visible = true
      `;
      await req.db.query(hideSql, [userId]);

      // 2. Inserir registro de reset (visible)
      const resetSql = `
        INSERT INTO hmg.bot_transitions (
          user_id, channel, flow_id, block_id, block_label, entered_at, vars, visible
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        RETURNING *
      `;
      
      await req.db.query(resetSql, [
        userId,
        null,
        null,
        'reset_to_start',
        'RESET TO START',
        now,
        JSON.stringify({ reset_by: 'system' })
      ]);

      // 3. Atualizar sessão
      const flowResult = await req.db.query('SELECT id, data FROM hmg.flows WHERE active = true LIMIT 1');
      const activeFlow = flowResult.rows[0];
      const startBlock = activeFlow?.data?.start || null;

      const sessionSql = `
        INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET 
          current_block = EXCLUDED.current_block,
          last_flow_id = EXCLUDED.last_flow_id,
          vars = EXCLUDED.vars,
          updated_at = EXCLUDED.updated_at
      `;

      await req.db.query(sessionSql, [
        userId,
        startBlock,
        activeFlow?.id || null,
        JSON.stringify({})
      ]);

      return reply.send({ 
        ok: true, 
        reset_at: now,
        start_block: startBlock
      });

    } catch (error) {
      fastify.log.error('Erro ao resetar:', error);
      return reply.code(500).send({ error: 'Falha ao resetar sessão' });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas considerando apenas registros visíveis
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      // Total de usuários ativos (visíveis e não humanos)
      const totalSql = `
        SELECT COUNT(*)::int AS total
        FROM hmg.v_bot_customer_list v
        WHERE EXISTS (
          SELECT 1 FROM hmg.bot_transitions bt 
          WHERE bt.user_id = v.user_id AND bt.visible = true
        )
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
      const totalResult = await req.db.query(totalSql);
      const total = totalResult.rows[0]?.total || 0;

      // Loopers (apenas visíveis)
      const loopersSql = `
        SELECT COUNT(*)::int AS loopers
        FROM hmg.v_bot_customer_list v
        WHERE v.loops_in_stage > 1
        AND EXISTS (
          SELECT 1 FROM hmg.bot_transitions bt 
          WHERE bt.user_id = v.user_id AND bt.visible = true
        )
      `;
      const loopersResult = await req.db.query(loopersSql);
      const loopers = loopersResult.rows[0]?.loopers || 0;

      // Distribuição por estágio (apenas visíveis)
      const distSql = `
        SELECT 
          v.current_stage AS block, 
          COUNT(*)::int AS users
        FROM hmg.v_bot_customer_list v
        WHERE EXISTS (
          SELECT 1 FROM hmg.bot_transitions bt 
          WHERE bt.user_id = v.user_id AND bt.visible = true
        )
        AND v.current_stage IS NOT NULL
        GROUP BY v.current_stage
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `;
      const distResult = await req.db.query(distSql);
      const distribution = distResult.rows;

      return reply.send({
        total,
        loopers,
        distribution,
        topStage: distribution[0] || null
      });

    } catch (error) {
      fastify.log.error('Erro nas métricas:', error);
      return reply.code(500).send({ error: 'Erro interno nas métricas' });
    }
  });

  /**
   * POST /tracert/customers/:userId/ticket
   * Criar ticket - registro visível
   */
  fastify.post('/customers/:userId/ticket', async (req, reply) => {
    try {
      const { userId } = req.params;
      const { queue } = req.body || {};
      const now = new Date().toISOString();

      const ticketSql = `
        INSERT INTO hmg.tickets (user_id, queue, status, created_at, created_by)
        VALUES ($1, $2, 'open', $3, $4)
        RETURNING ticket_number
      `;
      
      const ticketResult = await req.db.query(ticketSql, [
        userId,
        queue || 'Recepção',
        now,
        'system'
      ]);

      // Registrar transição visível
      const transitionSql = `
        INSERT INTO hmg.bot_transitions (
          user_id, block_id, block_label, entered_at, vars, visible
        ) VALUES ($1, $2, $3, $4, $5, true)
      `;
      
      await req.db.query(transitionSql, [
        userId,
        'ticket_created',
        'TICKET CREATED',
        now,
        JSON.stringify({ queue: queue || 'Recepção' })
      ]);

      return reply.send({ 
        ok: true, 
        ticket_number: ticketResult.rows[0]?.ticket_number,
        created_at: now 
      });

    } catch (error) {
      fastify.log.error('Erro ao criar ticket:', error);
      return reply.code(500).send({ error: 'Falha ao criar ticket' });
    }
  });

}

export default tracertRoutes;
