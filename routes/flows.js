// routes/flows.js
import dotenv from 'dotenv';
dotenv.config();

const FLOW_ENV = (process.env.FLOW_ENV || 'prod').toLowerCase(); // 'prod' | 'hmg'

export default async function flowsRoutes(fastify) {

  // ====== criar versão (draft) ======
  // POST /api/v1/flows/:flow_id/versions
  // body: { data, version?:number, status?:'draft'|'published', created_by?:string }
  fastify.post('/:flow_id/versions', async (req, reply) => {
    const { flow_id } = req.params;
    const { data, version, status = 'draft', created_by = null } = req.body || {};

    if (!data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'data é obrigatório (JSON)' });
    }

    try {
      // se version não veio, define próximo número
      let v = version;
      if (!v) {
        const { rows } = await req.db.query(
          `SELECT COALESCE(MAX(version),0)+1 AS next FROM flow_versions WHERE flow_id = $1`,
          [flow_id]
        );
        v = rows[0].next || 1;
      }

      const { rows: ins } = await req.db.query(
        `INSERT INTO flow_versions (flow_id, version, data, status, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         RETURNING id, flow_id, version, status`,
        [flow_id, v, data, status, created_by]
      );

      return reply.send({ ok: true, version: ins[0] });
    } catch (e) {
      req.log.error(e, 'erro ao criar versão');
      return reply.code(500).send({ error: 'erro ao criar versão', detail: e.message });
    }
  });

  // ====== publicar / alterar status de versão ======
  // PUT /api/v1/flows/:flow_id/versions/:version/status
  // body: { status: 'draft'|'published'|'deprecated' }
  fastify.put('/:flow_id/versions/:version/status', async (req, reply) => {
    const { flow_id, version } = req.params;
    const { status } = req.body || {};
    if (!['draft','published','deprecated'].includes(String(status))) {
      return reply.code(400).send({ error: 'status inválido' });
    }

    try {
      const { rows } = await req.db.query(
        `UPDATE flow_versions
            SET status = $3,
                published_at = CASE WHEN $3='published' THEN NOW() ELSE published_at END
          WHERE flow_id = $1 AND version = $2
          RETURNING id, flow_id, version, status, published_at`,
        [flow_id, Number(version), status]
      );
      if (!rows.length) return reply.code(404).send({ error: 'versão não encontrada' });
      return reply.send({ ok: true, version: rows[0] });
    } catch (e) {
      req.log.error(e, 'erro ao atualizar status');
      return reply.code(500).send({ error: 'erro ao atualizar status', detail: e.message });
    }
  });

  // ====== ativar deployment ======
  // POST /api/v1/flows/:flow_id/deploy
  // body: { version:number, channel:string, environment?:'prod'|'hmg', rollout_notes?:string }
  fastify.post('/:flow_id/deploy', async (req, reply) => {
    const { flow_id } = req.params;
    const { version, channel, environment = FLOW_ENV, rollout_notes = null } = req.body || {};
    if (!version || !channel) {
      return reply.code(400).send({ error: 'version e channel são obrigatórios' });
    }

    try {
      // resolve version_id
      const { rows: vRows } = await req.db.query(
        `SELECT id FROM flow_versions WHERE flow_id = $1 AND version = $2`,
        [flow_id, Number(version)]
      );
      if (!vRows.length) return reply.code(404).send({ error: 'versão não encontrada' });

      const version_id = vRows[0].id;

      // cria deployment ativo (a trigger garante 1 ativo por flow/channel/env)
      const { rows: dRows } = await req.db.query(
        `INSERT INTO flow_deployments
           (flow_id, version_id, channel, environment, is_active, activated_at, rollout_notes)
         VALUES ($1, $2, $3, $4, true, NOW(), $5)
         RETURNING id, flow_id, version_id, channel, environment, is_active, activated_at`,
        [flow_id, version_id, channel, environment, rollout_notes]
      );

      return reply.send({ ok: true, deployment: dRows[0] });
    } catch (e) {
      req.log.error(e, 'erro ao ativar deployment');
      return reply.code(500).send({ error: 'erro ao ativar deployment', detail: e.message });
    }
  });

  // ====== listar versões ======
  // GET /api/v1/flows/:flow_id/versions
  fastify.get('/:flow_id/versions', async (req, reply) => {
    const { flow_id } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, flow_id, version, status, created_at, published_at
           FROM flow_versions
          WHERE flow_id = $1
          ORDER BY version DESC`,
        [flow_id]
      );
      return reply.send(rows);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao listar versões', detail: e.message });
    }
  });

  // ====== listar deployments por canal/env ======
  // GET /api/v1/deployments?channel=whatsapp&environment=prod
  fastify.get('/deployments', async (req, reply) => {
    const { channel, environment = FLOW_ENV } = req.query || {};
    try {
      const { rows } = await req.db.query(
        `
        SELECT d.id, d.flow_id, d.version_id, d.channel, d.environment, d.is_active, d.activated_at,
               v.version, f.name
          FROM flow_deployments d
          JOIN flow_versions v ON v.id = d.version_id
          JOIN flows f ON f.id = d.flow_id
         WHERE ($1::text IS NULL OR d.channel = $1)
           AND d.environment = $2
         ORDER BY d.channel, d.activated_at DESC
        `,
        [channel || null, environment]
      );
      return reply.send(rows);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao listar deployments', detail: e.message });
    }
  });

  // ====== pegar dados do flow por version_id ======
  // GET /api/v1/flows/data-by-version/:version_id
  fastify.get('/data-by-version/:version_id', async (req, reply) => {
    const { version_id } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT data FROM flow_versions WHERE id = $1`,
        [version_id]
      );
      if (!rows.length) return reply.code(404).send({ error: 'versão não encontrada' });
      return reply.send(rows[0].data);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao buscar dados da versão', detail: e.message });
    }
  });

  // ====== compat: sessão do usuário (mantive, só qualifiquei schema) ======
  fastify.get('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    try {
      const { rows } = await req.db.query(
        "SELECT * FROM sessions WHERE user_id = $1 LIMIT 1",
        [user_id]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Sessão não encontrada' });
      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao buscar sessão', detail: error.message });
    }
  });

  fastify.post('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { current_block, flow_id, vars } = req.body || {};
    try {
      const beforeQ = await req.db.query(
        `SELECT user_id, current_block, last_flow_id, vars, updated_at
           FROM sessions
          WHERE user_id = $1
          LIMIT 1`,
        [user_id]
      );
      const beforeRow = beforeQ.rows?.[0] || null;

      const upsertQ = await req.db.query(
        `INSERT INTO sessions(user_id, current_block, last_flow_id, vars, updated_at)
         VALUES($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           current_block = EXCLUDED.current_block,
           last_flow_id  = EXCLUDED.last_flow_id,
           vars          = EXCLUDED.vars,
           updated_at    = NOW()
         RETURNING user_id, current_block, last_flow_id, vars, updated_at`,
        [user_id, current_block, flow_id, vars]
      );
      const afterRow = upsertQ.rows[0];

      await fastify.audit?.(req, {
        action: 'session.upsert',
        resourceType: 'session',
        resourceId: user_id,
        statusCode: 200,
        requestBody: { current_block: current_block ?? null, flow_id: flow_id ?? null, has_vars: !!vars },
        responseBody: { message: 'Sessão salva com sucesso.' },
        beforeData: beforeRow,
        afterData: afterRow
      });

      return reply.send({ message: 'Sessão salva com sucesso.' });
    } catch (error) {
      fastify.log.error(error, 'Erro ao salvar sessão');
      await fastify.audit?.(req, {
        action: 'session.upsert.error',
        resourceType: 'session',
        resourceId: user_id,
        statusCode: 500,
        requestBody: { current_block: current_block ?? null, flow_id: flow_id ?? null, has_vars: !!vars },
        responseBody: { error: 'Erro ao salvar sessão', detail: error.message }
      });
      return reply.code(500).send({ error: 'Erro ao salvar sessão', detail: error.message });
    }
  });
}
