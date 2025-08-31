// routes/campaigns.js
import { v4 as uuidv4 } from 'uuid';
import { parse as csvParser } from 'csv-parse';
import fs from 'fs';
import os from 'os';
import path from 'path';

const UPLOAD_DIR =
  process.env.CAMPAIGN_UPLOAD_DIR || path.join(os.tmpdir(), 'campaign_csv');

export default async function campaignsRoutes(fastify) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // =============================================================================
  // GET /api/v1/campaigns
  // Filtros:
  //   - status: '', queued, scheduled, finished, failed
  //   - q: busca por nome (ILIKE)
  //   - limit/offset (opcional; default 100/0)
  // Retorna também agregados de campaign_items para progresso.
  // =============================================================================

fastify.get('/', async (req) => {
  const { status = '', q = '', limit = '100', offset = '0' } = req.query || {};
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  const allowed = new Set(['queued', 'scheduled', 'finished', 'failed']);
  const st = String(status || '');
  const statusFilter = allowed.has(st) ? st : null;

  const { rows } = await req.db.query(
    `
    WITH agg AS (
      SELECT
        campaign_id,
        COUNT(*)::int                                               AS total_items,
        COUNT(*) FILTER (WHERE COALESCE(delivery_status,'') <> '')::int
                                                                    AS processed_count,
        COUNT(*) FILTER (WHERE delivery_status = 'sent')::int       AS sent_count,
        COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int  AS delivered_count,
        COUNT(*) FILTER (WHERE delivery_status = 'read')::int       AS read_count,
        COUNT(*) FILTER (WHERE delivery_status = 'failed')::int     AS failed_count,
        MAX(updated_at)                                            AS items_updated_at
      FROM campaign_items
      GROUP BY campaign_id
    )
    SELECT
      c.id, c.name, c.template_name, c.language_code, c.status, c.start_at, c.updated_at,
      COALESCE(a.total_items, 0)       AS total_items,
      COALESCE(a.processed_count, 0)   AS processed_count,
      COALESCE(a.sent_count, 0)        AS sent_count,
      COALESCE(a.delivered_count, 0)   AS delivered_count,
      COALESCE(a.read_count, 0)        AS read_count,
      COALESCE(a.failed_count, 0)      AS failed_count,
      GREATEST(COALESCE(a.total_items,0) - COALESCE(a.processed_count,0), 0) AS remaining
    FROM campaigns c
    LEFT JOIN agg a ON a.campaign_id = c.id
    WHERE ($1::text IS NULL OR c.status = $1::text)
      AND ($2::text IS NULL OR c.name ILIKE '%'||$2::text||'%')
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
    LIMIT $3 OFFSET $4
    `,
    [statusFilter, q ? String(q) : null, lim, off]
  );

  return rows;
});


  // =============================================================================
  // GET /api/v1/campaigns/:id  → detalhes + agregados
  // =============================================================================
  fastify.get('/:id', async (req, reply) => {
    const { id } = req.params;

    const { rows } = await req.db.query(
      `
      WITH agg AS (
        SELECT
          campaign_id,
          COUNT(*)::int                                               AS total_items,
          COUNT(*) FILTER (WHERE COALESCE(delivery_status,'') <> '')::int
                                                                      AS processed_count,
          COUNT(*) FILTER (WHERE delivery_status = 'sent')::int       AS sent_count,
          COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int  AS delivered_count,
          COUNT(*) FILTER (WHERE delivery_status = 'read')::int       AS read_count,
          COUNT(*) FILTER (WHERE delivery_status = 'failed')::int     AS failed_count,
          MAX(updated_at)                                            AS items_updated_at
        FROM campaign_items
        WHERE campaign_id = $1
        GROUP BY campaign_id
      )
      SELECT
        c.*,
        COALESCE(a.total_items, 0)       AS total_items,
        COALESCE(a.processed_count, 0)   AS processed_count,
        COALESCE(a.sent_count, 0)        AS sent_count,
        COALESCE(a.delivered_count, 0)   AS delivered_count,
        COALESCE(a.read_count, 0)        AS read_count,
        COALESCE(a.failed_count, 0)      AS failed_count
      FROM campaigns c
      LEFT JOIN agg a ON a.campaign_id = c.id
      WHERE c.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) return reply.code(404).send({ error: 'Campaign not found' });
    return rows[0];
  });

  // =============================================================================
  // POST /api/v1/campaigns  (mantido do seu exemplo)
  // multipart:
  //  - file: CSV (obrigatório) com coluna 'to' + variáveis livres para template
  //  - META: (A) campo "meta" (JSON) OU (B) campos planos:
  //          name, template_name, language_code, components(JSON), start_at(ISO)
  // status inicial: 'queued' (imediata) ou 'scheduled' (agendada)
  // quem dispara o envio é o scheduler (DB) já existente
  // =============================================================================
  fastify.post('/', async (req, reply) => {
    const parts = req.parts(); // fornecido por @fastify/multipart
    let tempPath, tempName;
    let metaStr = null;
    const flat = {
      name: null,
      template_name: null,
      language_code: null,
      components: null,
      start_at: null,
    };

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        tempName = `${uuidv4()}.csv`;
        tempPath = path.join(UPLOAD_DIR, tempName);
        await new Promise((res, rej) => {
          const ws = fs.createWriteStream(tempPath);
          part.file.pipe(ws);
          ws.on('finish', res);
          ws.on('error', rej);
        });
      } else if (part.type === 'field') {
        if (part.fieldname === 'meta') {
          metaStr = String(part.value || '');
        } else if (Object.prototype.hasOwnProperty.call(flat, part.fieldname)) {
          flat[part.fieldname] = String(part.value || '');
        }
      }
    }

    if (!tempPath)
      return reply.code(400).send({ error: 'CSV (campo file) é obrigatório' });

    // Monta meta (prioriza JSON; se não, campos planos)
    let meta = {};
    if (metaStr) {
      try { meta = JSON.parse(metaStr); } catch {}
    } else if (flat.name) {
      let comps = null;
      if (flat.components) {
        try { comps = JSON.parse(flat.components); } catch {}
      }
      if (!flat.template_name || !flat.language_code) {
        return reply.code(400).send({
          error: 'template_name e language_code são obrigatórios quando não usar meta',
        });
      }
      meta = {
        name: flat.name,
        start_at: flat.start_at || null,
        template: {
          name: flat.template_name,
          language: { code: flat.language_code },
          ...(comps ? { components: comps } : {}),
        },
      };
    }

    const { name, template, start_at } = meta || {};
    if (!name) return reply.code(400).send({ error: 'name é obrigatório' });
    if (!template?.name || !template?.language?.code) {
      return reply
        .code(400)
        .send({ error: 'template{name, language.code} é obrigatório' });
    }

    const campaignId = uuidv4();

    const now = new Date();
    const isScheduled = !!start_at && new Date(start_at) > now;
    const startAtVal = isScheduled ? new Date(start_at) : null;
    const statusVal = isScheduled ? 'scheduled' : 'queued';

    const { rows } = await req.db.query(
      `INSERT INTO campaigns (id, name, template_name, language_code, components, start_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        campaignId,
        name,
        template.name,
        template.language.code,
        template.components || null,
        startAtVal,
        statusVal,
      ]
    );

    // CSV → campaign_items (streaming + flush em lotes)
    let inserted = 0,
      skipped = 0;
    const rowsToInsert = [];
    const flushes = [];

    const flushBatch = async () => {
      if (!rowsToInsert.length) return;
      const values = [];
      const params = [];
      let i = 1;
      for (const it of rowsToInsert) {
        values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
        params.push(uuidv4(), campaignId, it.to, JSON.stringify(it.vars));
      }
      rowsToInsert.length = 0;
      await req.db.query(
        `INSERT INTO campaign_items (id, campaign_id, to_msisdn, variables)
         VALUES ${values.join(',')}`,
        params
      );
      inserted += params.length / 4;
    };

    await new Promise((resolve, reject) => {
      fs.createReadStream(tempPath)
        .pipe(
          csvParser({
            delimiter: ',',
            bom: true,
            skip_empty_lines: true,
            columns: (header) => header.map((h) => String(h).trim()),
          })
        )
        .on('data', (row) => {
          try {
            const to = String(row.to || '').replace(/\D/g, '');
            if (!to) {
              skipped++;
              return;
            }
            const vars = { ...row };
            delete vars.to;
            rowsToInsert.push({ to, vars });
            if (rowsToInsert.length >= 500) {
              flushes.push(flushBatch());
            }
          } catch (e) {
            reject(e);
          }
        })
        .on('end', async () => {
          try {
            if (rowsToInsert.length) flushes.push(flushBatch());
            await Promise.all(flushes);
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .on('error', reject);
    });

    try {
      fs.unlinkSync(tempPath);
    } catch {}

    return {
      ok: true,
      campaign: rows[0],
      inserted,
      skipped,
      mode: isScheduled ? 'scheduled' : 'immediate',
      scheduled_for: startAtVal,
      message: isScheduled
        ? 'Campanha agendada (scheduler vai disparar no horário).'
        : 'Campanha marcada como imediata (scheduler vai disparar agora).',
    };
  });

  // -----------------------------------------------------------------------------
  // (Opcional) GET /api/v1/campaigns/:id/items?limit=100&offset=0
  // Para inspecionar itens; deixe comentado se não precisar agora.
  // -----------------------------------------------------------------------------
  // fastify.get('/:id/items', async (req) => {
  //   const { id } = req.params;
  //   const { limit = '100', offset = '0' } = req.query || {};
  //   const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  //   const off = Math.max(parseInt(offset, 10) || 0, 0);
  //   const { rows } = await req.db.query(
  //     `SELECT id, to_msisdn, message_id, delivery_status, last_status_at, delivered_at, read_at, updated_at
  //        FROM campaign_items
  //       WHERE campaign_id = $1
  //       ORDER BY updated_at DESC NULLS LAST, created_at DESC
  //       LIMIT $2 OFFSET $3`,
  //     [id, lim, off]
  //   );
  //   return rows;
  // });
}
