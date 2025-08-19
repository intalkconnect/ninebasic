// routes/atendentes.js
async function atendentesRoutes(fastify, _options) {
  // ------------ Rotas principais ------------
  
  // 🔄 Listar todos os atendentes
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT 
           id, name, lastname, email, status, filas, created_at, session_id
         FROM atendentes
         ORDER BY name, lastname`
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar atendentes' });
    }
  });

  // 🔍 Buscar atendente por email
  fastify.get('/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT 
           id, name, lastname, email, status, filas, created_at, session_id
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

  fastify.get('/status/:email', async (req, reply) => {
    const { email } = req.params;
    
    if (!email) {
      return reply.code(400).send({ error: 'Email é obrigatório' });
    }

    try {
      // Consulta otimizada para pegar apenas os campos relevantes
      const { rows } = await req.db.query(
        `SELECT 
           status, 
           session_id, 
           EXTRACT(EPOCH FROM (NOW() - created_at)) as seconds_since_creation,
           NOW() as server_time
         FROM atendentes
         WHERE email = $1`,
        [email]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Atendente não encontrado' });
      }

      const atendenteStatus = rows[0];
      
      // Estrutura de resposta completa
      const response = {
        email,
        status: atendenteStatus.status, // Valor exato do banco
        raw_status: atendenteStatus.status, // Cópia para confirmar que não foi alterado
        session_id: atendenteStatus.session_id,
        server_time: atendenteStatus.server_time,
        seconds_since_creation: atendenteStatus.seconds_since_creation,
        _debug: {
          query_executed_at: new Date().toISOString(),
          cache: 'disabled'
        }
      };

      // Headers para evitar cache
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');

      return reply.send(response);
    } catch (err) {
      fastify.log.error(`Erro ao buscar status para ${email}:`, err);
      return reply.code(500).send({ 
        error: 'Erro ao buscar status do atendente',
        details: err.message 
      });
    }
  });

  // 🔐 Abrir/atualizar sessão
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
  const closeSessionHandler = async (req, reply) => {
    const { session } = req.params || {};
    const reason =
      (req.query && (req.query.reason || req.query.motivo)) ||
      (req.body && (req.body.reason || req.body.motivo)) ||
      null;

    if (!session) {
      return reply.code(200).send({ success: true, affected: 0, note: 'no session provided' });
    }

    const nextStatus = reason === 'close' ? 'offline' : 'inativo';

    try {
      const { rowCount } = await req.db.query(
        `UPDATE atendentes
           SET session_id = NULL,
               status = $2
         WHERE session_id = $1`,
        [session, nextStatus]
      );

      return reply.code(200).send({ success: true, affected: rowCount || 0, status: nextStatus });
    } catch (err) {
      req.log.error(err, '[atendentes] erro ao encerrar sessão');
      return reply.code(500).send({ error: 'Erro ao encerrar sessão do atendente' });
    }
  };
  fastify.put('/status/:session', closeSessionHandler);
  fastify.post('/status/:session', closeSessionHandler);
  fastify.patch('/status/:session', closeSessionHandler);

  // ⏸️ Pausar atendimento
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

      return reply.send({ success: true, email, status: 'pausa', affected: rowCount || 0 });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao pausar atendente' });
    }
  });

  // ▶️ Retomar da pausa
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

      return reply.send({ success: true, email, status: 'online', affected: rowCount || 0 });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao retomar atendente' });
    }
  });

  // 🟢 Definir presença manual
  const presenceHandler = async (req, reply) => {
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

      return reply.send({ success: true, email, status, affected: rowCount || 0 });
    } catch (err) {
      fastify.log.error(err, '[atendentes] erro ao definir presença');
      return reply.code(500).send({ error: 'Erro ao definir presença' });
    }
  };
  fastify.put('/presence/:email', presenceHandler);
  fastify.post('/presence/:email', presenceHandler);

  // ❤️ Heartbeat
  const heartbeatHandler = async (req, reply) => {
    const { session, email } = req.body || {};

    if (!session && !email) {
      return reply.code(400).send({ error: "session ou email é obrigatório" });
    }

    try {
      let row = null;

      if (session) {
        const bySession = await req.db.query(
          `SELECT email, status, session_id
           FROM atendentes
           WHERE session_id = $1`,
          [session]
        );
        row = bySession.rows[0] || null;
      }

      if (!row && email) {
        const byEmail = await req.db.query(
          `SELECT email, status, session_id
           FROM atendentes
           WHERE email = $1`,
          [email]
        );
        row = byEmail.rows[0] || null;
      }

      if (!row) {
        return reply.send({ ok: false, reason: "not_found" });
      }

      return reply.send({
        ok: true,
        email: row.email,
        status: row.status,
        session_id: row.session_id
      });
    } catch (err) {
      req.log.error(err, "[atendentes] erro no heartbeat");
      return reply.code(500).send({ error: "Erro no heartbeat" });
    }
  };
  fastify.post("/heartbeat", heartbeatHandler);
  fastify.put("/heartbeat", heartbeatHandler);

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
