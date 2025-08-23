// server/routes/templates.js
// (sem import de node-fetch; usa globalThis.fetch do Node 18+)

/**
 * Plugin Fastify (prefix-friendly).
 * Registre com: fastify.register(templatesRoutes, { prefix: '/api/v1/templates' })
 */
async function templatesRoutes(fastify, _opts) {
  const GV = process.env.GRAPH_VERSION || process.env.GRAPH_VER || 'v23.0';
  const GRAPH = `https://graph.facebook.com/${GV}`;
  const BUS_ID = process.env.YOUR_BUSINESS_ID;
  const WABA_ENV = process.env.WABA_ID; // opcional
  const TOKEN =
    process.env.WHATSAPP_TOKEN ||
    process.env.SYSTEM_USER_TOKEN ||
    process.env.SYSTEM_USER_ADMIN_TOKEN;

  const fail = (reply, code, msg, err) =>
    reply.code(code).send({
      error: msg,
      // inclui detalhes se vierem (útil para depurar chamadas à Graph),
      // mas não depende de NODE_ENV
      details: err ? String(err?.message || err) : undefined,
    });

  const graphHeaders = () => {
    if (!TOKEN) throw new Error('Token Meta ausente: defina WHATSAPP_TOKEN (ou SYSTEM_USER_TOKEN / SYSTEM_USER_ADMIN_TOKEN).');
    return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  };

  async function resolveWabaId() {
    if (WABA_ENV) return WABA_ENV;
    if (!BUS_ID) throw new Error('Env YOUR_BUSINESS_ID ausente para descobrir o WABA.');
    const r = await fetch(`${GRAPH}/${BUS_ID}/owned_whatsapp_business_accounts?limit=1`, { headers: graphHeaders() });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    const id = j?.data?.[0]?.id;
    if (!id) throw new Error('Nenhum WABA encontrado para o BUSINESS_ID informado.');
    return id;
  }

  // GET / -> lista com filtros opcionais ?status= & ?q=
  fastify.get('/', async (req, reply) => {
    try {
      const { status, q } = req.query || {};
      const params = [];
      const where = [];

      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(LOWER(name) LIKE LOWER($${params.length}) OR LOWER(body_text) LIKE LOWER($${params.length}))`);
      }

      const sql = `
        SELECT *
          FROM templates
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 500
      `;

      const { rows } = await req.db.query(sql, params);
      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao listar templates:', error);
      return fail(reply, 500, 'Erro interno ao listar templates', error);
    }
  });

  // POST / -> cria rascunho local
  fastify.post('/', async (req, reply) => {
    const {
      name, language_code = 'pt_BR', category = 'UTILITY',
      header_type = 'NONE', header_text = null,
      body_text, footer_text = null, buttons = null, example = null,
    } = req.body || {};

    if (!name || !body_text) {
      return reply.code(400).send({ error: 'Campos obrigatórios: name, body_text' });
    }

    try {
      const { rows } = await req.db.query(
        `INSERT INTO templates
           (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, example, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
         RETURNING *`,
        [name, language_code, category, header_type, header_text, body_text, footer_text, buttons, example]
      );
      return reply.code(201).send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao criar template:', error);
      return fail(reply, 500, 'Erro interno ao criar template', error);
    }
  });

  // DELETE /:id -> remove local
  fastify.delete('/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      await req.db.query('DELETE FROM templates WHERE id=$1', [id]);
      return reply.send({ ok: true });
    } catch (error) {
      fastify.log.error('Erro ao excluir template:', error);
      return fail(reply, 500, 'Erro interno ao excluir template', error);
    }
  });

  // POST /:id/submit -> submete direto à Graph (sem filas)
  fastify.post('/:id/submit', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rows } = await req.db.query('SELECT * FROM templates WHERE id=$1', [id]);
      const t = rows[0];
      if (!t) return reply.code(404).send({ error: 'Template não encontrado' });
      if (!['draft', 'rejected'].includes(t.status)) {
        return reply.code(409).send({ error: 'Apenas templates draft/rejected podem ser submetidos' });
      }

      // monta components para Graph
      const components = [];
      if (t.header_type && t.header_type !== 'NONE') {
        const header = { type: 'HEADER', format: t.header_type }; // TEXT | IMAGE | VIDEO | DOCUMENT
        if (t.header_type === 'TEXT' && t.header_text) header.text = t.header_text;
        components.push(header);
      }
      components.push({ type: 'BODY', text: t.body_text });
      if (t.footer_text) components.push({ type: 'FOOTER', text: t.footer_text });
      if (Array.isArray(t.buttons) && t.buttons.length) {
        components.push({ type: 'BUTTONS', buttons: t.buttons });
      }

      const WABA = await resolveWabaId();
      const res = await fetch(`${GRAPH}/${WABA}/message_templates`, {
        method: 'POST',
        headers: graphHeaders(),
        body: JSON.stringify({
          name: t.name,
          language: (t.language_code || 'pt_BR').replace('-', '_'),
          category: t.category || 'UTILITY',
          components,
          ...(t.example ? { example: t.example } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return fail(reply, 502, 'Falha ao submeter template na Graph API', data?.error || data);
      }

      await req.db.query(
        `UPDATE templates
            SET status='submitted',
                provider_id=$2,
                reject_reason=NULL,
                updated_at=NOW()
          WHERE id=$1`,
        [id, data?.id || null]
      );

      return reply.send({ ok: true, provider: data });
    } catch (error) {
      fastify.log.error('Erro no submit do template:', error);
      return fail(reply, 500, 'Erro interno ao submeter template', error);
    }
  });

  // POST /:id/sync -> sincroniza status com a Graph
  fastify.post('/:id/sync', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rows } = await req.db.query('SELECT * FROM templates WHERE id=$1', [id]);
      const t = rows[0];
      if (!t) return reply.code(404).send({ error: 'Template não encontrado' });

      let url;
      if (t.provider_id) {
        url = `${GRAPH}/${t.provider_id}?fields=name,language,category,status,rejected_reason`;
      } else {
        const WABA = await resolveWabaId();
        url = `${GRAPH}/${WABA}/message_templates?name=${encodeURIComponent(t.name)}&language=${encodeURIComponent(t.language_code)}`;
      }

      const res = await fetch(url, { headers: graphHeaders() });
      const data = await res.json();
      if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);

      const rawStatus = (data?.status || data?.data?.[0]?.status || '').toUpperCase();
      const rawReason = data?.rejected_reason || data?.data?.[0]?.rejected_reason || null;

      const map = { APPROVED: 'approved', REJECTED: 'rejected', IN_REVIEW: 'submitted', PENDING: 'submitted' };
      const status = map[rawStatus] || t.status;

      await req.db.query(
        `UPDATE templates
            SET status=$2,
                reject_reason=$3,
                updated_at=NOW()
          WHERE id=$1`,
        [id, status, rawReason]
      );

      return reply.send({ ok: true, status, provider: data });
    } catch (error) {
      fastify.log.error('Erro ao sincronizar template:', error);
      return fail(reply, 500, 'Erro interno ao sincronizar template', error);
    }
  });
}

export default templatesRoutes;
