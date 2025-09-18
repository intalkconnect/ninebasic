// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT (onde está no fluxo, tempo no estágio, loops, gargalos)

async function tracertRoutes(fastify, options) {
  /**
   * GET /bot/tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Params:
   *  - q: busca por name ou user_id
   *  - stage: filtra pelo bloco atual (exato)
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
      min_loops,
      min_time_sec,
      order_by = 'time_in_stage_sec',
      order_dir = 'desc',
      page = '1',
      pageSize = '20',
    } = req.query;

    // validações simples
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sizeNum = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
    const offset = (pageNum - 1) * sizeNum;

    // permite apenas essas colunas para ordering (protege contra SQL injection)
    const allowedOrderBy = new Set(['time_in_stage_sec', 'loops_in_stage', 'name', 'stage_entered_at']);
    const orderByKey = allowedOrderBy.has(String(order_by)) ? String(order_by) : 'time_in_stage_sec';
    // qualificar com alias da view
    const orderBySql = orderByKey === 'stage_entered_at' ? 'v.stage_entered_at' : `v.${orderByKey}`;
    const orderDir = String(order_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

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
        ${whereSql}
      `;
      const { rows: countRows } = await req.db.query(countSql, params);
      const total = countRows?.[0]?.total ?? 0;

      // dados
      // incluí fallback de label:
      // 1) label do fluxo ativo: f.data->'blocks'->>v.current_stage
      // 2) sessions.vars->>'current_block_label'
      // 3) ultima transição em hmg.bot_transitions (subselect lateral)
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
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label
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
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /bot/tracert/customers/:userId
   * Detalhes para o modal: posição atual + jornada + diagnóstico do dwell atual
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    const { userId } = req.params;

    try {
      // Info base (linha do grid) para este user
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
          v.stage_entered_at,
          v.time_in_stage_sec,
          v.loops_in_stage
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id
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

      // Jornada completa (sequência real de blocos)
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
          ),
          '[]'::jsonb
        ) AS journey
        FROM hmg.v_bot_user_journey j
        WHERE j.user_id = $1
      `;
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      const journey = journeyRows?.[0]?.journey ?? [];

      // Diagnóstico do dwell atual (intervalo do estágio atual)
      // Pega o registro de dwell cujo entered_at é o último para esse bloco
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
        dwell, // pode ser null se não houver transições suficientes
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar detalhes do tracert do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar detalhes do tracert do bot',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /bot/tracert/metrics
   * Métricas de gargalo do bot: p95/avg por estágio, taxa média de loops, top estágios por p95
   * Params:
   *  - limit (default 10): quantos estágios retornar no ranking
   */
  fastify.get('/metrics', async (req, reply) => {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10)));

    try {
      // p95/avg de duração por bloco
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

      // média de loops por bloco
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

      // distribuição atual (quantos usuários por bloco no momento)
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
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  /**
   * GET /bot/tracert/stages
   * Retorna a lista de blocos conhecidos para popular filtros no front.
   * Retornamos labels (quando possível) com fallback para sessions / últimas transições.
   */
  fastify.get('/stages', async (req, reply) => {
    try {
      const stagesSql = `
        SELECT DISTINCT
          COALESCE(
            (f.data->'blocks'->>v.current_stage),
            s.vars->>'current_block_label',
            t.block_label
          ) AS label
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id
          ORDER BY bt.entered_at DESC
          LIMIT 1
        ) t ON true
        WHERE v.current_stage IS NOT NULL
        ORDER BY label ASC
      `;
      const { rows } = await req.db.query(stagesSql);
      const labels = (rows || []).map(r => r.label).filter(Boolean);
      return reply.send(labels);
    } catch (error) {
      fastify.log.error('Erro ao listar estágios do bot:', error);
      return reply.code(500).send({
        error: 'Erro interno ao listar estágios',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });
}

export default tracertRoutes;
