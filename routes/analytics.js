// routes/analytics.js
// Todas as rotas de analytics (realtime + métricas) neste único plugin.
// Obs: usa req.db (pg) e ESM.

export default async function analyticsRoutes(fastify, opts) {
  /**
   * Helper: valida janela temporal vinda por querystring
   */
  const parseWindow = (q = {}) => {
    const from = q.from ? new Date(q.from) : null;
    const to   = q.to   ? new Date(q.to)   : null;
    const has  = !!(from && to && !isNaN(from) && !isNaN(to));
    return { has, fromISO: has ? from.toISOString() : null, toISO: has ? to.toISOString() : null };
  };

  /**
   * ==========================
   *  Realtime (estado atual)
   * ==========================
   * GET /analytics/realtime
   * (id, cliente, canal, agente, tempoEspera[min], status, prioridade, fila, posicaoFila, inicioConversa)
   */
 fastify.get('/realtime', async (req, reply) => {
  try {
    const { rows } = await req.db.query(`
      WITH base AS (
        SELECT
          t.id::text      AS ticket_id,
          t.ticket_number,
          t.user_id,
          t.fila,
          t.assigned_to,
          t.created_at,
          CASE
            WHEN t.assigned_to IS NULL THEN 'aguardando'
            ELSE 'em_atendimento'
          END AS status,
          EXTRACT(EPOCH FROM (now() - t.created_at))/60 AS tempo_espera_min
        FROM tickets t
        WHERE t.status = 'open'
      )
      SELECT
        c.name AS cliente,
        c.channel,
        COALESCE(a.name || ' ' || a.lastname, NULL) AS agente,
        b.ticket_id,
        b.fila,
        b.assigned_to,
        b.ticket_number,
        b.created_at AS inicio_conversa,
        b.status,
        b.tempo_espera_min
      FROM base b
      JOIN clientes c ON c.user_id = b.user_id
      LEFT JOIN users a ON a.email::text = b.assigned_to
      ORDER BY b.created_at;
    `);

    const mapped = rows.map((r, i) => ({
      id: i + 1,                
      ticket_id: r.ticket_id,    
      ticket_number: r.ticket_number,
      cliente: r.cliente,
      canal: r.channel,
      agente: r.agente,
      tempoEspera: Math.floor(r.tempo_espera_min), // minutos
      status: r.status,
      prioridade: 'normal',
      fila: r.fila,
      inicioConversa: r.inicio_conversa,
    }));

    return reply.send(mapped);
  } catch (err) {
    req.log.error(err, '[analytics] erro ao buscar atendimentos');
    return reply.status(500).send({ error: 'Erro ao buscar atendimentos' });
  }
});


  /**
   * ==================================
   *  Métricas - Summary (snapshot ou período)
   * ==================================
   * GET /analytics/metrics/summary?from&to
   * Se from&to: calcula sobre tickets CRIADOS no período.
   * Senão: snapshot do "agora" (estado atual).
   */
  fastify.get('/metrics/summary', async (req, reply) => {
    try {
      const { has, fromISO, toISO } = parseWindow(req.query);
      const params = [];
      let whereSQL = '';
      if (has) {
        params.push(fromISO, toISO);
        whereSQL = `WHERE t.created_at >= $1 AND t.created_at < $2`;
      }

      const { rows } = await req.db.query(
        `
        SELECT
          COUNT(*)                                              AS total_criados${has ? '_no_periodo' : ''},
          COUNT(*) FILTER (WHERE t.status='open')               AS backlog_aberto,
          COUNT(*) FILTER (WHERE t.assigned_to IS NULL AND t.status = 'open')         AS aguardando,
          COUNT(*) FILTER (WHERE t.assigned_to IS NOT NULL AND t.status = 'open')     AS em_atendimento,
          ROUND(AVG(EXTRACT(EPOCH FROM (now()-t.created_at))/60)
                FILTER (WHERE t.assigned_to IS NULL))::int      AS espera_media_min_aguardando,
          PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now()-t.created_at))/60)
                FILTER (WHERE t.assigned_to IS NULL)            AS p90_espera_min_aguardando
        FROM tickets t
        ${whereSQL};
        `,
        params
      );

      return rows[0] ?? {};
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/summary erro');
      return reply.status(500).send({ error: 'Erro no summary' });
    }
  });

  /**
   * ==================================
   *  Métricas - Por fila (snapshot ou período)
   * ==================================
   * GET /analytics/metrics/queues?from&to
   */
  fastify.get('/metrics/queues', async (req, reply) => {
    try {
      const { has, fromISO, toISO } = parseWindow(req.query);
      const params = [];
      let whereSQL = '';
      if (has) {
        params.push(fromISO, toISO);
        whereSQL = `WHERE t.created_at >= $1 AND t.created_at < $2`;
      }

      const { rows } = await req.db.query(
        `
        SELECT
          t.fila,
          COUNT(*)                                          AS total_criados${has ? '_no_periodo' : ''},
          COUNT(*) FILTER (WHERE t.status='open')           AS backlog_aberto,
          COUNT(*) FILTER (WHERE t.assigned_to IS NULL AND t.status = 'open')     AS aguardando,
          COUNT(*) FILTER (WHERE t.assigned_to IS NOT NULL AND t.status = 'open') AS em_atendimento,
          ROUND(AVG(EXTRACT(EPOCH FROM (now()-t.created_at))/60)
                FILTER (WHERE t.assigned_to IS NULL))::int  AS espera_media_min_aguardando,
          PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now()-t.created_at))/60)
                FILTER (WHERE t.assigned_to IS NULL)        AS p90_espera_min_aguardando
        FROM tickets t
        ${whereSQL}
        GROUP BY t.fila
        ORDER BY t.fila;
        `,
        params
      );

      return rows;
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/queues erro');
      return reply.status(500).send({ error: 'Erro em queues' });
    }
  });

  /**
   * ==================================
   *  Métricas - FRT (First Response Time)
   * ==================================
   * GET /analytics/metrics/frt?group=channel|fila|day&from&to&fila&canal&agent
   */
  fastify.get('/metrics/frt', async (req, reply) => {
    try {
      const q = req.query || {};
      const group = ['channel', 'fila', 'day'].includes(q.group) ? q.group : 'channel';
      const filaFilter  = q.fila  || null;
      const canalFilter = q.canal || null;
      const agentFilter = q.agent || null;

      const { has, fromISO, toISO } = parseWindow(q);
      const groupExpr =
        group === 'fila'
          ? 't.fila'
          : group === 'day'
            ? "DATE_TRUNC('day', frt.first_in_ts)"
            : 'frt.first_channel';

      const params = [];
      const cond = [];
      let idx = 1;

      if (has) {
        cond.push(`frt.first_in_ts >= $${idx} AND frt.first_in_ts < $${idx + 1}`);
        params.push(fromISO, toISO);
        idx += 2;
      }
      if (filaFilter) {
        cond.push(`t.fila = $${idx}`);
        params.push(filaFilter); idx++;
      }
      if (canalFilter) {
        cond.push(`frt.first_channel = $${idx}`);
        params.push(canalFilter); idx++;
      }
      if (agentFilter) {
        cond.push(`frt.first_agent = $${idx}`);
        params.push(agentFilter); idx++;
      }
      const whereSQL = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

      const { rows } = await req.db.query(
        `
        WITH first_in AS (
          SELECT DISTINCT ON (m.ticket_number)
                 m.ticket_number,
                 m.timestamp AS first_in_ts,
                 m.channel   AS first_channel
          FROM messages m
          WHERE m.direction='incoming'
          ORDER BY m.ticket_number, m.timestamp
        ),
        first_out_msg AS (
          SELECT
            fi.ticket_number,
            m.timestamp   AS first_out_ts,
            m.assigned_to AS first_agent
          FROM first_in fi
          LEFT JOIN LATERAL (
            SELECT m.timestamp, m.assigned_to
            FROM messages m
            WHERE m.ticket_number = fi.ticket_number
              AND m.direction='outgoing'
              AND m.timestamp > fi.first_in_ts
            ORDER BY m.timestamp
            LIMIT 1
          ) m ON TRUE
        ),
        frt AS (
          SELECT
            fi.ticket_number,
            fi.first_in_ts,
            fi.first_channel,
            fo.first_out_ts,
            fo.first_agent,
            EXTRACT(EPOCH FROM (fo.first_out_ts - fi.first_in_ts))/60.0 AS frt_min
          FROM first_in fi
          LEFT JOIN first_out_msg fo ON fo.ticket_number = fi.ticket_number
        )
        SELECT
          ${groupExpr} AS group_key,
          ROUND(AVG(frt.frt_min)::numeric,2) AS frt_media_min,
          PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY frt.frt_min) AS frt_p50,
          PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY frt.frt_min) AS frt_p90,
          (COUNT(*) FILTER (WHERE frt.frt_min IS NOT NULL AND frt.frt_min <= 5)  * 100.0 / NULLIF(COUNT(*),0)) AS sla_5min_pct,
          (COUNT(*) FILTER (WHERE frt.frt_min IS NOT NULL AND frt.frt_min <= 15) * 100.0 / NULLIF(COUNT(*),0)) AS sla_15min_pct
        FROM frt
        LEFT JOIN tickets t ON t.ticket_number = frt.ticket_number
        ${whereSQL}
        GROUP BY 1
        ORDER BY 1;
        `,
        params
      );

      return { group_by: group, metrics: rows };
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/frt erro');
      return reply.status(500).send({ error: 'Erro em FRT' });
    }
  });

  /**
   * ==================================
   *  Métricas - ART por agente
   * ==================================
   * GET /analytics/metrics/agents/art?from&to&fila&canal&agent
   */
  fastify.get('/metrics/agents/art', async (req, reply) => {
    try {
      const q = req.query || {};
      const filaFilter  = q.fila  || null;
      const canalFilter = q.canal || null;
      const agentFilter = q.agent || null;

      const { has, fromISO, toISO } = parseWindow(q);

      const params = [];
      const cond = [];
      let idx = 1;

      if (has) {
        cond.push(`pair.in_ts >= $${idx} AND pair.in_ts < $${idx + 1}`);
        params.push(fromISO, toISO);
        idx += 2;
      }
      if (filaFilter) {
        cond.push(`t.fila = $${idx}`);
        params.push(filaFilter); idx++;
      }
      if (canalFilter) {
        cond.push(`pair.channel = $${idx}`);
        params.push(canalFilter); idx++;
      }
      if (agentFilter) {
        cond.push(`pair.assigned_to = $${idx}`);
        params.push(agentFilter); idx++;
      }
      const whereSQL = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

      const { rows } = await req.db.query(
        `
        WITH incoming AS (
          SELECT m.id, m.ticket_number, m.timestamp AS in_ts, m.channel
          FROM messages m
          WHERE m.direction='incoming'
        ),
        pair AS (
          SELECT i.ticket_number, i.in_ts, i.channel, o.timestamp AS out_ts, o.assigned_to
          FROM incoming i
          JOIN LATERAL (
            SELECT m.timestamp, m.assigned_to
            FROM messages m
            WHERE m.ticket_number = i.ticket_number
              AND m.direction='outgoing'
              AND m.timestamp > i.in_ts
            ORDER BY m.timestamp
            LIMIT 1
          ) o ON TRUE
        )
        SELECT
          pair.assigned_to AS agente,
          ROUND(AVG(EXTRACT(EPOCH FROM (pair.out_ts - pair.in_ts))/60.0)::numeric,2) AS art_media_min,
          COUNT(*) AS interacoes
        FROM pair
        LEFT JOIN tickets t ON t.ticket_number = pair.ticket_number
        ${whereSQL}
        GROUP BY 1
        ORDER BY art_media_min NULLS LAST;
        `,
        params
      );

      return rows;
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/agents/art erro');
      return reply.status(500).send({ error: 'Erro em ART' });
    }
  });

  /**
   * ==================================
   *  Métricas - Duração por fila
   * ==================================
   * GET /analytics/metrics/duration-by-queue?from&to&fila&canal
   */
  fastify.get('/metrics/duration-by-queue', async (req, reply) => {
    try {
      const q = req.query || {};
      const filaFilter  = q.fila  || null;
      const canalFilter = q.canal || null;

      const { has, fromISO, toISO } = parseWindow(q);

      const params = [];
      const cond = [];
      let idx = 1;

      if (has) {
        cond.push(`s.first_ts >= $${idx} AND s.first_ts < $${idx + 1}`);
        params.push(fromISO, toISO);
        idx += 2;
      }
      if (filaFilter) {
        cond.push(`t.fila = $${idx}`);
        params.push(filaFilter); idx++;
      }
      if (canalFilter) {
        cond.push(`first_in.channel = $${idx}`);
        params.push(canalFilter); idx++;
      }
      const whereSQL = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

      const { rows } = await req.db.query(
        `
        WITH span AS (
          SELECT
            m.ticket_number,
            MIN(m.timestamp) AS first_ts,
            MAX(m.timestamp) AS last_ts
          FROM messages m
          GROUP BY m.ticket_number
        ),
        first_in AS (
          SELECT DISTINCT ON (m.ticket_number)
                 m.ticket_number, m.channel
          FROM messages m
          WHERE m.direction='incoming'
          ORDER BY m.ticket_number, m.timestamp
        )
        SELECT
          t.fila,
          ROUND(AVG(EXTRACT(EPOCH FROM (s.last_ts - s.first_ts))/60.0)::numeric, 2) AS duracao_media_min,
          PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.last_ts - s.first_ts))/60.0) AS duracao_p90_min,
          COUNT(*) AS tickets
        FROM span s
        JOIN tickets t ON t.ticket_number = s.ticket_number
        LEFT JOIN first_in ON first_in.ticket_number = s.ticket_number
        ${whereSQL}
        GROUP BY t.fila
        ORDER BY t.fila;
        `,
        params
      );

      return rows;
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/duration-by-queue erro');
      return reply.status(500).send({ error: 'Erro em duração' });
    }
  });

  /**
   * ==================================
   *  Métricas - Abandono (sem 1ª resposta até threshold)
   * ==================================
   * GET /analytics/metrics/abandonment?from&to&fila&canal&threshold_min=15
   */
  fastify.get('/metrics/abandonment', async (req, reply) => {
    try {
      const q = req.query || {};
      const filaFilter  = q.fila  || null;
      const canalFilter = q.canal || null;
      const thresholdMin = Number.isFinite(+q.threshold_min) ? Math.max(1, +q.threshold_min) : 15;

      const { has, fromISO, toISO } = parseWindow(q);

      const params = [thresholdMin];
      const cond = [];
      let idx = 2;

      if (has) {
        cond.push(`fi.first_in_ts >= $${idx} AND fi.first_in_ts < $${idx + 1}`);
        params.push(fromISO, toISO); idx += 2;
      }
      if (filaFilter) {
        cond.push(`t.fila = $${idx}`); params.push(filaFilter); idx++;
      }
      if (canalFilter) {
        cond.push(`fi.first_channel = $${idx}`); params.push(canalFilter); idx++;
      }
      const whereSQL = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

      const { rows } = await req.db.query(
        `
        WITH first_in AS (
          SELECT DISTINCT ON (m.ticket_number)
                 m.ticket_number,
                 m.timestamp AS first_in_ts,
                 m.channel   AS first_channel
          FROM messages m
          WHERE m.direction='incoming'
          ORDER BY m.ticket_number, m.timestamp
        ),
        first_out AS (
          SELECT fi.ticket_number, m.timestamp AS first_out_ts
          FROM first_in fi
          LEFT JOIN LATERAL (
            SELECT m.timestamp
            FROM messages m
            WHERE m.ticket_number = fi.ticket_number
              AND m.direction='outgoing'
              AND m.timestamp > fi.first_in_ts
            ORDER BY m.timestamp
            LIMIT 1
          ) m ON TRUE
        )
        SELECT
          COUNT(*) FILTER (
            WHERE fo.first_out_ts IS NULL
               OR fo.first_out_ts > fi.first_in_ts + make_interval(mins => $1)
          ) AS abandonados,
          COUNT(*) AS total,
          ROUND(
            COUNT(*) FILTER (
              WHERE fo.first_out_ts IS NULL
                 OR fo.first_out_ts > fi.first_in_ts + make_interval(mins => $1)
            ) * 100.0 / NULLIF(COUNT(*),0)
          , 2) AS taxa_pct
        FROM first_in fi
        LEFT JOIN first_out fo ON fo.ticket_number = fi.ticket_number
        LEFT JOIN tickets t ON t.ticket_number = fi.ticket_number
        ${whereSQL};
        `,
        params
      );

      return { threshold_min: thresholdMin, ...(rows[0] ?? {}) };
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/abandonment erro');
      return reply.status(500).send({ error: 'Erro em abandono' });
    }
  });

  /**
   * ==================================
   *  Métricas - Aging do backlog (snapshot atual)
   * ==================================
   * GET /analytics/metrics/aging-by-queue
   */
  fastify.get('/metrics/aging-by-queue', async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
        SELECT
          t.fila,
          COUNT(*) FILTER (WHERE t.status='open' AND now()-t.created_at <= INTERVAL '15 minutes') AS ate_15m,
          COUNT(*) FILTER (WHERE t.status='open' AND now()-t.created_at >  INTERVAL '15 minutes' AND now()-t.created_at <= INTERVAL '30 minutes') AS m15_a_30m,
          COUNT(*) FILTER (WHERE t.status='open' AND now()-t.created_at >  INTERVAL '30 minutes' AND now()-t.created_at <= INTERVAL '60 minutes') AS m30_a_60m,
          COUNT(*) FILTER (WHERE t.status='open' AND now()-t.created_at >  INTERVAL '60 minutes' AND now()-t.created_at <= INTERVAL '4 hours') AS h1_a_h4,
          COUNT(*) FILTER (WHERE t.status='open' AND now()-t.created_at >  INTERVAL '4 hours') AS acima_4h
        FROM tickets t
        GROUP BY t.fila
        ORDER BY t.fila;
      `);
      return rows;
    } catch (err) {
      req.log.error(err, '[analytics] /metrics/aging-by-queue erro');
      return reply.status(500).send({ error: 'Erro em aging' });
    }
  });

  /**
 * ==========================
 *  Realtime - Somente agentes
 * ==========================
 * GET /analytics/agents/realtime
 * Retorna todos os atendentes (online, pause, offline, inativo),
 * com motivo/duração da pausa e # de tickets abertos por agente.
 */
fastify.get('/agents/realtime', async (req, reply) => {
  try {
    const { rows } = await req.db.query(`
      WITH agentes_base AS (
        SELECT
          a.email,
          COALESCE(a.name || ' ' || a.lastname, a.email) AS agente,
          a.status,                         -- 'online' | 'pause' | 'offline' | 'inativo'
          a.filas,
          a.last_seen,
          a.session_id,
          -- sessão de pausa aberta em pausa_sessoes (preferida, pois tem reason)
          ps.reason      AS pausa_motivo,
          ps.started_at  AS pausa_inicio,
          CASE
            WHEN a.status = 'pause' AND ps.started_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (now() - ps.started_at))/60.0
            WHEN a.status = 'pause' AND ps.started_at IS NULL AND a.pause_started_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (now() - a.pause_started_at))/60.0
            ELSE NULL
          END AS pausa_duracao_min
        FROM users a
        LEFT JOIN hmg.pausa_sessoes ps
          ON ps.email = a.email AND ps.ended_at IS NULL
      ),
      ticket_counts AS (
        SELECT
          t.assigned_to AS email,
          COUNT(*) FILTER (WHERE t.status = 'open') AS tickets_abertos
        FROM tickets t
        GROUP BY t.assigned_to
      )
      SELECT
        b.agente,
        b.email,
        b.status,
        b.pausa_motivo,
        b.pausa_inicio,
        CASE WHEN b.pausa_duracao_min IS NOT NULL
             THEN ROUND(b.pausa_duracao_min)::int END AS pausa_duracao_min,
        COALESCE(tc.tickets_abertos, 0) AS tickets_abertos,
        b.filas,
        b.last_seen,
        b.session_id
      FROM agentes_base b
      LEFT JOIN ticket_counts tc USING (email)
      ORDER BY
        CASE b.status
          WHEN 'online'  THEN 1
          WHEN 'pause'   THEN 2
          WHEN 'offline' THEN 3
          WHEN 'inativo' THEN 4
          ELSE 5
        END,
        b.agente;
    `);

    const agents = rows.map(r => ({
      agente: r.agente,
      email: r.email,
      status: r.status, // já vem como 'online' | 'pause' | 'offline' | 'inativo'
      pausa: r.status === 'pause'
        ? { motivo: r.pausa_motivo || null, inicio: r.pausa_inicio, duracao_min: r.pausa_duracao_min ?? null }
        : null,
      tickets_abertos: Number(r.tickets_abertos) || 0,
      filas: r.filas || [],
      last_seen: r.last_seen,
      session_id: r.session_id,
    }));

    return reply.send(agents);
  } catch (err) {
    req.log.error(err, '[analytics] /agents/realtime erro');
    return reply.status(500).send({ error: 'Erro em realtime de agentes' });
  }
});

// GET /analytics/metrics/new-clients?group=day&from&to
fastify.get('/metrics/new-clients', async (req, reply) => {
  try {
    const q = req.query || {};
    const group = ['day','month'].includes(q.group) ? q.group : 'day';
    const { has, fromISO, toISO } = parseWindow(q);

    const params = [];
    let whereSQL = '';
    if (has) {
      params.push(fromISO, toISO);
      whereSQL = `WHERE c.created_at >= $1 AND c.created_at < $2`;
    }

    const groupExpr = group === 'month'
      ? `DATE_TRUNC('month', c.created_at)`
      : `DATE_TRUNC('day', c.created_at)`;

    const { rows } = await req.db.query(
      `
      SELECT ${groupExpr} AS group_key,
             COUNT(*) AS total
      FROM clientes c
      ${whereSQL}
      GROUP BY 1
      ORDER BY 1;
      `,
      params
    );

    return { group_by: group, metrics: rows };
  } catch (err) {
    req.log.error(err, '[analytics] /metrics/new-clients erro');
    return reply.status(500).send({ error: 'Erro em novos clientes' });
  }
});

  // routes/metrics.js
/**
 * Rotas para persistir e consultar métricas de NPS/CSAT.
 *
 * Tabela sugerida (PostgreSQL) — crie antes:
 * --------------------------------------------------------------------
 * CREATE TABLE IF NOT EXISTS feedback_metrics (
 *   id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   type           TEXT NOT NULL CHECK (type IN ('nps','csat')),
 *   score          INT  NOT NULL,
 *   category       TEXT,            -- nps: detractor/passive/promoter
 *   label          TEXT,            -- csat: bad/neutral/good/excellent
 *   comment        TEXT,
 *   channel        TEXT,
 *   ticket_number  TEXT,
 *   protocol       TEXT,
 *   agent_id       TEXT,
 *   agent_name     TEXT,
 *   user_id        TEXT,
 *   created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * CREATE INDEX IF NOT EXISTS ix_feedback_metrics_created_at ON feedback_metrics (created_at);
 * CREATE INDEX IF NOT EXISTS ix_feedback_metrics_type ON feedback_metrics (type);
 * --------------------------------------------------------------------
 */
  // Helpers --------------------------------------------------------------
  function asInt(x) {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : null;
  }
  function inRange(n, min, max) {
    return Number.isFinite(n) && n >= min && n <= max;
  }

  // POST /metrics/feedback  -> salva NPS/CSAT
  fastify.post('/metrics/feedback', async (req, reply) => {
    try {
      const {
        type,               // 'nps' | 'csat'
        score,              // number (0-10 para nps, 1-5 para csat)
        category = null,    // 'detractor'|'passive'|'promoter' (nps)
        label = null,       // 'bad'|'neutral'|'good'|'excellent' (csat)
        comment = null,
        channel = null,
        ticketNumber = null,
        protocol = null,
        agentId = null,
        agentName = null,
        userId = null,
      } = req.body || {};

      if (!['nps','csat'].includes(type || '')) {
        return reply.code(400).send({ error: "type deve ser 'nps' ou 'csat'" });
      }

      const s = asInt(score);
      if (type === 'nps' && !inRange(s, 0, 10)) {
        return reply.code(400).send({ error: 'score NPS deve estar entre 0 e 10' });
      }
      if (type === 'csat' && !inRange(s, 1, 5)) {
        return reply.code(400).send({ error: 'score CSAT deve estar entre 1 e 5' });
      }

      // Persistência
      await req.db.query(
        `
        INSERT INTO feedback_metrics
          (type, score, category, label, comment, channel, ticket_number, protocol, agent_id, agent_name, user_id)
        VALUES
          ($1,   $2,    $3,       $4,    $5,      $6,      $7,            $8,       $9,       $10,        $11);
        `,
        [
          type, s, category ?? null, label ?? null, comment ?? null,
          channel ?? null, ticketNumber ?? null, protocol ?? null,
          agentId ?? null, agentName ?? null, userId ?? null
        ]
      );

      return reply.send({ ok: true });
    } catch (err) {
      fastify.log.error(err, 'Erro ao salvar feedback');
      return reply.code(500).send({ error: 'Erro ao salvar feedback' });
    }
  });

 // GET /metrics/series/nps  -> série temporal para gráficos (com NPS e distribuição)
fastify.get('/metrics/series/nps', async (req, reply) => {
  const { bucket = 'day', from, to } = req.query || {};
  const trunc = bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day';

  // Filtros dinâmicos
  const params = [];
  let where = `WHERE type = 'nps'`;
  if (from) { params.push(new Date(from)); where += ` AND created_at >= $${params.length}`; }
  if (to)   { params.push(new Date(to));   where += ` AND created_at <  $${params.length}`; }

  try {
    const { rows } = await req.db.query(
      `
      WITH base AS (
        SELECT
          date_trunc('${trunc}', created_at)       AS bucket,
          COUNT(*)                                 AS total,
          -- usa category se existir, senão classifica por score (robustez)
          SUM(CASE WHEN category='promoter'  OR score BETWEEN  9 AND 10 THEN 1 ELSE 0 END) AS promoters,
          SUM(CASE WHEN category='passive'   OR score BETWEEN  7 AND  8 THEN 1 ELSE 0 END) AS passives,
          SUM(CASE WHEN category='detractor' OR score BETWEEN  0 AND  6 THEN 1 ELSE 0 END) AS detractors,
          AVG(score)::float                        AS avg_score
        FROM feedback_metrics
        ${where}
        GROUP BY 1
      )
      SELECT
        bucket,
        avg_score,
        total,
        promoters        AS promoters_count,
        passives         AS passives_count,
        detractors       AS detractors_count,
        100.0 * promoters  / NULLIF(total,0) AS pct_promoters,
        100.0 * passives   / NULLIF(total,0) AS pct_passives,
        100.0 * detractors / NULLIF(total,0) AS pct_detractors,
        -- valor pronto para o "velocímetro" de NPS (-100..100)
        (100.0 * promoters / NULLIF(total,0)) - (100.0 * detractors / NULLIF(total,0)) AS nps
      FROM base
      ORDER BY 1;
      `,
      params
    );
    return reply.send(rows);
  } catch (err) {
    req.log.error(err, 'Erro ao gerar série NPS');
    return reply.code(500).send({ error: 'Erro ao gerar série NPS' });
  }
});


// GET /metrics/series/csat -> série temporal para gráficos (com distribuição e gauge)
fastify.get('/metrics/series/csat', async (req, reply) => {
  const { bucket = 'day', from, to } = req.query || {};
  const trunc = bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day';

  const params = [];
  let where = `WHERE type = 'csat'`;
  if (from) { params.push(new Date(from)); where += ` AND created_at >= $${params.length}`; }
  if (to)   { params.push(new Date(to));   where += ` AND created_at <  $${params.length}`; }

  try {
    const { rows } = await req.db.query(
      `
      WITH base AS (
        SELECT
          date_trunc('${trunc}', created_at) AS bucket,
          COUNT(*)                           AS total,
          AVG(score)::float                  AS avg_score,
          SUM((score = 1)::int)              AS count_1,
          SUM((score = 2)::int)              AS count_2,
          SUM((score = 3)::int)              AS count_3,
          SUM((score = 4)::int)              AS count_4,
          SUM((score = 5)::int)              AS count_5
        FROM feedback_metrics
        ${where}
        GROUP BY 1
      )
      SELECT
        bucket,
        avg_score,
        total,
        count_1, count_2, count_3, count_4, count_5,
        100.0 * (count_4 + count_5) / NULLIF(total,0)                    AS pct_satisfied,
        -- porcentagem pronta para "termômetro" (0..100) a partir da média 1..5
        GREATEST(0, LEAST(100, 100.0 * (avg_score - 1.0) / 4.0))         AS gauge_pct
      FROM base
      ORDER BY 1;
      `,
      params
    );
    return reply.send(rows);
  } catch (err) {
    req.log.error(err, 'Erro ao gerar série CSAT');
    return reply.code(500).send({ error: 'Erro ao gerar série CSAT' });
  }
});

fastify.get('/metrics/feedback/responses', async (req, reply) => {
    try {
      const {
        from,
        to,
        type,            // 'nps' | 'csat' (opcional)
        channel,         // ex: 'whatsapp' (opcional)
        agentId,         // (opcional)
        userId,          // (opcional)
        q,               // busca textual em comment/user_id/agent_name/ticket_number/protocol
        include_empty,   // 'true' para incluir respostas sem comment (default: false)
        limit = '50',
        offset = '0',
        order = 'desc'
      } = req.query || {};

      // período padrão: 1º dia do mês atual (UTC) → agora
      const now = new Date();
      const startDefault = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
      const start = from ? new Date(from) : startDefault;
      const end   = to   ? new Date(to)   : now;

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
        return reply.code(400).send({ error: 'Parâmetros de data inválidos' });
      if (start > end)
        return reply.code(400).send({ error: '`from` não pode ser maior que `to`' });

      const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const ord = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const wantEmpty = include_empty === 'true' || include_empty === true;

      const where = ['f.created_at >= $1', 'f.created_at < $2'];
      const params = [start.toISOString(), end.toISOString()];

      const add = (sql, val) => { where.push(sql.replace('?', `$${params.length + 1}`)); params.push(val); };

      if (type && ['nps', 'csat'].includes(String(type).toLowerCase())) add('f.type = ?', String(type).toLowerCase());
      if (channel) add('f.channel = ?', channel);
      if (agentId) add('f.agent_id = ?', agentId);
      if (userId)  add('f.user_id = ?', userId);

      // por padrão só traz quem tem comentário
      if (!wantEmpty) where.push('(f.comment IS NOT NULL AND length(btrim(f.comment)) > 0)');

      if (q && String(q).trim()) {
        const like = `%${String(q).trim()}%`;
        const next = `$${params.length + 1}`;
        where.push(`(f.comment ILIKE ${next}
                 OR f.user_id ILIKE ${next}
                 OR f.agent_name ILIKE ${next}
                 OR f.ticket_number ILIKE ${next}
                 OR f.protocol ILIKE ${next})`);
        params.push(like);
      }

      const whereSql = where.join(' AND ');

      // total para paginação
      const totalSql = `SELECT COUNT(*)::int AS total FROM hmg.feedback_metrics f WHERE ${whereSql};`;
      const { rows: totalRows } = await req.db.query(totalSql, params);
      const total = totalRows[0]?.total || 0;

      // lista paginada
      const listSql = `
        SELECT
          f.id,
          f.type,
          f.score,
          f.category,
          f.label,
          f.comment,
          f.channel,
          f.ticket_number,
          f.protocol,
          f.agent_id,
          f.agent_name,
          f.user_id,
          f.created_at
        FROM hmg.feedback_metrics f
        WHERE ${whereSql}
        ORDER BY f.created_at ${ord}
        LIMIT ${lim} OFFSET ${off};
      `;
      const { rows } = await req.db.query(listSql, params);

      return reply.send({
        period: { from: start.toISOString(), to: end.toISOString() },
        page:   { limit: lim, offset: off, order: ord.toLowerCase(), total },
        data:   rows
      });
    } catch (err) {
      fastify.log.error(err, 'Erro ao listar comentários de feedback');
      return reply.code(500).send({ error: 'Erro ao listar comentários de feedback' });
    }
  });
  
}
