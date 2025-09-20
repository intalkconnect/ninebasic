// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT - Versão Corrigida

async function tracertRoutes(fastify, options) {
  
  // Middleware para lidar com body vazio em POST
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && request.headers['content-type'] === 'application/json') {
      try {
        request.body = await request.body;
        if (request.body === undefined || request.body === null) {
          request.body = {};
        }
      } catch (error) {
        request.body = {};
      }
    }
  });

  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   */
  fastify.get('/customers', async (req, reply) => {
    let queryParams = [];
    let whereConditions = [];
    
    try {
      console.log('=== INICIANDO /tracert/customers ===');
      console.log('Query parameters:', req.query);

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

      console.log('Pagination - page:', pageNum, 'size:', sizeNum, 'offset:', offset);

      const allowedOrderBy = ['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at'];
      const orderByKey = allowedOrderBy.includes(String(order_by)) ? String(order_by) : 'time_in_stage_sec';
      const orderBySql = orderByKey === 'stage_entered_at' ? 'stage_entered_at' : orderByKey;
      const orderDir = String(order_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      console.log('Order by:', orderBySql, orderDir);

      // Filtro de busca
      if (q && String(q).trim() !== '') {
        queryParams.push(`%${String(q).trim().toLowerCase()}%`);
        whereConditions.push(`(lower(name) LIKE $${queryParams.length} OR user_id LIKE $${queryParams.length})`);
        console.log('Search filter added:', q);
      }

      // Filtro de stage
      if (stage && String(stage).trim() !== '') {
        queryParams.push(String(stage).trim());
        whereConditions.push(`current_stage = $${queryParams.length}`);
        console.log('Stage filter added:', stage);
      }

      // Filtro de loops mínimos
      if (min_loops && !isNaN(min_loops)) {
        queryParams.push(parseInt(min_loops));
        whereConditions.push(`loops_in_stage >= $${queryParams.length}`);
        console.log('Min loops filter added:', min_loops);
      }

      // Filtro de tempo mínimo
      if (min_time_sec && !isNaN(min_time_sec)) {
        queryParams.push(parseInt(min_time_sec));
        whereConditions.push(`time_in_stage_sec >= $${queryParams.length}`);
        console.log('Min time filter added:', min_time_sec);
      }

      // CORREÇÃO: Excluir sessões humanas - usando current_stage ao invés de current_stage_type
      if (String(exclude_human).toLowerCase() === 'true') {
        whereConditions.push(`current_stage != 'human'`);
        console.log('Exclude human filter added: current_stage != human');
      }

      const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      console.log('Final WHERE clause:', whereSql);
      console.log('Query parameters:', queryParams);

      // Query de count
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM v_bot_customer_list
        ${whereSql}
      `;
      
      console.log('Count SQL:', countSql);
      const countResult = await req.db.query(countSql, queryParams);
      const total = countResult.rows[0]?.total || 0;
      console.log('Total count:', total);

      // Query principal
      const dataSql = `
        SELECT
          cliente_id,
          user_id,
          name,
          channel,
          current_stage,
          stage_entered_at,
          time_in_stage_sec,
          loops_in_stage
        FROM v_bot_customer_list
        ${whereSql}
        ORDER BY ${orderBySql} ${orderDir}
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
      `;

      const dataParams = [...queryParams, sizeNum, offset];
      console.log('Data SQL:', dataSql);
      console.log('Data parameters:', dataParams);

      const dataResult = await req.db.query(dataSql, dataParams);
      console.log('Data result rows:', dataResult.rows.length);

      return reply.send({
        page: pageNum,
        pageSize: sizeNum,
        total,
        rows: dataResult.rows,
      });

    } catch (error) {
      console.error('=== ERRO DETALHADO ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Query parameters:', queryParams);
      console.error('WHERE conditions:', whereConditions);
      console.error('=== FIM DO ERRO ===');

      fastify.log.error('Erro detalhado ao listar tracert:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao listar tracert do bot',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes do cliente
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    try {
      console.log('=== INICIANDO /tracert/customers/:userId ===');
      const { userId } = req.params;
      console.log('User ID:', userId);

      // Base info - apenas colunas que existem na view
      const baseSql = `
        SELECT
          cliente_id,
          user_id,
          name,
          channel,
          current_stage,
          stage_entered_at,
          time_in_stage_sec,
          loops_in_stage
        FROM v_bot_customer_list
        WHERE user_id = $1
        LIMIT 1
      `;

      console.log('Base SQL:', baseSql);
      const baseResult = await req.db.query(baseSql, [userId]);
      
      if (!baseResult.rows.length) {
        console.log('Cliente não encontrado');
        return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
      }

      const base = baseResult.rows[0];
      console.log('Base data found:', base);

      // Journey
      const journeySql = `
        SELECT
          stage,
          entered_at,
          duration_sec
        FROM v_bot_user_journey
        WHERE user_id = $1
        ORDER BY entered_at
      `;

      console.log('Journey SQL:', journeySql);
      const journeyResult = await req.db.query(journeySql, [userId]);
      const journey = journeyResult.rows;
      console.log('Journey result:', journey.length, 'rows');

      // Dwell
      const dwellSql = `
        SELECT
          block,
          entered_at,
          left_at,
          duration_sec
        FROM v_bot_stage_dwells
        WHERE user_id = $1 AND block = $2
        ORDER BY entered_at DESC
        LIMIT 1
      `;

      console.log('Dwell SQL:', dwellSql);
      const dwellResult = await req.db.query(dwellSql, [userId, base.current_stage]);
      const dwell = dwellResult.rows[0] || null;
      console.log('Dwell result:', dwell);

      return reply.send({
        ...base,
        journey,
        dwell
      });

    } catch (error) {
      console.error('Erro em /customers/:userId:', error);
      fastify.log.error('Erro ao buscar detalhes:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao buscar detalhes do tracert do bot',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Reset da sessão - com schema para permitir body vazio
   */
  fastify.post('/customers/:userId/reset', {
    config: {
      // Desabilita completamente o parsing de body para esta rota
      bodyLimit: 1, // 1 byte apenas para evitar abuse
      attachValidation: false
    },
    schema: {
      body: {
        type: ['object', 'null'],
        additionalProperties: true
      }
    }
  }, async (req, reply) => {
    try {
      console.log('=== INICIANDO POST /reset ===');
      const { userId } = req.params;
      console.log('Reset for user:', userId);

      const now = new Date().toISOString();

      // Buscar flow ativo
      const flowResult = await req.db.query('SELECT id, data FROM flows WHERE active = true LIMIT 1');
      const activeFlow = flowResult.rows[0];
      const startBlock = activeFlow?.data?.start || null;
      console.log('Active flow:', activeFlow?.id, 'Start block:', startBlock);

      // Atualizar sessão
      const sessionSql = `
        INSERT INTO sessions (user_id, current_block, last_flow_id, vars, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET 
          current_block = EXCLUDED.current_block,
          last_flow_id = EXCLUDED.last_flow_id,
          vars = EXCLUDED.vars,
          updated_at = EXCLUDED.updated_at
      `;

      console.log('Session SQL:', sessionSql);
      await req.db.query(sessionSql, [
        userId,
        startBlock,
        activeFlow?.id || null,
        JSON.stringify({ last_reset_at: now })
      ]);

      console.log('Reset completed successfully');
      return reply.send({ 
        ok: true, 
        reset_at: now,
        start_block: startBlock
      });

    } catch (error) {
      console.error('Erro no reset:', error);
      fastify.log.error('Erro ao resetar:', error);
      return reply.code(500).send({ 
        error: 'Falha ao resetar sessão',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      console.log('=== INICIANDO /metrics ===');

      // Total de usuários ativos (excluindo humanos)
      const totalSql = `SELECT COUNT(*)::int AS total FROM v_bot_customer_list WHERE current_stage IS NOT NULL AND current_stage != 'human'`;
      console.log('Total SQL:', totalSql);
      const totalResult = await req.db.query(totalSql);
      const total = totalResult.rows[0]?.total || 0;
      console.log('Total users:', total);

      // Loopers (excluindo humanos)
      const loopersSql = `SELECT COUNT(*)::int AS loopers FROM v_bot_customer_list WHERE loops_in_stage > 1 AND current_stage != 'human'`;
      console.log('Loopers SQL:', loopersSql);
      const loopersResult = await req.db.query(loopersSql);
      const loopers = loopersResult.rows[0]?.loopers || 0;
      console.log('Loopers:', loopers);

      // Distribuição (excluindo humanos)
      const distSql = `
        SELECT current_stage AS block, COUNT(*)::int AS users
        FROM v_bot_customer_list
        WHERE current_stage IS NOT NULL AND current_stage != 'human'
        GROUP BY current_stage
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `;
      console.log('Distribution SQL:', distSql);
      const distResult = await req.db.query(distSql);
      const distribution = distResult.rows;
      console.log('Distribution:', distribution);

      return reply.send({
        total,
        loopers,
        distribution,
        topStage: distribution[0] || null
      });

    } catch (error) {
      console.error('Erro nas métricas:', error);
      fastify.log.error('Erro nas métricas:', error);
      return reply.code(500).send({ 
        error: 'Erro interno nas métricas',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * GET /tracert/stages
   * Lista de estágios disponíveis (excluindo humanos)
   */
  fastify.get('/stages', async (req, reply) => {
    try {
      console.log('=== INICIANDO /stages ===');
      
      const stagesSql = `
        SELECT DISTINCT
          current_stage as label,
          'bot' as type
        FROM v_bot_customer_list
        WHERE current_stage IS NOT NULL AND current_stage != 'human'
        ORDER BY label ASC
      `;
      
      console.log('Stages SQL:', stagesSql);
      const { rows } = await req.db.query(stagesSql);
      console.log('Stages found:', rows.length);
      
      return reply.send(rows);

    } catch (error) {
      console.error('Erro em /stages:', error);
      fastify.log.error('Erro ao listar estágios:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao listar estágios',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

}

export default tracertRoutes;
