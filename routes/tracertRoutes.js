// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT - Versão Corrigida

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   */
  fastify.get('/customers', async (req, reply) => {
    try {
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

      const allowedOrderBy = ['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at'];
      const orderByKey = allowedOrderBy.includes(String(order_by)) ? String(order_by) : 'time_in_stage_sec';
      const orderBySql = orderByKey === 'stage_entered_at' ? 'v.stage_entered_at' : `v.${orderByKey}`;
      const orderDir = String(order_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      let whereConditions = [];
      let queryParams = [];

      // Filtro de busca
      if (q && String(q).trim() !== '') {
        queryParams.push(`%${String(q).trim().toLowerCase()}%`);
        whereConditions.push(`(lower(v.name) LIKE $${queryParams.length} OR v.user_id LIKE $${queryParams.length})`);
      }

      // Filtro de stage
      if (stage && String(stage).trim() !== '') {
        queryParams.push(String(stage).trim());
        whereConditions.push(`v.current_stage = $${queryParams.length}`);
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

      // Excluir sessões humanas
      if (String(exclude_human).toLowerCase() === 'true') {
        whereConditions.push(`(
          COALESCE(
            v.current_stage_type,
            (SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id ORDER BY bt.entered_at DESC LIMIT 1)
          ) IS NULL
          OR COALESCE(
            v.current_stage_type,
            (SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id ORDER BY bt.entered_at DESC LIMIT 1)
          ) <> 'human'
        )`);
      }

      const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Query de count
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM hmg.v_bot_customer_list v
        ${whereSql}
      `;
      
      const countResult = await req.db.query(countSql, queryParams);
      const total = countResult.rows[0]?.total || 0;

      // CORREÇÃO: Query principal com placeholders corretos
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
            (f.data->'blocks'->v.current_stage->>'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS current_stage_type,
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage,
          f.id AS flow_id
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type, bt.entered_at
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        ${whereSql}
        ORDER BY ${orderBySql} ${orderDir}, v.user_id ASC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
      `;

      // CORREÇÃO: Passar parâmetros corretamente
      const dataParams = [...queryParams, sizeNum, offset];
      const dataResult = await req.db.query(dataSql, dataParams);

      return reply.send({
        page: pageNum,
        pageSize: sizeNum,
        total,
        rows: dataResult.rows,
      });

    } catch (error) {
      fastify.log.error('Erro ao listar tracert do bot:', error);
      return reply.code(500).send({ error: 'Erro interno ao listar tracert do bot' });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes do cliente
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    try {
      const { userId } = req.params;
      const decodedUserId = decodeURIComponent(userId);

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
            (f.data->'blocks'->v.current_stage->>'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS current_stage_type,
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage,
          s.vars->>'last_reset_at' AS last_reset_at,
          f.id AS flow_id
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

      const baseResult = await req.db.query(baseSql, [decodedUserId]);
      
      if (!baseResult.rows.length) {
        return reply.code(404).send({ error: 'Cliente não encontrado' });
      }

      const base = baseResult.rows[0];

      // Journey
      const journeySql = `
        SELECT
          stage,
          entered_at,
          duration_sec
        FROM hmg.v_bot_user_journey
        WHERE user_id = $1
        ORDER BY entered_at
      `;

      const journeyResult = await req.db.query(journeySql, [decodedUserId]);
      const journey = journeyResult.rows;

      // Dwell
      const dwellSql = `
        SELECT
          block,
          entered_at,
          left_at,
          duration_sec
        FROM hmg.v_bot_stage_dwells
        WHERE user_id = $1 AND block = $2
        ORDER BY entered_at DESC
        LIMIT 1
      `;

      const dwellResult = await req.db.query(dwellSql, [decodedUserId, base.current_stage]);
      const dwell = dwellResult.rows[0] || null;

      return reply.send({
        ...base,
        journey,
        dwell
      });

    } catch (error) {
      fastify.log.error('Erro ao buscar detalhes:', error);
      return reply.code(500).send({ error: 'Erro interno ao buscar detalhes' });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Reset da sessão
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    try {
      const { userId } = req.params;
      const decodedUserId = decodeURIComponent(userId);
      const now = new Date().toISOString();

      // Buscar flow ativo
      const flowResult = await req.db.query('SELECT id, data FROM hmg.flows WHERE active = true LIMIT 1');
      const activeFlow = flowResult.rows[0];
      const startBlock = activeFlow?.data?.start || null;

      // Atualizar sessão
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
        decodedUserId,
        startBlock,
        activeFlow?.id || null,
        JSON.stringify({ last_reset_at: now })
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
   * Métricas
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      // Total de usuários ativos
      const totalSql = `
        SELECT COUNT(*)::int AS total
        FROM hmg.v_bot_customer_list v
        WHERE v.current_stage IS NOT NULL
      `;
      const totalResult = await req.db.query(totalSql);
      const total = totalResult.rows[0]?.total || 0;

      // Loopers
      const loopersSql = `
        SELECT COUNT(*)::int AS loopers
        FROM hmg.v_bot_customer_list
        WHERE loops_in_stage > 1
      `;
      const loopersResult = await req.db.query(loopersSql);
      const loopers = loopersResult.rows[0]?.loopers || 0;

      // Distribuição
      const distSql = `
        SELECT current_stage AS block, COUNT(*)::int AS users
        FROM hmg.v_bot_customer_list
        WHERE current_stage IS NOT NULL
        GROUP BY current_stage
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
   * Criar ticket
   */
  fastify.post('/customers/:userId/ticket', async (req, reply) => {
    try {
      const { userId } = req.params;
      const decodedUserId = decodeURIComponent(userId);
      const { queue } = req.body || {};
      const now = new Date().toISOString();

      const ticketSql = `
        INSERT INTO hmg.tickets (user_id, queue, status, created_at, created_by)
        VALUES ($1, $2, 'open', $3, $4)
        RETURNING ticket_number
      `;
      
      const ticketResult = await req.db.query(ticketSql, [
        decodedUserId,
        queue || 'Recepção',
        now,
        'system'
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
