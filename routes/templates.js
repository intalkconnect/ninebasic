// server/routes/templates.js
// Node 18+: usa globalThis.fetch
import { pool } from '../services/db.js'; // pool global (schema public)

async function templatesRoutes(fastify, _opts) {
  // ====== ENV globais ======
  const GV = process.env.GRAPH_VERSION || process.env.GRAPH_VER || 'v23.0';
  const GRAPH = `https://graph.facebook.com/${GV}`;
  const TOKEN =
    process.env.WHATSAPP_TOKEN ||
    process.env.SYSTEM_USER_TOKEN ||
    process.env.SYSTEM_USER_ADMIN_TOKEN;

  // ---------- helpers ----------
  const fail = (reply, code, msg, err) =>
    reply.code(code).send({
      error: msg,
      details: err ? String(err?.message || err) : undefined,
    });

  const graphHeaders = () => {
    if (!TOKEN)
      throw new Error(
        'Token Meta ausente: defina WHATSAPP_TOKEN (ou SYSTEM_USER_TOKEN / SYSTEM_USER_ADMIN_TOKEN).'
      );
    return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  };

  // subdomínio atual (req.tenant.subdomain OU Host)
  function extractSubdomain(req) {
    const fromTenant = req?.tenant?.subdomain;
    if (fromTenant) return String(fromTenant).toLowerCase();
    const host = String(req.headers?.host || '').toLowerCase();
    const parts = host.split(':')[0].split('.');
    if (parts.length >= 3) return parts[0];
    return null;
  }

  // resolve WABA no catálogo público
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

  // normalizadores para JSON (evita 500 por tipo inválido no Postgres)
  function toJsonOrNull(v, fieldName = 'json') {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v; // já é objeto/array
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        throw new Error(`Campo ${fieldName} possui JSON inválido`);
      }
    }
    return null;
  }

  function normalizeButtons(btns) {
    const parsed = toJsonOrNull(btns, 'buttons');
    if (!parsed) return null;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object' && Array.isArray(parsed.buttons)) return parsed.buttons;
    return null; // formato inesperado -> ignora para não quebrar
  }

  // ========================= Rotas locais (DB do tenant) =========================

  // GET / -> lista local com filtros opcionais ?status= & ?q=
  fastify.get('/', async (req, reply) => {
    try {
      const { status, q } = req.query || {};
      const params = [];
      const where = [];

      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(
          `(LOWER(name) LIKE LOWER($${params.length}) OR LOWER(body_text) LIKE LOWER($${params.length}))`
        );
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
      req.log.error(error, 'Erro ao listar templates');
      return fail(reply, 500, 'Erro interno ao listar templates', error);
    }
  });

  // POST / -> cria rascunho local (MANTENDO example)
  fastify.post('/', async (req, reply) => {
    const {
      name,
      language_code = 'pt_BR',
      category = 'UTILITY',
      header_type = 'NONE',
      header_text = null,
      body_text,
      footer_text = null,
      buttons = null,
      example = null, // mantido
    } = req.body || {};

    if (!name || !body_text) {
      return reply.code(400).send({ error: 'Campos obrigatórios: name, body_text' });
    }

    try {
      const lang = String(language_code || 'pt_BR').replace('-', '_');
      const btns = normalizeButtons(buttons);
      const sample = toJsonOrNull(example, 'example');

      // coerção: se header_type não for TEXT, não armazena header_text
      const headerType = (header_type || 'NONE').toUpperCase();
      const headerText = headerType === 'TEXT' ? header_text : null;

      const sql = `
        INSERT INTO templates
          (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, example, status)
        VALUES
          ($1,   $2,            $3,       $4,         $5,          $6,        $7,          $8,      $9,      'draft')
        RETURNING *
      `;
      const params = [
        name,
        lang,
        category,
        headerType,
        headerText,
        body_text,
        footer_text,
        btns,
        sample,
      ];

      const { rows } = await req.db.query(sql, params);
      return reply.code(201).send(rows[0]);
    } catch (error) {
      req.log.error({ err: error, body: req.body }, 'Erro ao criar template');
      return reply.code(500).send({
        error: 'Erro interno ao criar template',
        details: error.detail || error.message,
      });
    }
  });

  // DELETE /:id -> remove local
  fastify.delete('/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      await req.db.query('DELETE FROM templates WHERE id=$1', [id]);
      return reply.send({ ok: true });
    } catch (error) {
      req.log.error(error, 'Erro ao excluir template');
      return fail(reply, 500, 'Erro interno ao excluir template', error);
    }
  });

  // ========================= Rotas que falam com a Graph =========================

  // POST /:id/submit -> submete na Graph
  fastify.post('/:id/submit', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rows } = await req.db.query('SELECT * FROM templates WHERE id=$1', [id]);
      const t = rows[0];
      if (!t) return reply.code(404).send({ error: 'Template não encontrado' });
      if (!['draft', 'rejected'].includes(t.status)) {
        return reply
          .code(409)
          .send({ error: 'Apenas templates draft/rejected podem ser submetidos' });
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
      if (Array.isArray(t.buttons) && t.buttons.length) {
        components.push({ type: 'BUTTONS', buttons: t.buttons });
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
          ...(t.example ? { example: t.example } : {}), // usa example se existir
        }),
      });
      const data = await res.json();
      if (!res.ok)
        return fail(reply, 502, 'Falha ao submeter template na Graph API', data?.error || data);

      await req.db.query(
        `UPDATE templates
            SET status='submitted',
                provider_id=$2,
                reject_reason=NULL
          WHERE id=$1`,
        [id, data?.id || null]
      );

      return reply.send({ ok: true, provider: data });
    } catch (error) {
      req.log.error(error, 'Erro no submit do template');
      return fail(reply, 500, 'Erro interno ao submeter template', error);
    }
  });

  // POST /:id/sync -> sincroniza status e (se houver coluna) quality_score
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
        url = `${GRAPH}/${WABA}/message_templates?name=${encodeURIComponent(
          t.name
        )}&language=${encodeURIComponent(lang)}&fields=${encodeURIComponent(fields)}&limit=1`;
      }

      const res = await fetch(url, { headers: graphHeaders() });
      const data = await res.json();
      if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);

      const rawStatus = (data?.status || data?.data?.[0]?.status || '').toUpperCase();
      const rawReason = data?.rejected_reason || data?.data?.[0]?.rejected_reason || null;
      const rawQuality = data?.quality_score || data?.data?.[0]?.quality_score || null;

      const map = {
        APPROVED: 'approved',
        REJECTED: 'rejected',
        IN_REVIEW: 'submitted',
        PENDING: 'submitted',
      };
      const status = map[rawStatus] || t.status;

      // tenta atualizar com quality_score; se coluna não existir, refaz sem ela
      try {
        await req.db.query(
          `UPDATE templates
              SET status=$2, reject_reason=$3, quality_score=$4
            WHERE id=$1`,
          [id, status, rawReason, rawQuality]
        );
      } catch (e) {
        if (e?.code === '42703') {
          await req.db.query(
            `UPDATE templates
                SET status=$2, reject_reason=$3
              WHERE id=$1`,
            [id, status, rawReason]
          );
        } else {
          throw e;
        }
      }

      return reply.send({
        ok: true,
        status,
        quality_score: rawQuality ?? null,
        provider: data,
      });
    } catch (error) {
      req.log.error(error, 'Erro ao sincronizar template');
      return fail(reply, 500, 'Erro interno ao sincronizar template', error);
    }
  });

  // (opcional) GET /provider -> lista direto da Graph (útil pra ver hello_world sem importar)
  fastify.get('/provider', async (req, reply) => {
    try {
      const { status, q, limit = 200 } = req.query || {};
      const WABA = await resolveWabaId(req);

      const fields = 'name,language,category,status,rejected_reason,quality_score,components';
      let url = `${GRAPH}/${WABA}/message_templates?fields=${encodeURIComponent(
        fields
      )}&limit=100`;
      if (status) url += `&status=${encodeURIComponent(String(status).toUpperCase())}`;

      const out = [];
      while (url && out.length < Number(limit)) {
        const res = await fetch(url, { headers: graphHeaders() });
        const data = await res.json();
        if (!res.ok) return fail(reply, 502, 'Falha ao consultar Graph API', data?.error || data);

        let page = Array.isArray(data?.data) ? data.data : [];
        const qnorm = (q || '').toLowerCase();
        if (qnorm) {
          page = page.filter(
            (t) =>
              (t?.name || '').toLowerCase().includes(qnorm) ||
              (t?.components || []).some(
                (c) => c?.type === 'BODY' && (c?.text || '').toLowerCase().includes(qnorm)
              )
          );
        }

        out.push(...page);
        url = data?.paging?.next || null;
      }

      return reply.send(out.slice(0, Number(limit)));
    } catch (error) {
      req.log.error(error, 'Erro ao listar templates (provider)');
      return fail(reply, 500, 'Erro interno ao listar templates (provider)', error);
    }
  });

  // (opcional) POST /sync-all -> importa/atualiza todos para o banco local (sem ON CONFLICT)
  fastify.post('/sync-all', async (req, reply) => {
    try {
      const { upsert = true } = req.body || {};
      const WABA = await resolveWabaId(req);

      const fields = 'name,language,category,status,rejected_reason,quality_score,components';
      let url = `${GRAPH}/${WABA}/message_templates?fields=${encodeURIComponent(
        fields
      )}&limit=100`;
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
        const body = (t.components || []).find((c) => c.type === 'BODY');
        const header = (t.components || []).find((c) => c.type === 'HEADER');
        const footer = (t.components || []).find((c) => c.type === 'FOOTER');
        const buttons = (t.components || []).find((c) => c.type === 'BUTTONS');

        const payload = {
          name: t.name,
          language_code: (t.language || 'pt_BR').replace('-', '_'),
          category: t.category || 'UTILITY',
          header_type: header?.format || (header ? 'TEXT' : 'NONE'),
          header_text: header?.text || null,
          body_text: body?.text || null,
          footer_text: footer?.text || null,
          buttons: buttons?.buttons || null,
          status: (t.status || '').toLowerCase(),
          provider_id: t.id || null,
          reject_reason: t.rejected_reason || null,
          quality_score: t.quality_score || null,
        };

        // tenta UPDATE (com quality_score); se coluna não existir, tenta sem; se não existir, INSERT
        let r;
        try {
          r = await req.db.query(
            `
            UPDATE templates SET
              category=$3, header_type=$4, header_text=$5, body_text=$6,
              footer_text=$7, buttons=$8, status=$9, provider_id=$10,
              reject_reason=$11, quality_score=$12
            WHERE name=$1 AND language_code=$2
            `,
            [
              payload.name,
              payload.language_code,
              payload.category,
              payload.header_type,
              payload.header_text,
              payload.body_text,
              payload.footer_text,
              payload.buttons,
              payload.status,
              payload.provider_id,
              payload.reject_reason,
              payload.quality_score,
            ]
          );
        } catch (e) {
          if (e?.code === '42703') {
            r = await req.db.query(
              `
              UPDATE templates SET
                category=$3, header_type=$4, header_text=$5, body_text=$6,
                footer_text=$7, buttons=$8, status=$9, provider_id=$10,
                reject_reason=$11
              WHERE name=$1 AND language_code=$2
              `,
              [
                payload.name,
                payload.language_code,
                payload.category,
                payload.header_type,
                payload.header_text,
                payload.body_text,
                payload.footer_text,
                payload.buttons,
                payload.status,
                payload.provider_id,
                payload.reject_reason,
              ]
            );
          } else {
            throw e;
          }
        }

        if (r.rowCount === 0) {
          // INSERT
          try {
            await req.db.query(
              `
              INSERT INTO templates
                (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, status, provider_id, reject_reason, quality_score)
              VALUES
                ($1,   $2,            $3,       $4,         $5,          $6,        $7,          $8,      $9,     $10,         $11,           $12)
              `,
              [
                payload.name,
                payload.language_code,
                payload.category,
                payload.header_type,
                payload.header_text,
                payload.body_text,
                payload.footer_text,
                payload.buttons,
                payload.status,
                payload.provider_id,
                payload.reject_reason,
                payload.quality_score,
              ]
            );
          } catch (e) {
            if (e?.code === '42703') {
              await req.db.query(
                `
                INSERT INTO templates
                  (name, language_code, category, header_type, header_text, body_text, footer_text, buttons, status, provider_id, reject_reason)
                VALUES
                  ($1,   $2,            $3,       $4,         $5,          $6,        $7,          $8,      $9,     $10,         $11)
                `,
                [
                  payload.name,
                  payload.language_code,
                  payload.category,
                  payload.header_type,
                  payload.header_text,
                  payload.body_text,
                  payload.footer_text,
                  payload.buttons,
                  payload.status,
                  payload.provider_id,
                  payload.reject_reason,
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
      req.log.error(error, 'Erro no sync-all');
      return fail(reply, 500, 'Erro interno ao sincronizar todos os templates', error);
    }
  });
}

export default templatesRoutes;
