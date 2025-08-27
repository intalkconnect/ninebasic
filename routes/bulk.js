// server/routes/bulk.js
import amqplib from 'amqplib';

const BULK_ORCH_Q = process.env.BULK_ORCH_Q || 'bulk.orchestrator';
const AMQP_URL    = process.env.AMQP_URL    || 'amqp://guest:guest@rabbitmq:5672';

async function ensurePublisher() {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(BULK_ORCH_Q, { durable: true });
  return { conn, ch };
}

function ok(reply, data) { return reply.send({ ok: true, ...data }); }
function fail(reply, code, msg, err) {
  return reply.code(code).send({
    error: msg,
    details: err ? String(err?.message || err) : undefined,
  });
}

async function bulkRoutes(fastify) {
  // POST /bulk -> cria campanha + recipients (opcional autostart)
  fastify.post('/bulk', async (req, reply) => {
    const {
      name,
      template_name,
      language_code = 'pt_BR',
      template_components = null,
      recipients = [], // [{ phone, vars?, header_vars?, button_params? }]
      scheduled_at = null,
      autostart = false,
      created_by = null,
    } = req.body || {};

    if (!name || !template_name || !Array.isArray(recipients) || recipients.length === 0) {
      return fail(reply, 400, 'Campos obrigatórios: name, template_name, recipients (array).');
    }

    try {
      // cria campanha
      const { rows: cRows } = await req.db.query(
        `INSERT INTO bulk_campaigns
           (name, template_name, language_code, template_components, status, scheduled_at, total, created_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)
         RETURNING *`,
        [name, template_name, language_code, template_components, scheduled_at, recipients.length, created_by]
      );
      const camp = cRows[0];

      // insere recipients em lote
      const chunkSize = 1000;
      for (let i = 0; i < recipients.length; i += chunkSize) {
        const chunk = recipients.slice(i, i + chunkSize);
        const values = [];
        const params = [];
        chunk.forEach((r, idx) => {
          const p = i + idx;
          params.push(
            camp.id,
            r.phone,
            r.vars ?? null,
            r.header_vars ?? null,
            r.button_params ?? null
          );
          values.push(`($${params.length - 4}, $${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
        });

        await req.db.query(
          `INSERT INTO bulk_recipients
              (campaign_id, phone, vars, header_vars, button_params)
           VALUES ${values.join(',')}`,
          params
        );
      }

      // autostart opcional
      if (autostart) {
        await req.db.query(
          `UPDATE bulk_campaigns
              SET status='running', started_at=NOW(), updated_at=NOW()
            WHERE id=$1`,
          [camp.id]
        );

        const { ch, conn } = await ensurePublisher();
        const tenant = req?.tenant?.schema || req?.tenant?.subdomain || 'public'; // o que você já tiver no request
        ch.sendToQueue(BULK_ORCH_Q, Buffer.from(JSON.stringify({ tenant, campaignId: camp.id })), { persistent: true });
        await ch.close(); await conn.close();
      }

      return ok(reply, { campaign: { ...camp, status: autostart ? 'running' : camp.status } });
    } catch (error) {
      fastify.log.error('Erro ao criar campanha:', error);
      return fail(reply, 500, 'Erro interno ao criar campanha', error);
    }
  });

  // POST /bulk/:id/start
  fastify.post('/bulk/:id/start', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      const { rowCount } = await req.db.query(
        `UPDATE bulk_campaigns
            SET status='running', started_at=COALESCE(started_at, NOW()), updated_at=NOW()
          WHERE id=$1 AND status IN ('draft','paused')`,
        [id]
      );
      if (!rowCount) return fail(reply, 409, 'Campanha não está em estado iniciável (draft/paused).');

      const { ch, conn } = await ensurePublisher();
      const tenant = req?.tenant?.schema || req?.tenant?.subdomain || 'public';
      ch.sendToQueue(BULK_ORCH_Q, Buffer.from(JSON.stringify({ tenant, campaignId: id })), { persistent: true });
      await ch.close(); await conn.close();

      return ok(reply, { id, status: 'running' });
    } catch (e) {
      return fail(reply, 500, 'Erro ao iniciar campanha', e);
    }
  });

  // POST /bulk/:id/pause
  fastify.post('/bulk/:id/pause', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      await req.db.query(
        `UPDATE bulk_campaigns
            SET status='paused', updated_at=NOW()
          WHERE id=$1 AND status='running'`,
        [id]
      );
      return ok(reply, { id, status: 'paused' });
    } catch (e) {
      return fail(reply, 500, 'Erro ao pausar campanha', e);
    }
  });

  // POST /bulk/:id/cancel (marca recipients pendentes como canceled e fecha campanha)
  fastify.post('/bulk/:id/cancel', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      await req.db.query(
        `UPDATE bulk_recipients
            SET status='canceled', updated_at=NOW()
          WHERE campaign_id=$1 AND status IN ('queued','enqueued')`,
        [id]
      );
      await req.db.query(
        `UPDATE bulk_campaigns
            SET status='stopped', completed_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND status IN ('draft','running','paused')`,
        [id]
      );
      return ok(reply, { id, status: 'stopped' });
    } catch (e) {
      return fail(reply, 500, 'Erro ao cancelar campanha', e);
    }
  });

  // GET /bulk (lista)
  fastify.get('/bulk', async (req, reply) => {
    const { status, q } = req.query || {};
    const where = [];
    const params = [];

    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`LOWER(name) LIKE LOWER($${params.length})`); }

    const sql = `
      SELECT *
        FROM bulk_campaigns
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC
       LIMIT 200
    `;
    const { rows } = await req.db.query(sql, params);
    return reply.send(rows);
  });

  // GET /bulk/:id (detalhe + stats resumidas)
  fastify.get('/bulk/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await req.db.query(`SELECT * FROM bulk_campaigns WHERE id=$1 LIMIT 1`, [id]);
    if (!rows[0]) return fail(reply, 404, 'Campanha não encontrada');

    const { rows: s } = await req.db.query(
      `SELECT
          COUNT(*) FILTER (WHERE status='queued')    AS queued,
          COUNT(*) FILTER (WHERE status='enqueued')  AS enqueued,
          COUNT(*) FILTER (WHERE status='sent')      AS sent,
          COUNT(*) FILTER (WHERE status='delivered') AS delivered,
          COUNT(*) FILTER (WHERE status='read')      AS read,
          COUNT(*) FILTER (WHERE status='failed')    AS failed,
          COUNT(*) FILTER (WHERE status='canceled')  AS canceled
        FROM bulk_recipients
       WHERE campaign_id=$1`, [id]
    );
    return reply.send({ ...rows[0], live_stats: s[0] });
  });

  // GET /bulk/:id/recipients?status=...&limit=...&offset=...
  fastify.get('/bulk/:id/recipients', async (req, reply) => {
    const id = Number(req.params.id);
    const { status, limit = 200, offset = 0 } = req.query || {};
    const params = [id];
    const where = [`campaign_id = $1`];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    params.push(limit, offset);

    const { rows } = await req.db.query(
      `SELECT * FROM bulk_recipients
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return reply.send(rows);
  });
}

export default bulkRoutes;
