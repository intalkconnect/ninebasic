// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT (onde está no fluxo, tempo no estágio, loops, gargalos)

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Query params:
   *  - q: busca por name ou user_id (telefone)
   *  - stage: filtra pelo bloco atual (id do bloco)
   *  - stageLabel: filtra pelo label do estágio (comparação com label gerado)
   *  - min_loops, min_time_sec, order_by, order_dir, page, pageSize
   *
   * Por padrão **oculta** sessões humanas. Para incluir humanos, adicione include_human=true.
   */
  fastify.get('/customers', async (req, reply) => {
    try {
      const {
        q,
        stage,
        stageLabel,
        min_loops,
        min_time_sec,
        order_by = 'time_in_stage_sec',
        order_dir = 'desc',
        page = '1',
        pageSize = '20',
        include_human = 'false',
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
        where.push(`v.current_stage = $${params.length}`);
      }

      // filtro por label (opcional) - compara com o label resolvido
      if (stageLabel && String(stageLabel).trim() !== '') {
        params.push(String(stageLabel).trim());
        where.push(`COALESCE(
          (f.data->'blocks'->>v.current_stage),
          s.vars->>'current_block_label',
          t.block_label
        ) = $${params.length}`);
      }

      if (min_loops && Number.isFinite(Number(min_loops))) {
        params.push(parseInt(min_loops, 10));
        where.push(`v.loops_in_stage >= $${params.length}`);
      }

      if (min_time_sec && Number.isFinite(Number(min_time_sec))) {
        params.push(parseInt(min_time_sec, 10));
        where.push(`v.time_in_stage_sec >= $${params.length}`);
      }

      // por padrão, ocultar sessões humanas (a menos que include_human=true)
      if (String(include_human).toLowerCase() !== 'true') {
        where.push(`NOT (
          COALESCE(
            ((f.data->'blocks'-> v.current_stage)::jsonb ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) = 'human'
        )`);
      }

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

      // dados (com fallback de label/type)
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
   * - journey é retornada a partir do `start` do fluxo por padrão (menor payload).
   * - se houve uma entrada humana recente e o usuário já retornou do humano, a jornada é cortada
   *   para começar a partir da última entrada humana (útil para ver apenas pós-handover).
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
          f.data->>'start' AS flow_start_block
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
      if (!baseRows || baseRows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado no tracert do bot' });
      }
      const base = baseRows[0];

      // calcular timestamps de corte:
      //  - start_entered_at: primeira vez que user entrou no bloco flow_start_block
      //  - last_human_entered_at: ultima entrada em um bloco do tipo human (pela tabela bot_transitions)
      const cutSql = `
        SELECT
          (SELECT min(j.entered_at) FROM hmg.v_bot_user_journey j WHERE j.user_id = $1 AND j.stage = $2) AS start_entered_at,
          (SELECT bt.entered_at FROM hmg.bot_transitions bt WHERE bt.user_id = $1 AND bt.block_type = 'human' ORDER BY bt.entered_at DESC LIMIT 1) AS last_human_entered_at,
          (SELECT s.current_block FROM hmg.sessions s WHERE s.user_id = $1 LIMIT 1) AS session_current_block
      `;
      const { rows: cutRows } = await req.db.query(cutSql, [userId, base.flow_start_block]);
      const cut = (cutRows && cutRows[0]) || {};
      const startEnteredAt = cut.start_entered_at;
      const lastHumanEnteredAt = cut.last_human_entered_at;
      const sessionCurrentBlock = cut.session_current_block;

      // lógica: se há lastHumanEnteredAt AND session_current_block !== 'human', então
      // retornamos journey a partir do lastHumanEnteredAt (ou, se não existir, a partir do startEnteredAt).
      // Caso contrário (sem human), retornamos a partir do startEnteredAt.
      const journeyFromTs = (lastHumanEnteredAt && sessionCurrentBlock !== 'human')
        ? lastHumanEnteredAt
        : startEnteredAt;

      // Journey (aplicando limite de início)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', j.stage,
              'timestamp', j.entered_at,
              'duration', j.duration_sec,
              'visits', (SELECT l.entries FROM hmg.v_bot_loops l WHERE l.user_id = $1 AND l.block = j.stage)
            )
            ORDER BY j.entered_at
          ) FILTER (WHERE j.entered_at >= $2),
          '[]'::jsonb
        ) AS journey
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1
      `;
      const { rows: journeyRows } = await req.db.query(journeySql, [userId, journeyFromTs || '1970-01-01T00:00:00Z']);
      const journey = journeyRows?.[0]?.journey ?? [];

      // dwell / diagnóstico atual (último dwell para o bloco atual)
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
   * Força a sessão do user para o início do fluxo (flow.start).
   * - atualiza hmg.sessions.current_block = flow.start
   * - registra uma transição em hmg.bot_transitions (audit)
   * - opcional: limpa vars (set to {}), reseta ticket info
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;
    try {
      // busca flow.start do fluxo ativo
      const { rows: frows } = await req.db.query(`SELECT id, data->>'start' AS start_block FROM hmg.flows WHERE active = true LIMIT 1`);
      if (!frows || frows.length === 0) {
        return reply.code(400).send({ error: 'Flow ativo não encontrado' });
      }
      const flowId = frows[0].id;
      const startBlock = frows[0].start_block;

      // atualiza sessão
      await req.db.query(`
        INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET current_block = EXCLUDED.current_block,
              last_flow_id = EXCLUDED.last_flow_id,
              vars = EXCLUDED.vars,
              updated_at = EXCLUDED.updated_at
      `, [userId, startBlock, flowId, JSON.stringify({})]);

      // registra transição para auditoria (entered_at = now)
      await req.db.query(`
        INSERT INTO hmg.bot_transitions (user_id, channel, flow_id, block_id, block_label, block_type, entered_at, vars, ticket_number)
        VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8)
      `, [
        userId,
        null,
        flowId,
        startBlock,
        'RESET TO START',
        'system',
        JSON.stringify({ reason: 'reset_by_operator' }),
        null
      ]);

      return reply.send({ ok: true, startBlock });
    } catch (error) {
      fastify.log.error('Erro ao resetar sessão do cliente:', error);
      return reply.code(500).send({
        error: 'Erro interno ao resetar sessão',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/metrics
   * Métricas de gargalo do bot
   * - agora retorna total (excluindo human), loopers (users com loops_in_stage>1), bottlenecks, loops e distribuição
   */
  fastify.get('/metrics', async (req, reply) => {
    try {
      // total (usuários visíveis, sem human)
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
      `;
      const { rows: totalR } = await req.db.query(totalSql);
      const total = totalR?.[0]?.total ?? 0;

      // loopers
      const loopersSql = `
        SELECT count(*)::int AS loopers
        FROM hmg.v_bot_customer_list v
        WHERE v.loops_in_stage > 1
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

      // distribuição atual (quantos usuários por bloco no momento) — exclui human
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

  /**
   * GET /tracert/stages
   * Retorna labels + type (para popular filtro)
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
          WHERE bt.user_id = v.user_id
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
