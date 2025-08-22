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
async function metricsRoutes(fastify, _options) {
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

  // GET /metrics/series/nps  -> série temporal para gráficos
  fastify.get('/metrics/series/nps', async (req, reply) => {
    const { bucket = 'day' } = req.query || {}; // 'day' | 'week' | 'month'
    const trunc = bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day';
    try {
      const { rows } = await req.db.query(
        `
        SELECT
          date_trunc('${trunc}', created_at) AS bucket,
          AVG(score)::float AS avg_score,
          100.0 * SUM(CASE WHEN category='promoter'  THEN 1 ELSE 0 END)::float / COUNT(*) AS pct_promoters,
          100.0 * SUM(CASE WHEN category='detractor' THEN 1 ELSE 0 END)::float / COUNT(*) AS pct_detractors,
          COUNT(*) AS total
        FROM feedback_metrics
        WHERE type='nps'
        GROUP BY 1
        ORDER BY 1;
        `
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err, 'Erro ao gerar série NPS');
      return reply.code(500).send({ error: 'Erro ao gerar série NPS' });
    }
  });

  // GET /metrics/series/csat -> série temporal para gráficos
  fastify.get('/metrics/series/csat', async (req, reply) => {
    const { bucket = 'day' } = req.query || {};
    const trunc = bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day';
    try {
      const { rows } = await req.db.query(
        `
        SELECT
          date_trunc('${trunc}', created_at) AS bucket,
          AVG(score)::float AS avg_score,
          COUNT(*) AS total
        FROM feedback_metrics
        WHERE type='csat'
        GROUP BY 1
        ORDER BY 1;
        `
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err, 'Erro ao gerar série CSAT');
      return reply.code(500).send({ error: 'Erro ao gerar série CSAT' });
    }
  });
}

export default metricsRoutes;
