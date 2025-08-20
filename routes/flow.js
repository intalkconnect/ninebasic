export default async function flowRoutes(fastify, opts) {
  fastify.post('/publish', async (req, reply) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return reply.code(400).send({ error: 'Fluxo inválido ou ausente.' });
  }

  try {
    const { rows } = await req.db.query(
      `
      WITH lock AS (
        -- serializa publicações por schema/tenant
        SELECT pg_advisory_xact_lock( hashtext(current_schema() || ':flows_publish') )
      ),
      ins AS (
        -- 1) cria NOVA versão como inativa (sem bater no índice)
        INSERT INTO flows (data, created_at, active)
        VALUES ($1, NOW(), false)
        RETURNING id
      ),
      deact AS (
        -- 2) desativa quem estiver ativo agora
        UPDATE flows
           SET active = false
         WHERE active = true
        RETURNING 1
      ),
      act AS (
        -- 3) ativa a recém inserida
        UPDATE flows
           SET active = true
         WHERE id = (SELECT id FROM ins)
        RETURNING id
      )
      SELECT id FROM act;
      `,
      [data]
    );

    const newActiveId = rows[0]?.id;
    if (!newActiveId) {
      return reply.code(500).send({ error: 'Falha ao ativar novo fluxo.' });
    }

    return reply.send({ message: 'Fluxo publicado e ativado com sucesso.', id: newActiveId });
  } catch (error) {
    req.log?.error(error, 'Erro ao publicar fluxo');
    if (error?.code === '23505') {
      // se ainda assim houver corrida, devolve 409 para o front lidar
      return reply.code(409).send({ error: 'Concorrência ao publicar. Tente novamente.' });
    }
    return reply.code(500).send({ error: 'Erro ao publicar fluxo', detail: error.message });
  }
});


  fastify.get('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    try {
      const { rows } = await req.db.query(
        'SELECT * FROM sessions WHERE user_id = $1 LIMIT 1',
        [user_id]
      );

      if (rows.length === 0) {
        reply.code(404).send({ error: 'Sessão não encontrada' });
      } else {
        reply.send(rows[0]);
      }
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'Erro ao buscar sessão', detail: error.message });
    }
  });

  fastify.post('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { current_block, flow_id, vars } = req.body;

    try {
      await req.db.query(
        `
        INSERT INTO sessions(user_id, current_block, last_flow_id, vars, updated_at)
        VALUES($1, $2, $3, $4, $5)
        ON CONFLICT (user_id)
        DO UPDATE SET
          current_block = EXCLUDED.current_block,
          last_flow_id = EXCLUDED.last_flow_id,
          vars = EXCLUDED.vars,
          updated_at = EXCLUDED.updated_at
        `,
        [user_id, current_block, flow_id, vars, new Date().toISOString()]
      );

      reply.send({ message: 'Sessão salva com sucesso.' });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'Erro ao salvar sessão', detail: error.message });
    }
  });

  fastify.post('/activate', async (req, reply) => {
  const { id } = req.body;
  if (!id) return reply.code(400).send({ error: 'id é obrigatório' });

  try {
    const { rows } = await req.db.query(
      `
      WITH lock AS (
        SELECT pg_advisory_xact_lock( hashtext(current_schema() || ':flows_publish') )
      ),
      deact AS (
        UPDATE flows SET active = false WHERE active = true
      ),
      act AS (
        UPDATE flows SET active = true WHERE id = $1
        RETURNING id
      )
      SELECT id FROM act;
      `,
      [id]
    );

    const activatedId = rows[0]?.id;
    if (!activatedId) {
      return reply.code(404).send({ error: 'Fluxo não encontrado para ativação' });
    }
    return reply.code(200).send({ success: true, id: activatedId });
  } catch (error) {
    req.log?.error(error, 'Erro ao ativar fluxo');
    if (error?.code === '23505') {
      return reply.code(409).send({ error: 'Concorrência ao ativar fluxo. Tente novamente.' });
    }
    return reply.code(500).send({ error: 'Erro ao ativar fluxo', detail: error.message });
  }
});


  fastify.get('/latest', async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
        SELECT id, active, created_at
          FROM flows
         WHERE active = true
      `);
      return reply.code(200).send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply
        .code(500)
        .send({ error: 'Falha ao buscar últimos fluxos', detail: error.message });
    }
  });

  fastify.get('/history', async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
        SELECT id, active, created_at
          FROM flows
         ORDER BY created_at DESC
         LIMIT 10
      `);
      return reply.code(200).send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply
        .code(500)
        .send({ error: 'Erro ao buscar histórico de versões', detail: error.message });
    }
  });

  fastify.get('/data/:id', async (req, reply) => {
    const { id } = req.params;

    try {
      const { rows } = await req.db.query(
        'SELECT data FROM flows WHERE id = $1',
        [id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Fluxo não encontrado' });
      }

      return reply.code(200).send(rows[0].data);
    } catch (error) {
      fastify.log.error(error);
      return reply
        .code(500)
        .send({ error: 'Erro ao buscar fluxo', detail: error.message });
    }
  });
}
