// routes/flows.js
import dotenv from 'dotenv';
dotenv.config();

/**
 * Rotas de Flow/Version/Deployment (prod only)
 * Observações importantes:
 * - A ordem das rotas importa! Rotas estáticas (ex.: /meta, /deployments, /data-by-version/:id)
 *   ficam ANTES das dinâmicas (/:flow_id e /:flow_id/*) para evitar colisões.
 * - Este módulo assume que será registrado com prefixo: /api/v1/flows
 *   Ex.: fastify.register(flowsRoutes, { prefix: '/api/v1/flows' })
 */
export default async function flowsRoutes(fastify) {
  /* =========================================================
   * FLOWS (metadados)
   * ========================================================= */

  // POST /api/v1/flows
  // body: { name: string, description?: string }
  fastify.post('/', async (req, reply) => {
    const { name, description = null } = req.body || {};
    if (!name || !String(name).trim()) {
      return reply.code(400).send({ error: 'name é obrigatório' });
    }
    try {
      const { rows } = await req.db.query(
        `INSERT INTO flows(name, description, created_at, updated_at)
         VALUES($1,$2,NOW(),NOW())
         RETURNING id, name, description, created_at, updated_at`,
        [String(name).trim(), description]
      );
      return reply.send(rows[0]);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao criar flow', detail: e.message });
    }
  });

  // GET /api/v1/flows
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, description, created_at, updated_at
           FROM flows
          WHERE name IS NOT NULL
          ORDER BY created_at DESC`
      );
      return reply.send(rows);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao listar flows', detail: e.message });
    }
  });

  /* =========================================================
   * VIEWS AUXILIARES / METADADOS (COLOCAR ANTES DE /:flow_id)
   * ========================================================= */

  // GET /api/v1/flows/meta -> lista flows com últimas versões e deploys ativos
  fastify.get('/meta', async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
        WITH last_versions AS (
          SELECT flow_id,
                 MAX(version) FILTER (WHERE status='published') AS last_published,
                 MAX(version) AS last_version
          FROM flow_versions
          GROUP BY flow_id
        ),
        active_deploys AS (
          SELECT d.flow_id,
                 json_agg(json_build_object(
                   'id', d.id,
                   'channel', d.channel,
                   'version', v.version,
                   'activated_at', d.activated_at
                 ) ORDER BY d.activated_at DESC) AS deploys
          FROM flow_deployments d
          JOIN flow_versions v ON v.id = d.version_id
          WHERE d.is_active = true
          GROUP BY d.flow_id
        )
        SELECT f.id, f.name, f.description,
               lv.last_published, lv.last_version,
               COALESCE(ad.deploys, '[]'::json) AS active_deploys
        FROM flows f
        LEFT JOIN last_versions lv ON lv.flow_id = f.id
        LEFT JOIN active_deploys ad ON ad.flow_id = f.id
        ORDER BY f.created_at DESC
      `);
      return reply.send(rows);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error:'erro ao listar flows/meta', detail:e.message });
    }
  });

  // GET /api/v1/flows/deployments?flow_id=&channel=
  fastify.get('/deployments', async (req, reply) => {
    const { flow_id, channel } = req.query || {};
    try {
      const { rows } = await req.db.query(
        `
        SELECT d.id, d.flow_id, d.version_id, d.channel, d.is_active, d.activated_at,
               v.version, f.name
          FROM flow_deployments d
          JOIN flow_versions v ON v.id = d.version_id
          JOIN flows f ON f.id = d.flow_id
         WHERE ($1::uuid IS NULL OR d.flow_id = $1)
           AND ($2::text IS NULL OR d.channel = $2)
         ORDER BY d.activated_at DESC
        `,
        [flow_id || null, channel || null]
      );
      return reply.send(rows);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'erro ao listar deployments', detail: e.message });
    }
  });

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

  /* =========================================================
   * ROTAS DINÂMICAS POR FLOW_ID
   * ========================================================= */

  // GET /api/v1/flows/:flow_id
  fastify.get('/:flow_id', async (req, reply) => {
    const { flow_id } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT id, name, description, created_at, updated_at
           FROM flows
          WHERE id = $1`,
        [flow_id]
      );
      if (!rows.length) return reply.code(404).send({ error: 'flow não encontrado' });
      return reply.send(rows[0]);
    } catch (e) {
      req.log.error(e, 'erro ao buscar flow');
      return reply.code(500).send({ error: 'erro ao buscar flow', detail: e.message });
    }
  });

  /* -------------------------
   * VERSIONS
   * ------------------------- */

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

  // POST /api/v1/flows/:flow_id/versions
  // body: { data: JSON, version?: number, status?: 'draft'|'published', created_by?: string }
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
         RETURNING id, flow_id, version, status, created_at, published_at`,
        [flow_id, v, data, status, created_by]
      );

      return reply.send({ ok: true, version: ins[0] });
    } catch (e) {
      req.log.error(e, 'erro ao criar versão');
      return reply.code(500).send({ error: 'erro ao criar versão', detail: e.message });
    }
  });

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

  /* -------------------------
   * DEPLOYMENTS (prod only)
   * ------------------------- */

  // GET /api/v1/flows/:flow_id/active-deployment?channel=whatsapp
  fastify.get('/:flow_id/active-deployment', async (req, reply) => {
    const { flow_id } = req.params;
    const { channel } = req.query || {};
    try {
      const { rows } = await req.db.query(
        `SELECT d.id, d.flow_id, d.version_id, d.channel, d.is_active, d.activated_at,
                v.version
           FROM flow_deployments d
           JOIN flow_versions v ON v.id = d.version_id
          WHERE d.flow_id = $1
            AND ($2::text IS NULL OR d.channel = $2)
            AND d.is_active = true
          ORDER BY d.activated_at DESC
          LIMIT 1`,
        [flow_id, channel || null]
      );
      if (!rows.length) return reply.send(null);
      return reply.send(rows[0]);
    } catch (e) {
      req.log.error(e, 'erro ao buscar active deployment');
      return reply.code(500).send({ error: 'erro ao buscar active deployment', detail: e.message });
    }
  });

  // POST /api/v1/flows/:flow_id/deploy
  // body: { version:number, channel:string, rollout_notes?:string }
  fastify.post('/:flow_id/deploy', async (req, reply) => {
    const { flow_id } = req.params;
    const { version, channel, rollout_notes = null } = req.body || {};
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

      // desativa o ativo anterior (1 ativo por flow/channel)
      await req.db.query(
        `UPDATE flow_deployments
            SET is_active = false
          WHERE flow_id = $1 AND channel = $2 AND is_active = true`,
        [flow_id, channel]
      );

      const { rows: dRows } = await req.db.query(
        `INSERT INTO flow_deployments
           (flow_id, version_id, channel, is_active, activated_at, rollout_notes)
         VALUES ($1, $2, $3, true, NOW(), $4)
         RETURNING id, flow_id, version_id, channel, is_active, activated_at`,
        [flow_id, version_id, channel, rollout_notes]
      );
      return reply.send({ ok: true, deployment: dRows[0] });
    } catch (e) {
      req.log.error(e, 'erro ao ativar deployment');
      return reply.code(500).send({ error: 'erro ao ativar deployment', detail: e.message });
    }
  });

  /* =========================================================
   * SESSIONS (compat – mantido sob o mesmo prefixo)
   * ========================================================= */

  // GET /api/v1/flows/sessions/:user_id
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

  // POST /api/v1/flows/sessions/:user_id
  // body: { current_block, flow_id, vars }
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
