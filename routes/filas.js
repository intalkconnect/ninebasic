// routes/filas.js
async function filaRoutes(fastify, options) {
  // Helpers --------------------------------------------------------------

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

  // ➕ Criar nova fila (ativa sempre TRUE; descricao/color opcionais)
  fastify.post('/', async (req, reply) => {
    const { nome, descricao = null, color = null } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return reply.code(400).send({ error: 'Nome da fila é obrigatório' });
    }

    // Ignora qualquer tentativa de setar "ativa" vindo do cliente
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
      // 23505 = unique_violation (caso exista unique em "nome")
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Já existe uma fila com esse nome.' });
      }
      return reply.code(500).send({ error: 'Erro ao criar fila' });
    }
  });

  // 👥 Atendentes online da fila
  fastify.get('/atendentes/:fila_nome', async (req, reply) => {
    const { fila_nome } = req.params;

    try {
      const { rows } = await req.db.query(
        `
        SELECT id, name, lastname, email, status
        FROM users
        WHERE $1 = ANY(filas)
          AND status = 'online'
        ORDER BY name, lastname;
        `,
        [fila_nome]
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
      // se quiser listar apenas ativas, troque pela linha comentada:
      // const { rows } = await req.db.query('SELECT * FROM filas WHERE ativa = TRUE ORDER BY nome');
      const { rows } = await req.db.query('SELECT * FROM filas ORDER BY nome');
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao listar filas' });
    }
  });

  // 🔄 Definir permissão de transferência
  fastify.post('/fila-permissoes', async (req, reply) => {
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
  fastify.get('/fila-permissoes/:email', async (req, reply) => {
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
}

export default filaRoutes;
