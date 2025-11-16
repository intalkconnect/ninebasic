// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT - Versão com filtro por flow_id

async function tracertRoutes(fastify, options) {

  fastify.decorateRequest('actor', null);

  // Hook: preencher req.actor com infos de quem está chamando
  fastify.addHook('onRequest', async (req, reply) => {
    const actorId   = req.headers['x-user-id']    || null;
    const actorName = req.headers['x-user-name']  || null;
    const actorMail = req.headers['x-user-email'] || null;
    req.actor = { id: actorId, name: actorName, email: actorMail };
  });

  // Hook: lidar com body vazio em POST application/json
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
   * Agora com filtro opcional por flow_id
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
        exclude_human = 'false',
        exclude_start = 'true',
        order_by = 'time_in_stage_sec',
        order_dir = 'desc',
        page = '1',
        pageSize = '20',
        flow_id,                         // 👈 NOVO
      } = req.query;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const sizeNum = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
      const offset  = (pageNum - 1) * sizeNum;

      console.log('Pagination - page:', pageNum, 'size:', sizeNum, 'offset:', offset);

      const allowedOrderBy = ['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at'];
      const orderByKey = allowedOrderBy.includes(String(order_by))
        ? String(order_by)
        : 'time_in_stage_sec';

      const orderBySql = orderByKey === 'stage_entered_at'
        ? 'stage_entered_at'
        : orderByKey;

      const orderDir = String(order_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      console.log('Order by:', orderBySql, orderDir);

      // Filtro de busca (nome ou user_id)
      if (q && String(q).trim() !== '') {
        queryParams.push(`%${String(q).trim().toLowerCase()}%`);
        whereConditions.push(
          `(lower(name) LIKE $${queryParams.length} OR user_id LIKE $${queryParams.length})`
        );
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
        queryParams.push(parseInt(min_loops, 10));
        whereConditions.push(`loops_in_stage >= $${queryParams.length}`);
        console.log('Min loops filter added:', min_loops);
      }

      // Filtro de tempo mínimo no stage
      if (min_time_sec && !isNaN(min_time_sec)) {
        queryParams.push(parseInt(min_time_sec, 10));
        whereConditions.push(`time_in_stage_sec >= $${queryParams.length}`);
        console.log('Min time filter added:', min_time_sec);
      }

      // Filtro por flow_id
      if (flow_id) {
        queryParams.push(flow_id);
        whereConditions.push(`flow_id = $${queryParams.length}`);
        console.log('Flow filter added:', flow_id);
      }

      // Excluir sessões humanas (usa current_stage)
      if (String(exclude_human).toLowerCase() === 'true') {
        whereConditions.push(`current_stage != 'human'`);
        console.log('Exclude human filter added: current_stage != human');
      }

      // Excluir START / system_reset pelo TYPE
      if (String(exclude_start).toLowerCase() === 'true') {
        whereConditions.push(
          `LOWER(COALESCE(current_stage_type,'')) NOT IN ('start','system_reset')`
        );
        console.log('Exclude start/system_reset filter added (by type)');
      }

      const whereSql = whereConditions.length > 0
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';

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
          loops_in_stage,
          flow_id
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
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes do cliente (por flow_id quando informado)
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    try {
      console.log('=== INICIANDO /tracert/customers/:userId ===');
      const { userId } = req.params;
      const { flow_id } = req.query || {};

      // Base info (usa v_bot_customer_list, agora com flow_id)
      let baseParams = [userId];
      let baseWhere  = ['user_id = $1'];

      if (flow_id) {
        baseParams.push(flow_id);
        baseWhere.push(`flow_id = $${baseParams.length}`);
      }

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
          loops_in_stage,
          flow_id
        FROM v_bot_customer_list
        WHERE ${baseWhere.join(' AND ')}
        LIMIT 1
      `;

      const baseResult = await req.db.query(baseSql, baseParams);

      if (!baseResult.rows.length) {
        return reply
          .code(404)
          .send({ error: 'Cliente não encontrado no tracert do bot' });
      }

      const base = baseResult.rows[0];

      // Journey (do último reset em diante; oculta 'system_reset')
      const journeySql = `
        WITH dw AS (
          SELECT
            vsd.user_id,
            vsd.block                               AS stage,
            vsd.entered_at,
            COALESCE(vsd.left_at, NOW())           AS left_at,
            vsd.duration_sec,
            bt.block_type                           AS stage_type,
            bt.vars                                 AS vars
          FROM v_bot_stage_dwells vsd
          LEFT JOIN bot_transitions bt
            ON bt.user_id = vsd.user_id
           AND COALESCE(bt.block_label, bt.block_id) = vsd.block
           AND bt.entered_at = vsd.entered_at
           AND (bt.visible IS NULL OR bt.visible = TRUE)
          WHERE vsd.user_id = $1
        ),
        start_from AS (
          SELECT (
            SELECT MAX(entered_at)
            FROM dw
            WHERE LOWER(COALESCE(stage_type,'')) = 'start'
          ) AS ts
        )
        SELECT
          d.stage,
          d.entered_at,
          d.left_at,
          d.duration_sec,
          d.stage_type AS type,
          d.vars,
          (
            SELECT content
            FROM messages m
            WHERE m.user_id   = d.user_id
              AND m.direction = 'incoming'
              AND m."timestamp" >= d.entered_at
              AND m."timestamp" <= d.left_at
            ORDER BY m."timestamp" DESC
            LIMIT 1
          ) AS last_incoming,
          (
            SELECT content
            FROM messages m
            WHERE m.user_id   = d.user_id
              AND m.direction = 'outgoing'
              AND m."timestamp" >= d.entered_at
              AND m."timestamp" <= d.left_at
            ORDER BY m."timestamp" DESC
            LIMIT 1
          ) AS last_outgoing,
          EXISTS (
            SELECT 1
            FROM messages m
            WHERE m.user_id = d.user_id
              AND m."timestamp" >= d.entered_at
              AND m."timestamp" <= d.left_at
              AND (
                (m.metadata ? 'validation' AND m.metadata->>'validation' = 'fail')
                OR (m.metadata ? 'error')
                OR (m.direction='system')
              )
          ) AS has_error
        FROM dw d
        WHERE
          (
            (SELECT ts FROM start_from) IS NULL
            OR d.entered_at >= (SELECT ts FROM start_from)
          )
          AND LOWER(COALESCE(d.stage_type,'')) <> 'system_reset'
        ORDER BY d.entered_at
      `;

      const journeyResult = await req.db.query(journeySql, [userId]);
      const journey = journeyResult.rows;

      // Carimbo do último reset
      const lastResetSql = `
        SELECT MAX(entered_at) AS last_reset_at
        FROM bot_transitions
        WHERE user_id = $1
          AND block_type = 'system_reset'
          AND (visible IS TRUE OR visible IS NULL)
      `;
      const lastResetRes = await req.db.query(lastResetSql, [userId]);
      const last_reset_at = lastResetRes.rows[0]?.last_reset_at ?? null;

      // Dwell atual
      const dwellSql = `
        SELECT
          block,
          entered_at,
          left_at,
          duration_sec,
          COALESCE(bot_msgs, 0)                 AS bot_msgs,
          COALESCE(user_msgs, 0)                AS user_msgs,
          COALESCE(validation_fails, 0)         AS validation_fails,
          COALESCE(max_user_response_gap_sec,0) AS max_user_response_gap_sec
        FROM v_bot_dwell_diagnostics
        WHERE user_id = $1
          AND block   = $2
        ORDER BY entered_at DESC
        LIMIT 1
      `;
      const dwellResult = await req.db.query(dwellSql, [userId, base.current_stage]);
      const dwell = dwellResult.rows[0] || null;

      // Vars atuais de sessão
      const sessSql = `SELECT vars FROM sessions WHERE user_id = $1 LIMIT 1`;
      const sessRes = await req.db.query(sessSql, [userId]);
      const session_vars = sessRes.rows[0]?.vars ?? null;

      return reply.send({
        ...base,
        last_reset_at,
        journey,
        dwell,
        session_vars,
      });

    } catch (error) {
      console.error('Erro em /customers/:userId:', error);
      req.server.log.error('Erro ao buscar detalhes:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar detalhes do tracert do bot',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Reset da sessão - body vazio permitido
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    try {
      console.log('=== INICIANDO POST /tracert/customers/:userId/reset ===');
      const { userId } = req.params;

      const now = new Date().toISOString();

      // 1) Flow ativo global (mantido como estava)
      const flowResult = await req.db.query(
        'SELECT id, data FROM flows WHERE active = true LIMIT 1'
      );
      const activeFlow = flowResult.rows[0];

      if (!activeFlow) {
        return reply.code(404).send({ error: 'Nenhum flow ativo encontrado' });
      }

      const startBlock = activeFlow.data?.start || 'onboarding';
      let startBlockLabel = 'Início';

      try {
        if (activeFlow.data?.blocks && activeFlow.data.blocks[startBlock]) {
          startBlockLabel = activeFlow.data.blocks[startBlock].label || startBlock;
        }
      } catch {}

      // 2) Oculta transições antigas
      await req.db.query(
        `UPDATE bot_transitions
            SET visible = false
          WHERE user_id = $1
            AND (visible IS NULL OR visible = true)`,
        [userId]
      );

      // 3) Insere transição "system_reset"
      const insertTransitionSql = `
        INSERT INTO bot_transitions (
          user_id, channel, flow_id, block_id, block_label, block_type,
          entered_at, vars, visible
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, true)
        RETURNING id
      `;
      const varsJson = JSON.stringify({ last_reset_at: now });

      await req.db.query(insertTransitionSql, [
        userId,
        null,
        activeFlow.id,
        startBlock,
        startBlockLabel,
        'system_reset',
        now,
        varsJson,
      ]);

      // 4) Reposiciona sessão
      const sessionSql = `
        INSERT INTO sessions (user_id, current_block, last_flow_id, vars, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          current_block = EXCLUDED.current_block,
          last_flow_id  = EXCLUDED.last_flow_id,
          vars          = EXCLUDED.vars,
          updated_at    = EXCLUDED.updated_at
      `;
      await req.db.query(sessionSql, [
        userId,
        startBlock,
        activeFlow.id,
        JSON.stringify({
          last_reset_at: now,
          current_block_label: startBlockLabel,
        }),
      ]);

      await fastify.audit(req, {
        action: 'flow.reset',
        resourceType: 'session',
        resourceId: userId,
        extra: req.actor ? { actor: req.actor } : undefined,
      });

      return reply.send({
        ok: true,
        last_reset_at: now,
        start_block: startBlock,
        start_block_label: startBlockLabel,
      });

    } catch (error) {
      console.error('Erro no reset:', error);
      fastify.log.error('Erro ao resetar:', error);
      return reply.code(500).send({
        error: 'Falha ao resetar sessão',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas globais do BOT, com filtro opcional por flow_id
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      console.log('=== INICIANDO /tracert/metrics ===');
      const { flow_id } = req.query || {};

      let params = [];
      let where  = [
        `current_stage IS NOT NULL`,
        `current_stage != 'human'`,
      ];

      if (flow_id) {
        params.push(flow_id);
        where.push(`flow_id = $${params.length}`);
      }

      const whereSql = `WHERE ${where.join(' AND ')}`;

      // Total de usuários ativos
      const totalSql = `
        SELECT COUNT(*)::int AS total
        FROM v_bot_customer_list
        ${whereSql}
      `;
      console.log('Total SQL:', totalSql, 'params:', params);
      const totalResult = await req.db.query(totalSql, params);
      const total = totalResult.rows[0]?.total || 0;

      // Loopers
      const loopersSql = `
        SELECT COUNT(*)::int AS loopers
        FROM v_bot_customer_list
        ${whereSql} AND loops_in_stage > 1
      `;
      console.log('Loopers SQL:', loopersSql, 'params:', params);
      const loopersResult = await req.db.query(loopersSql, params);
      const loopers = loopersResult.rows[0]?.loopers || 0;

      // Distribuição por bloco
      const distSql = `
        SELECT current_stage AS block, COUNT(*)::int AS users
        FROM v_bot_customer_list
        ${whereSql}
        GROUP BY current_stage
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `;
      console.log('Distribution SQL:', distSql, 'params:', params);
      const distResult = await req.db.query(distSql, params);
      const distribution = distResult.rows;

      return reply.send({
        total,
        loopers,
        distribution,
        topStage: distribution[0] || null,
      });

    } catch (error) {
      console.error('Erro nas métricas:', error);
      fastify.log.error('Erro nas métricas:', error);
      return reply.code(500).send({
        error: 'Erro interno nas métricas',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /tracert/stages
   * Lista de estágios disponíveis (excluindo humanos), com filtro opcional por flow_id
   */
  fastify.get('/stages', async (req, reply) => {
    try {
      console.log('=== INICIANDO /tracert/stages ===');
      const { flow_id } = req.query || {};

      let params = [];
      let where  = [
        `current_stage IS NOT NULL`,
        `current_stage != 'human'`,
      ];

      if (flow_id) {
        params.push(flow_id);
        where.push(`flow_id = $${params.length}`);
      }

      const stagesSql = `
        SELECT DISTINCT
          current_stage as label,
          'bot' as type
        FROM v_bot_customer_list
        WHERE ${where.join(' AND ')}
        ORDER BY label ASC
      `;

      console.log('Stages SQL:', stagesSql, 'params:', params);

      const { rows } = await req.db.query(stagesSql, params);
      console.log('Stages found:', rows.length);

      return reply.send(rows);

    } catch (error) {
      console.error('Erro em /stages:', error);
      fastify.log.error('Erro ao listar estágios:', error);
      return reply.code(500).send({
        error: 'Erro interno ao listar estágios',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /tracert/customers/:userId/stage-log
   * Log de mensagens dentro de um dwell específico (stage + entered_at)
   */
  fastify.get('/customers/:userId/stage-log', async (req, reply) => {
    const { userId } = req.params;
    const { entered_at, stage, limit = '100' } = req.query;

    if (!entered_at || !stage) {
      return reply
        .code(400)
        .send({ error: 'entered_at e stage são obrigatórios' });
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

    const rowsResult = await req.db.query(sql, [
      userId,
      stage,
      entered_at,
      Math.min(500, parseInt(limit, 10) || 100),
    ]);

    return reply.send(rowsResult.rows);
  });
}

export default tracertRoutes;
