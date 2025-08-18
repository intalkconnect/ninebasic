// routes/atendentes.js
async function atendentesRoutes(fastify, _options) {
  // ------------ helpers ------------
  const deriveStatusCase = `
    CASE
      WHEN status = 'pausa' THEN 'pausa'
      WHEN status = 'inativo' THEN 'inativo'
      WHEN status = 'offline' THEN 'offline'
      WHEN status = 'online' THEN CASE WHEN session_id IS NOT NULL THEN 'online' ELSE 'offline' END
      ELSE CASE WHEN session_id IS NOT NULL THEN 'online' ELSE 'offline' END
    END
  `;

  // 🔄 Listar todos os atendentes (com derived_status)
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT 
           id, name, lastname, email, status, filas, created_at, session_id,
           ${deriveStatusCase} AS derived_status
         FROM atendentes
         ORDER BY name, lastname`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar atendentes' });
    }
  });

  // 🔍 Buscar atendente por email (com derived_status)
  fastify.get('/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT 
           id, name, lastname, email, status, filas, created_at, session_id,
           ${deriveStatusCase} AS derived_status
         FROM atendentes
         WHERE email = $1`,
        [email]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar atendente' });
    }
  });

  // ➕ Criar novo atendente
  fastify.post('/', async (req, reply) => {
    const { name, lastname, email, filas = [] } = req.body;

    if (!name || !lastname || !email) {
      return reply.code(400).send({ error: 'name, lastname e email são obrigatórios' });
    }

    try {
      const { rows } = await req.db.query(
        `INSERT INTO atendentes (name, lastname, email, filas)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, lastname, email, status, filas, created_at, session_id`,
        [name, lastname, email, filas]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar atendente' });
    }
  });

  // ✏️ Atualizar atendente (perfil)
  fastify.put('/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, lastname, email, filas } = req.body;

    if (!name || !lastname || !email || !Array.isArray(filas)) {
      return reply.code(400).send({ error: 'Campos inválidos' });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET name = $1, lastname = $2, email = $3, filas = $4
         WHERE id = $5`,
        [name, lastname, email, filas, id]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar atendente' });
    }
  });

  // 🔐 Abrir/atualizar sessão (não mexe no status manual)
  // PUT /api/v1/atendentes/session/:email  body: { session: "abc123" }
  fastify.put('/session/:email', async (req, reply) => {
    const { email } = req.params;
    const { session } = req.body;

    if (!email || !session) {
      return reply.code(400).send({ error: 'email e session são obrigatórios' });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET session_id = $2
         WHERE email = $1`,
        [email, session]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true, email, session });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar sessão do atendente' });
    }
  });

  // 📴 Encerrar sessão
  // Aceita PUT/POST/PATCH
  // Regra:
  // - default (sem reason ou reason != 'close'): status = 'inativo'
  // - reason = 'close' (logout/fechar explícito): status = 'offline'
  // Idempotente:
  // - se não enviar :session OU não existir sessão correspondente → 200 com affected:0
  const closeSessionHandler = async (req, reply) => {
    const { session } = req.params || {};
    // reason pode vir por query (?reason=reload|close) ou no body { reason: '...' }
    const reason =
      (req.query && (req.query.reason || req.query.motivo)) ||
      (req.body && (req.body.reason || req.body.motivo)) ||
      null;

    if (!session) {
      return reply.code(200).send({ success: true, affected: 0, note: 'no session provided' });
    }

    // decide novo status
    const nextStatus = reason === 'close' ? 'offline' : 'inativo';

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
           SET session_id = NULL,
               status = $2
         WHERE session_id = $1`,
        [session, nextStatus]
      );

      // Mesmo que não encontre, 200 (idempotente)
      return reply.code(200).send({ success: true, affected: rowCount || 0, status: nextStatus });
    } catch (err) {
      req.log.error(err, '[atendentes] erro ao encerrar sessão');
      return reply.code(500).send({ error: 'Erro ao encerrar sessão do atendente' });
    }
  };
  fastify.put('/status/:session', closeSessionHandler);
  fastify.post('/status/:session', closeSessionHandler);
  fastify.patch('/status/:session', closeSessionHandler);

  // ⏸️ Pausar atendimento (mantém sessão)
  fastify.put('/pause/:email', async (req, reply) => {
    const { email } = req.params;

    if (!email) return reply.code(400).send({ error: 'email é obrigatório' });

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET status = 'pausa'
         WHERE email = $1`,
        [email]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true, email, status: 'pausa' });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao pausar atendente' });
    }
  });

  // ▶️ Retomar da pausa (mantém sessão; volta a obedecer regra de presença)
  fastify.put('/resume/:email', async (req, reply) => {
    const { email } = req.params;

    if (!email) return reply.code(400).send({ error: 'email é obrigatório' });

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET status = 'online'
         WHERE email = $1`,
        [email]
      );

      if (rowCount === 0) {
        return reply.code(404).send({ error: 'Atendente não encontrado' });
      }

      return reply.send({ success: true, email, status: 'online' });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao retomar atendente' });
    }
  });

  // 🟢 Definir presença manual (online/offline/pausa/inativo)
  fastify.put('/presence/:email', async (req, reply) => {
    const { email } = req.params;
    const { status } = req.body || {};
    const allowed = ['online', 'offline', 'pausa', 'inativo'];

    if (!email || !allowed.includes(status)) {
      return reply.code(400).send({ error: `Informe status válido: ${allowed.join(', ')}` });
    }

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
         SET status = $2
         WHERE email = $1`,
        [email, status]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true, email, status });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao definir presença' });
    }
  });

  // ❤️ Heartbeat (não altera status; apenas confirma sessão)
  const heartbeatHandler = async (req, reply) => {
    const { session } = req.body || {};
    if (!session) return reply.code(400).send({ error: 'session é obrigatório' });

    try {
      const { rows } = await req.db.query(
        `SELECT email, status, session_id FROM atendentes WHERE session_id = $1`,
        [session]
      );

      if (!rows.length) return reply.code(404).send({ error: 'sessão não encontrada' });

      const a = rows[0];
      const derived =
        a.status === 'pausa' ? 'pausa'
        : a.status === 'inativo' ? 'inativo'
        : a.status === 'offline' ? 'offline'
        : (a.session_id ? 'online' : 'offline');

      return reply.send({ ok: true, email: a.email, status: a.status, derived_status: derived });
    } catch (err) {
      fastify.log.error(err, '[atendentes] erro no heartbeat');
      return reply.code(500).send({ error: 'Erro no heartbeat' });
    }
  };
  fastify.post('/heartbeat', heartbeatHandler);
  fastify.put('/heartbeat', heartbeatHandler);

  // 🗑️ Excluir atendente
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;

    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM atendentes WHERE id = $1`,
        [id]
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'Atendente não encontrado' });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao excluir atendente' });
    }
  });
}

export default atendentesRoutes;
