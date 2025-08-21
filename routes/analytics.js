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
        b.fila,
        b.assigned_to,
        b.ticket_number,
        b.created_at AS inicio_conversa,
        b.status,
        b.tempo_espera_min
      FROM base b
      JOIN clientes c ON c.user_id = b.user_id
      LEFT JOIN atendentes a ON a.email::text = b.assigned_to
      ORDER BY b.created_at;
    `);

    const mapped = rows.map((r, i) => ({
      id: i + 1,
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
}
