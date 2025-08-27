// server/routes/templates.js
// Node 18+ (usa globalThis.fetch)
import { pool } from '../services/db.js'; // pool global (schema public)

async function templatesRoutes(fastify, _opts) {
  // ====== ENV globais ======
  const GV = process.env.GRAPH_VERSION || process.env.GRAPH_VER || 'v23.0';
  const GRAPH = `https://graph.facebook.com/${GV}`;
  const TOKEN =
    process.env.WHATSAPP_TOKEN ||
    process.env.SYSTEM_USER_TOKEN ||
    process.env.SYSTEM_USER_ADMIN_TOKEN;

  const fail = (reply, code, msg, err) =>
    reply.code(code).send({
      error: msg,
      details: err ? String(err?.message || err) : undefined,
    });

  const graphHeaders = () => {
    if (!TOKEN) throw new Error('Token Meta ausente: defina WHATSAPP_TOKEN (ou SYSTEM_USER_TOKEN / SYSTEM_USER_ADMIN_TOKEN).');
    return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  };

  // -------- helpers --------
  function extractSubdomain(req) {
    const fromTenant = req?.tenant?.subdomain;
    if (fromTenant) return String(fromTenant).toLowerCase();
    const host = String(req.headers?.host || '').toLowerCase();
    const parts = host.split(':')[0].split('.');
    if (parts.length >= 3) return parts[0];
    return null;
  }

  async function resolveWabaId(req) {
    const sub = extractSubdomain(req);
    if (!sub) throw new Error('Não foi possível resolver o subdomínio do tenant.');
    const { rows } = await pool.query(
      `SELECT whatsapp_external_id
         FROM public.tenants
        WHERE LOWER(subdomain) = LOWER($1)
        LIMIT 1`,
      [sub]
    );
    const waba = rows[0]?.whatsapp_external_id || null;
    if (!waba) throw new Error(`Tenant "${sub}" não possui whatsapp_external_id em public.tenants.`);
    return waba;
  }

  const toJsonOrNull = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

  const parseButtons = (raw) => {
    try {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') return JSON.parse(raw);
      if (typeof raw === 'object' && Array.isArray(raw.buttons)) return raw.buttons;
      return [];
    } catch {
      return [];
    }
  };

  // ===== Rotas locais (DB do tenant) =====

  // GET / -> lista local com filtros opcionais ?status= & ?q=
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
         ORDER BY name ASC
         LIMIT 500
      `;
      const { rows } = await req.db.query(sql, params);
      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao listar templates:', error);
      return fail(reply, 500, 'Erro interno ao listar templates', error);
    }
  });

  // POST / -> cria rascunho local (serializa JSONs)
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
      const buttonsJson = toJsonOrNull(buttons);
      const exampleJson = toJsonOrNull(example);

      const { rows } = await req.db.query(
        `INSERT INTO templates
           (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, example, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft', NOW(), NOW())
         RETURNING *`,
        [name, language_code, category, header_type, header_text, body_text, footer_text, buttonsJson, exampleJson]
      );
      return reply.code(201).send(rows[0]);
    } catch (error) {
      fastify.log.error({ err: error, body: req.body }, 'Erro ao criar template');
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

  // ===== Rotas que falam com a Graph =====

  // POST /:id/submit -> submete na Graph
  fastify.post('/:id/submit', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rows } = await req.db.query('SELECT * FROM templates WHERE id=$1', [id]);
      const t = rows[0];
      if (!t) return reply.code(404).send({ error: 'Template não encontrado' });
      if (!['draft', 'rejected'].includes(t.status)) {
        return reply.code(409).send({ error: 'Apenas templates draft/rejected podem ser submetidos' });
      }

      // monta components
      const components = [];
      if (t.header_type && t.header_type !== 'NONE') {
        const header = { type: 'HEADER', format: t.header_type }; // TEXT | IMAGE | VIDEO | DOCUMENT
        if (t.header_type === 'TEXT' && t.header_text) header.text = t.header_text;
        components.push(header);
      }
      components.push({ type: 'BODY', text: t.body_text });
      if (t.footer_text) components.push({ type: 'FOOTER', text: t.footer_text });

      const btns = parseButtons(t.buttons);
      if (btns.length) {
        components.push({ type: 'BUTTONS', buttons: btns });
      }

      const WABA = await resolveWabaId(req);
      const res = await fetch(`${GRAPH}/${WABA}/message_templates`, {
        method: 'POST',
        headers: graphHeaders(),
        body: JSON.stringify({
          name: t.name,
          language: (t.language_code || 'pt_BR').replace('-', '_'),
          category: t.category || 'UTILITY',
          components,
          ...(t.example ? { example: (typeof t.example === 'string' ? JSON.parse(t.example) : t.example) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) return fail(reply, 502, 'Falha ao submeter template na Graph API', data?.error || data);

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

  // POST /:id/sync -> sincroniza status e quality_score (se houver coluna)
  fastify.post('/:id/sync', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rows } = await req.db.query('SELECT * FROM templates WHERE id=$1', [id]);
      const t = rows[0];
      if (!t) return reply.code(404).send({ error: 'Template não encontrado' });

      const fields = 'name,language,category,status,rejected_reason,quality_score';
      let url;
      if (t.provider_id) {
        url = `${GRAPH}/${t.provider_id}?fields=${encodeURIComponent(fields)}`;
      } else {
        const WABA = await resolveWabaId(req);
        const lang = (t.language_code || 'pt_BR').replace('-', '_');
        url = `${GRAPH}/${WABA}/message_templates?name=${encodeURIComponent(t.name)}&language=${encodeURIComponent(lang)}&fields=${encodeURIComponent(fields)}&limit=1`;
      }

      const res = await fetch(url, { headers: graphHeaders() });
      const data = await res.json();
      if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);

      const rawStatus  = (data?.status || data?.data?.[0]?.status || '').toUpperCase();
      const rawReason  =  data?.rejected_reason || data?.data?.[0]?.rejected_reason || null;
      const rawQualityVal =  data?.quality_score   || data?.data?.[0]?.quality_score   || null;
      const rawQuality = rawQualityVal == null ? null : JSON.stringify(rawQualityVal);

      const map = { APPROVED: 'approved', REJECTED: 'rejected', IN_REVIEW: 'submitted', PENDING: 'submitted' };
      const status = map[rawStatus] || t.status;

      try {
        await req.db.query(
          `UPDATE templates
              SET status=$2, reject_reason=$3, quality_score=$4, updated_at=NOW()
            WHERE id=$1`,
          [id, status, rawReason, rawQuality]
        );
      } catch (e) {
        if (e?.code === '42703') {
          await req.db.query(
            `UPDATE templates
                SET status=$2, reject_reason=$3, updated_at=NOW()
              WHERE id=$1`,
            [id, status, rawReason]
          );
        } else {
          throw e;
        }
      }

      return reply.send({ ok: true, status, quality_score: rawQualityVal ?? null, provider: data });
    } catch (error) {
      fastify.log.error('Erro ao sincronizar template:', error);
      return fail(reply, 500, 'Erro interno ao sincronizar template', error);
    }
  });

  // GET /provider -> lista direto da Graph (inclui quality_score)
  fastify.get('/provider', async (req, reply) => {
    try {
      const { status, q, limit = 200 } = req.query || {};
      const WABA = await resolveWabaId(req);

      const fields = 'name,language,category,status,rejected_reason,quality_score,components';
      let url = `${GRAPH}/${WABA}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`;
      if (status) url += `&status=${encodeURIComponent(String(status).toUpperCase())}`;

      const out = [];
      while (url && out.length < Number(limit)) {
        const res = await fetch(url, { headers: graphHeaders() });
        const data = await res.json();
        if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);

        let page = Array.isArray(data?.data) ? data.data : [];
        const qnorm = (q || '').toLowerCase();
        if (qnorm) {
          page = page.filter(t =>
            (t?.name || '').toLowerCase().includes(qnorm) ||
            (t?.components || []).some(c => c?.type === 'BODY' && (c?.text || '').toLowerCase().includes(qnorm))
          );
        }

        out.push(...page);
        url = data?.paging?.next || null;
      }

      return reply.send(out.slice(0, Number(limit)));
    } catch (error) {
      fastify.log.error('Erro ao listar templates (provider):', error);
      return fail(reply, 500, 'Erro interno ao listar templates (provider)', error);
    }
  });

  // POST /sync-all -> importa/atualiza todos (serializa JSONs; sem ON CONFLICT duro)
  fastify.post('/sync-all', async (req, reply) => {
    try {
      const { upsert = true } = req.body || {};
      const WABA = await resolveWabaId(req);

      const fields = 'name,language,category,status,rejected_reason,quality_score,components';
      let url = `${GRAPH}/${WABA}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`;
      const collected = [];

      while (url) {
        const res = await fetch(url, { headers: graphHeaders() });
        const data = await res.json();
        if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);
        collected.push(...(Array.isArray(data?.data) ? data.data : []));
        url = data?.paging?.next || null;
      }

      if (!upsert) {
        return reply.send({ ok: true, imported: collected.length, upsert: false });
      }

      for (const t of collected) {
        const body    = (t.components || []).find(c => c.type === 'BODY');
        const header  = (t.components || []).find(c => c.type === 'HEADER');
        const footer  = (t.components || []).find(c => c.type === 'FOOTER');
        const buttons = (t.components || []).find(c => c.type === 'BUTTONS');

        const payload = {
          name: t.name,
          language_code: (t.language || 'pt_BR').replace('-', '_'),
          category: t.category || 'UTILITY',
          header_type: header?.format || (header ? 'TEXT' : 'NONE'),
          header_text: header?.text || null,
          body_text: body?.text || null,
          footer_text: footer?.text || null,
          buttons: buttons?.buttons || null,            // array JS
          status: (t.status || '').toLowerCase(),
          provider_id: t.id || null,
          reject_reason: t.rejected_reason || null,
          quality_score: t.quality_score ?? null,       // string ou objeto
        };

        const buttonsJson = toJsonOrNull(payload.buttons);
        const qscoreJson  = toJsonOrNull(payload.quality_score);

        // 1) UPDATE
        let r;
        try {
          r = await req.db.query(
            `
            UPDATE templates SET
              category=$3, header_type=$4, header_text=$5, body_text=$6,
              footer_text=$7, buttons=$8, status=$9, provider_id=$10,
              reject_reason=$11, quality_score=$12, updated_at=NOW()
            WHERE name=$1 AND language_code=$2
            `,
            [
              payload.name, payload.language_code,
              payload.category, payload.header_type, payload.header_text, payload.body_text,
              payload.footer_text, buttonsJson, payload.status, payload.provider_id,
              payload.reject_reason, qscoreJson
            ]
          );
        } catch (e) {
          if (e?.code === '42703') {
            r = await req.db.query(
              `
              UPDATE templates SET
                category=$3, header_type=$4, header_text=$5, body_text=$6,
                footer_text=$7, buttons=$8, status=$9, provider_id=$10,
                reject_reason=$11, updated_at=NOW()
              WHERE name=$1 AND language_code=$2
              `,
              [
                payload.name, payload.language_code,
                payload.category, payload.header_type, payload.header_text, payload.body_text,
                payload.footer_text, buttonsJson, payload.status, payload.provider_id,
                payload.reject_reason
              ]
            );
          } else {
            throw e;
          }
        }

        // 2) INSERT se não existia
        if (r.rowCount === 0) {
          try {
            await req.db.query(
              `
              INSERT INTO templates
                (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, status, provider_id, reject_reason, quality_score, created_at, updated_at)
              VALUES
                ($1,   $2,            $3,       $4,         $5,          $6,        $7,          $8,      $9,     $10,         $11,           $12,          NOW(),    NOW())
              `,
              [
                payload.name, payload.language_code, payload.category, payload.header_type,
                payload.header_text, payload.body_text, payload.footer_text, buttonsJson,
                payload.status, payload.provider_id, payload.reject_reason, qscoreJson
              ]
            );
          } catch (e) {
            if (e?.code === '42703') {
              await req.db.query(
                `
                INSERT INTO templates
                  (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, status, provider_id, reject_reason, created_at, updated_at)
                VALUES
                  ($1,   $2,            $3,       $4,         $5,          $6,        $7,          $8,      $9,     $10,         $11,          NOW(),    NOW())
                `,
                [
                  payload.name, payload.language_code, payload.category, payload.header_type,
                  payload.header_text, payload.body_text, payload.footer_text, buttonsJson,
                  payload.status, payload.provider_id, payload.reject_reason
                ]
              );
            } else {
              throw e;
            }
          }
        }
      }

      return reply.send({ ok: true, imported: collected.length });
    } catch (error) {
      fastify.log.error('Erro no sync-all:', error);
      return fail(reply, 500, 'Erro interno ao sincronizar todos os templates', error);
    }
  });
}

export default templatesRoutes;
