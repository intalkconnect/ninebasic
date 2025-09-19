// routes/botTracertRoutes.js
// Endpoints para o "trace" do BOT (onde está no fluxo, tempo no estágio, loops, gargalos)

async function tracertRoutes(fastify, options) {
  /**
   * GET /tracert/customers
   * Lista paginada dos clientes com posição no bot.
   * Params:
   *  - q
   *  - stage
   *  - min_loops
   *  - min_time_sec
   *  - exclude_human (true|false)  // oculta sessões em que o último bloco é do tipo 'human'
   *  - order_by, order_dir, page, pageSize
   */
  fastify.get('/customers', async (req, reply) => {
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
      // O frontend passa o label (current_stage_label) — se você filtrar por label
      // então é necessário comparar com current_stage_label (você pode ter que ajustar).
      // Aqui assumimos stage é o block id (se for label altere a condição abaixo).
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

    // Excluir sessões em humano: checamos preferencialmente v.current_stage_type, senão a última transição lateral
    if (String(exclude_human).toLowerCase() === 'true') {
      // adicionamos condição que será avaliada na WHERE (t.block_type é último tipo)
      where.push(`(
        COALESCE(
          v.current_stage_type,
          (SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.visible IS DISTINCT FROM false ORDER BY bt.entered_at DESC LIMIT 1)
        ) IS NULL
        OR COALESCE(
          v.current_stage_type,
          (SELECT bt.block_type FROM hmg.bot_transitions bt WHERE bt.user_id = v.user_id AND bt.visible IS DISTINCT FROM false ORDER BY bt.entered_at DESC LIMIT 1)
        ) <> 'human'
      )`);
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
      // IMPORTANT: para pegar o 'type' do bloco dinamicamente dentro do JSON do flow:
      // ((f.data->'blocks') -> v.current_stage ->> 'type')
      // COALESCE com sessions.vars e com última transição visível
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
            ((f.data->'blocks') -> v.current_stage ->> 'type'),
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
          WHERE bt.user_id = v.user_id AND bt.visible IS DISTINCT FROM false
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
      fastify.log.error('Erro ao listar tracert do bot (customers):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao listar tracert do bot',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/customers/:userId
   * Detalhes para o modal: posição atual + jornada + diagnóstico do dwell atual + last_reset_at
   */
  fastify.get('/customers/:userId', async (req, reply) => {
    const { userId } = req.params;

    try {
      // Base row (grid line)
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
            ((f.data->'blocks') -> v.current_stage ->> 'type'),
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
          WHERE bt.user_id = v.user_id AND bt.visible IS DISTINCT FROM false
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

      // Jornada completa (somente transições visíveis = true)
      const journeySql = `
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stage', bt.block_label,
              'block_id', bt.block_id,
              'type', bt.block_type,
              'timestamp', bt.entered_at,
              'vars', bt.vars
            ) ORDER BY bt.entered_at
          ), '[]'::jsonb
        ) AS journey
        FROM hmg.bot_transitions bt
        WHERE bt.user_id = $1
          AND (bt.visible IS DISTINCT FROM false)
        ORDER BY bt.entered_at
      `;
      const { rows: journeyRows } = await req.db.query(journeySql, [userId]);
      let journey = journeyRows?.[0]?.journey ?? [];

      // Se houver last_reset_at na sessão (base.last_reset_at), aplique o filtro e retorne trimmed journey
      if (base.last_reset_at) {
        const resetTs = new Date(base.last_reset_at).getTime();
        journey = (journey || []).filter(j => {
          const t = j?.timestamp ? new Date(j.timestamp).getTime() : 0;
          return t >= resetTs;
        });
      }

      // Diagnóstico do dwell atual (pega ultima entrada para o bloco atual)
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
      fastify.log.error('Erro ao buscar detalhes do tracert do bot (customer):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar detalhes do tracert do bot',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * POST /tracert/customers/:userId/reset
   * Marca transições antigas como visible=false e cria uma transição "system_reset" apontando para flow.start
   * Atualiza sessions.vars.last_reset_at e sessions.current_block = flow.start
   */
  fastify.post('/customers/:userId/reset', async (req, reply) => {
    const { userId } = req.params;

    // usar transação
    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

      // pega flow ativo
      const flowRow = await client.query(`SELECT id, data FROM hmg.flows WHERE active = true LIMIT 1`);
      const flow = flowRow.rows?.[0] || null;
      const flowId = flow?.id || null;
      const flowStart = flow ? (flow.data?.start || (flow.data && flow.data.start)) : null;
      // fallback para string start em data
      // se flow.data for JSON e tiver start em raiz, use-o; caso contrário o usuário precisa ajustar
      const startBlockId = flowStart || null;

      const now = new Date().toISOString();

      // 1) marcar transições anteriores como não-visíveis
      await client.query(
        `UPDATE hmg.bot_transitions
         SET visible = false
         WHERE user_id = $1 AND (visible IS DISTINCT FROM false)`,
        [userId]
      );

      // 2) inserir nova transição do tipo system_reset apontando para startBlockId
      const insertSql = `
        INSERT INTO hmg.bot_transitions (user_id, channel, flow_id, block_id, block_label, block_type, entered_at, vars, visible)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        RETURNING id, entered_at
      `;
      // tenta recuperar label do flow.data->'blocks'->>startBlockId
      let startLabel = null;
      if (flow && startBlockId) {
        try {
          startLabel = (flow.data && (flow.data.blocks && flow.data.blocks[startBlockId])) ?
            (flow.data.blocks[startBlockId].label || startBlockId) : startBlockId;
        } catch (e) {
          startLabel = startBlockId;
        }
      }

      const ch = null; // channel opcional — se quiser busque a partir de sessions/user
      await client.query(insertSql, [
        userId,
        ch,
        flowId,
        startBlockId,
        startLabel || 'START',
        'system_reset',
        now,
        JSON.stringify({ reset_by: req.user?.id || 'system', reset_at: now }),
      ]);

      // 3) Atualiza sessions: current_block = flow.start, vars.last_reset_at = now
      await client.query(
        `INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           current_block = EXCLUDED.current_block,
           last_flow_id = EXCLUDED.last_flow_id,
           vars = EXCLUDED.vars,
           updated_at = EXCLUDED.updated_at`,
        [userId, startBlockId || 'start', flowId, JSON.stringify({ ...(req.body?.vars || {}), last_reset_at: now })]
      );

      await client.query('COMMIT');

      return reply.send({ ok: true, reset_at: now });
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error('Erro ao resetar sessão do cliente (tracert reset):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao resetar sessão',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    } finally {
      client.release();
    }
  });

  /**
   * POST /tracert/customers/:userId/handover
   * Marca a sessão como 'human' (abre handover). Aqui você pode integrar com seu distribuidor de tickets.
   * corpo opcional: { queueName: 'Recepção Matriz' }
   */
  fastify.post('/customers/:userId/handover', async (req, reply) => {
    const { userId } = req.params;
    const { queueName } = req.body || {};

    try {
      // marca sessão como human e grava fila (vars.handover)
      const selectSql = `SELECT vars FROM hmg.sessions WHERE user_id = $1 LIMIT 1`;
      const { rows: sel } = await req.db.query(selectSql, [userId]);
      const existingVars = sel?.[0]?.vars || {};

      const newVars = {
        ...(typeof existingVars === 'object' ? existingVars : {}),
        handover: {
          status: 'open',
          origin: existingVars?.current_block || null,
          queueName: queueName || existingVars?.handover?.queueName || null,
          opened_at: new Date().toISOString()
        }
      };

      await req.db.query(
        `INSERT INTO hmg.sessions (user_id, current_block, last_flow_id, vars, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           current_block = EXCLUDED.current_block,
           last_flow_id = EXCLUDED.last_flow_id,
           vars = EXCLUDED.vars,
           updated_at = EXCLUDED.updated_at`,
        [userId, 'human', null, JSON.stringify(newVars)]
      );

      // opcional: se tiver função para distribuir ticket, chame-a aqui (ex: distribuirTicket)
      // const ticket = await distribuirTicket(userIdRaw, queueName, 'whatsapp');

      return reply.send({ ok: true });
    } catch (error) {
      fastify.log.error('Erro ao abrir handover (tracert handover):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao abrir handover',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/metrics
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
      fastify.log.error('Erro ao calcular métricas do tracert do bot (metrics):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao calcular métricas',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });

  /**
   * GET /tracert/stages
   * Retorna { label, type } (somente labels visíveis)
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
            ((f.data->'blocks') -> v.current_stage ->> 'type'),
            s.vars->>'current_block_type',
            t.block_type
          ) AS type
        FROM hmg.v_bot_customer_list v
        LEFT JOIN hmg.flows f ON f.active = true
        LEFT JOIN hmg.sessions s ON s.user_id = v.user_id
        LEFT JOIN LATERAL (
          SELECT bt.block_label, bt.block_type
          FROM hmg.bot_transitions bt
          WHERE bt.user_id = v.user_id AND bt.visible IS DISTINCT FROM false
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
      fastify.log.error('Erro ao listar estágios do bot (stages):', error.stack || error);
      return reply.code(500).send({
        error: 'Erro interno ao listar estágios',
        details: process.env.NODE_ENV === 'development' ? String(error.stack || error.message || error) : undefined,
      });
    }
  });
}

export default tracertRoutes;
