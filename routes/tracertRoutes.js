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
          current_stage_type,
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
          current_stage_type,
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
// Journey (agora traz type)
-- substitui o bloco Journey dentro do GET /customers/:userId
const journeySql = `
  WITH j AS (
    SELECT
      vsd.user_id,
      vsd.block         AS stage,
      vsd.entered_at,
      vsd.left_at,
      vsd.duration_sec,
      bt.block_type     AS stage_type
    FROM v_bot_stage_dwells vsd
    LEFT JOIN bot_transitions bt
      ON bt.user_id = vsd.user_id
     AND COALESCE(bt.block_label, bt.block_id) = vsd.block
     AND bt.entered_at = vsd.entered_at
     AND (bt.visible IS NULL OR bt.visible = true)
    WHERE vsd.user_id = $1
    ORDER BY vsd.entered_at
  )
  SELECT
    j.stage,
    j.entered_at,
    j.left_at,
    j.duration_sec,
    j.stage_type AS type,

    -- prévia: última IN e OUT dentro do intervalo
    (SELECT content FROM messages m
      WHERE m.user_id = j.user_id AND m.direction='incoming'
        AND m."timestamp" >= j.entered_at AND m."timestamp" <= j.left_at
      ORDER BY m."timestamp" DESC LIMIT 1)          AS last_incoming,

    (SELECT content FROM messages m
      WHERE m.user_id = j.user_id AND m.direction='outgoing'
        AND m."timestamp" >= j.entered_at AND m."timestamp" <= j.left_at
      ORDER BY m."timestamp" DESC LIMIT 1)          AS last_outgoing,

    -- flag de erro (validação falhou OU system_reset ou metadata.error)
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.user_id = j.user_id
        AND m."timestamp" >= j.entered_at AND m."timestamp" <= j.left_at
        AND (
          (m.metadata ? 'validation' AND m.metadata->>'validation' = 'fail')
          OR (m.metadata ? 'error')
          OR (m.direction='system')
        )
    )                                                AS has_error
  FROM j
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
    duration_sec,
    COALESCE(bot_msgs, 0)                AS bot_msgs,
    COALESCE(user_msgs, 0)               AS user_msgs,
    COALESCE(validation_fails, 0)        AS validation_fails,
    COALESCE(max_user_response_gap_sec,0) AS max_user_response_gap_sec
  FROM v_bot_dwell_diagnostics
  WHERE user_id = $1
    AND block   = $2
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
  fastify.post('/customers/:userId/reset', async (req, reply) => {
  try {
    console.log('=== INICIANDO POST /reset ===');
    const { userId } = req.params;
    const { reason } = req.body || {};
    
    console.log('Reset for user:', userId);
    console.log('Reset reason:', reason);

    const now = new Date().toISOString();

    // 1) Buscar flow ativo
    const flowResult = await req.db.query('SELECT id, data FROM flows WHERE active = true LIMIT 1');
    const activeFlow = flowResult.rows[0];
    if (!activeFlow) {
      return reply.code(404).send({ error: 'Nenhum flow ativo encontrado' });
    }

    const startBlock = activeFlow.data?.start || 'onboarding';
    console.log('Active flow:', activeFlow.id, 'Start block:', startBlock);

    // 2) Buscar label do bloco inicial do flow
    let startBlockLabel = 'Início';
    try {
      if (activeFlow.data?.blocks && activeFlow.data.blocks[startBlock]) {
        startBlockLabel = activeFlow.data.blocks[startBlock].label || startBlock;
      }
    } catch (e) {
      console.log('Erro ao buscar label do bloco inicial, usando padrão:', e.message);
    }

    // 3) Marcar todas as transições anteriores como não visíveis
    const hideSql = `
      UPDATE bot_transitions 
      SET visible = false 
      WHERE user_id = $1 AND (visible IS NULL OR visible = true)
    `;
    console.log('Hiding previous transitions');
    await req.db.query(hideSql, [userId]);
    console.log('Previous transitions hidden');

    // 4) Inserir nova transição de reset (visível)
    const insertTransitionSql = `
      INSERT INTO bot_transitions (
        user_id, channel, flow_id, block_id, block_label, block_type, 
        entered_at, vars, visible
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
      RETURNING id
    `;
    
    console.log('Inserting reset transition');
    const transitionResult = await req.db.query(insertTransitionSql, [
      userId,
      null,
      activeFlow.id,
      startBlock,
      startBlockLabel,
      'system_reset',
      now,
      JSON.stringify({ 
        reset_by: 'system',
        reset_at: now,
        reset_reason: reason || 'manual_reset'
      })
    ]);
    console.log('Reset transition inserted:', transitionResult.rows[0]?.id);

    // 5) Atualizar sessão para o bloco inicial
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

    console.log('Updating session');
    await req.db.query(sessionSql, [
      userId,
      startBlock,
      activeFlow.id,
      JSON.stringify({ 
        last_reset_at: now,
        current_block_label: startBlockLabel,
        current_block_type: 'system_reset',
        reset_reason: reason || 'manual_reset'
      })
    ]);

    console.log('Reset completed successfully');

    return reply.send({ 
      ok: true, 
      reset_at: now,
      start_block: startBlock,
      start_block_label: startBlockLabel,
      reason: reason || 'manual_reset'
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

  // GET /tracert/customers/:userId/stage-log
fastify.get('/customers/:userId/stage-log', async (req, reply) => {
  const { userId } = req.params;
  const { entered_at, stage, limit = '100' } = req.query;

  if (!entered_at || !stage) {
    return reply.code(400).send({ error: 'entered_at e stage são obrigatórios' });
  }

  const sql = `
    WITH dw AS (
      SELECT entered_at, left_at
      FROM v_bot_stage_dwells
      WHERE user_id = $1 AND block = $2 AND entered_at = $3::timestamptz
      LIMIT 1
    )
    SELECT
      m."timestamp"                  AS ts,
      m.direction,
      m.type,
      m.content,
      m.metadata,
      -- marca erro: validação, metadata.error ou system
      (
        (m.metadata ? 'validation' AND m.metadata->>'validation' = 'fail')
        OR (m.metadata ? 'error')
        OR (m.direction = 'system')
      ) AS is_error
    FROM messages m
    CROSS JOIN dw
    WHERE m.user_id = $1
      AND m."timestamp" >= dw.entered_at
      AND m."timestamp" <= dw.left_at
    ORDER BY m."timestamp"
    LIMIT $4
  `;
  const { rows } = await req.db.query(sql, [userId, stage, entered_at, Math.min(500, parseInt(limit)||100)]);
  return reply.send(rows);
});

}

export default tracertRoutes;
