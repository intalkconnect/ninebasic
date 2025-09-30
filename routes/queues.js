// routes/filas.js
async function queuesRoutes(fastify, options) {
  // ---------------- Helpers ----------------
  function normalizeHexColor(input) {
    if (!input) return null;
    let c = String(input).trim();
    if (!c.startsWith('#')) c = `#${c}`;
    // #RGB -> #RRGGBB
    if (/^#([0-9a-fA-F]{3})$/.test(c)) {
      c = '#' + c.slice(1).split('').map((ch) => ch + ch).join('');
    }
    return /^#([0-9a-fA-F]{6})$/.test(c) ? c.toUpperCase() : null;
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
  }

  // Pastel/neutral random (mais “sóbrio”)
  function randomPastelHex() {
    const h = Math.floor(Math.random() * 360);     // 0-359
    const s = 50 + Math.floor(Math.random() * 16); // 50-65
    const l = 78 + Math.floor(Math.random() * 8);  // 78-85
    return hslToHex(h, s, l);
  }

  // ---------------- Rotas existentes ----------------

  // ➕ Criar fila
  fastify.post('/', async (req, reply) => {
    const { nome, descricao = null, color = null } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return reply.code(400).send({ error: 'Nome da fila é obrigatório' });
    }
    const finalColor = normalizeHexColor(color) || randomPastelHex();

    try {
      const { rows } = await req.db.query(
        `
        INSERT INTO filas (nome, descricao, ativa, color)
        VALUES ($1, $2, TRUE, $3)
        RETURNING *;
        `,
        [String(nome).trim(), descricao ?? null, finalColor]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err, 'Erro ao criar fila');
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Já existe uma fila com esse nome.' });
      }
      return reply.code(500).send({ error: 'Erro ao criar fila' });
    }
  });

  // 👥 Atendentes online da fila
  fastify.get('/agents/:queue_name', async (req, reply) => {
    const { queue_name } = req.params;

    try {
      const { rows } = await req.db.query(
        `
        SELECT id, name, lastname, email, status
        FROM users
        WHERE $1 = ANY(filas)
          AND status = 'online'
        ORDER BY name, lastname;
        `,
        [queue_name]
      );

      if (rows.length === 0) {
        return reply.send({
          message: 'Nenhum atendente online ou cadastrado para esta fila.',
          atendentes: []
        });
      }

      return reply.send({ atendentes: rows });
    } catch (err) {
      fastify.log.error(err, 'Erro ao buscar atendentes da fila');
      return reply.code(500).send({ error: 'Erro ao buscar atendentes' });
    }
  });

  // 📥 Listar filas
  fastify.get('/', async (req, reply) => {
    try {
      const { rows } = await req.db.query('SELECT * FROM filas ORDER BY nome');
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar filas' });
    }
  });

  // 🔄 Definir permissão de transferência
  fastify.post('/queues-permission', async (req, reply) => {
    const { usuario_email, fila_id, pode_transferir } = req.body || {};
    if (!usuario_email || !fila_id)
      return reply.code(400).send({ error: 'usuario_email e fila_id são obrigatórios' });

    try {
      const { rows } = await req.db.query(
        `
        INSERT INTO fila_permissoes (usuario_email, fila_id, pode_transferir)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_email, fila_id)
        DO UPDATE SET pode_transferir = EXCLUDED.pode_transferir
        RETURNING *;
        `,
        [usuario_email, fila_id, !!pode_transferir]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao definir permissão' });
    }
  });

  // 👀 Obter filas que o usuário pode transferir
  fastify.get('/queues-permission/:email', async (req, reply) => {
    const { email } = req.params;

    try {
      const { rows } = await req.db.query(
        `
        SELECT f.id, f.nome, p.pode_transferir
        FROM fila_permissoes p
        JOIN filas f ON p.fila_id = f.id
        WHERE p.usuario_email = $1 AND p.pode_transferir = TRUE
        ORDER BY f.nome;
        `,
        [email]
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar permissões' });
    }
  });

  // ---------------- Novas rotas p/ QueueForm ----------------

  // 👁️ GET /queues/:id  (aceita número ou nome)
  fastify.get('/:id', async (req, reply) => {
    const raw = String(req.params?.id || '').trim();
    if (!raw) return reply.code(400).send({ error: 'Parâmetro id é obrigatório' });

    // decide pelo tipo do parâmetro
    const isNumeric = /^[0-9]+$/.test(raw);
    const whereSql  = isNumeric ? 'id = $1' : 'nome = $1';
    const val       = isNumeric ? Number(raw) : raw;

    try {
      const { rows } = await req.db.query(
        `SELECT id, nome, descricao, ativa, color FROM filas WHERE ${whereSql} LIMIT 1`,
        [val]
      );
      const row = rows?.[0];
      if (!row) return reply.code(404).send({ error: 'Fila não encontrada' });
      // front aceita {data} ou o objeto direto — aqui devolvemos { data }
      return reply.send({ data: row });
    } catch (err) {
      fastify.log.error(err, 'GET /queues/:id');
      return reply.code(500).send({ error: 'Erro ao obter fila' });
    }
  });

  // ✏️ PUT /queues/:id  (update parcial; ignora ativa, normaliza color)
  fastify.put('/:id', async (req, reply) => {
    const raw = String(req.params?.id || '').trim();
    if (!raw) return reply.code(400).send({ error: 'Parâmetro id é obrigatório' });

    const isNumeric = /^[0-9]+$/.test(raw);
    const whereSql  = isNumeric ? 'id = $1' : 'nome = $1';
    const whereVal  = isNumeric ? Number(raw) : raw;

    const { nome, descricao, color } = req.body || {};

    // Monta SET dinâmico
    const sets = [];
    const vals = [];
    let i = 1;

    if (typeof nome !== 'undefined') {
      const v = String(nome || '').trim();
      if (!v) return reply.code(400).send({ error: 'Nome da fila não pode ser vazio' });
      sets.push(`nome = $${++i}`);
      vals.push(v);
    }
    if (typeof descricao !== 'undefined') {
      const v = String(descricao || '').trim();
      sets.push(`descricao = $${++i}`);
      vals.push(v || null);
    }
    if (typeof color !== 'undefined') {
      const norm = normalizeHexColor(color);
      // se vier vazio/invalid, zera; se válido, usa; se nem veio, mantém
      sets.push(`color = $${++i}`);
      vals.push(norm || null);
    }

    if (!sets.length) {
      return reply.code(400).send({ error: 'Nada para atualizar' });
    }

    try {
      // primeiro garante que existe
      const r0 = await req.db.query(
        `SELECT id FROM filas WHERE ${whereSql} LIMIT 1`,
        [whereVal]
      );
      const found = r0.rows?.[0]?.id;
      if (!found) return reply.code(404).send({ error: 'Fila não encontrada' });

      // aplica update
      const sql = `
        UPDATE filas
           SET ${sets.join(', ')}
         WHERE id = $1
         RETURNING id, nome, descricao, ativa, color
      `;
      const { rows } = await req.db.query(sql, [found, ...vals]);
      return reply.send({ data: rows[0] });
    } catch (err) {
      fastify.log.error(err, 'PUT /queues/:id');
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Já existe uma fila com esse nome.' });
      }
      return reply.code(500).send({ error: 'Erro ao atualizar fila' });
    }
  });
}

export default queuesRoutes;
