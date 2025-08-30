// routes/campaigns.js
import { v4 as uuidv4 } from 'uuid';
import { parse as csvParser } from 'csv-parse';
import fs from 'fs';
import os from 'os';
import path from 'path';

const UPLOAD_DIR = process.env.CAMPAIGN_UPLOAD_DIR || path.join(os.tmpdir(), 'campaign_csv');

export default async function campaignsRoutes(fastify) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // POST /api/v1/campaigns  (prefix já vem do endpoints.js)
  // multipart:
  //  - file: CSV (obrigatório) com coluna 'to' + variáveis livres para template
  //  - você pode enviar META como:
  //    (A) campo "meta" (JSON) OU
  //    (B) campos planos: name, template_name, language_code, components(JSON), start_at(ISO)
  fastify.post('/', async (req, reply) => {
    // 1) Lê multipart (arquivo + campos)
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

    if (!tempPath) return reply.code(400).send({ error: 'CSV (campo file) é obrigatório' });

    // 2) Monta meta (prioriza JSON; cai para campos planos)
    let meta = {};
    if (metaStr) {
      try { meta = JSON.parse(metaStr); } catch {}
    } else if (flat.name) {
      let comps = null;
      if (flat.components) {
        try { comps = JSON.parse(flat.components); } catch {}
      }
      if (!flat.template_name || !flat.language_code) {
        return reply.code(400).send({ error: 'template_name e language_code são obrigatórios quando não usar meta' });
      }
      meta = {
        name: flat.name,
        start_at: flat.start_at || null,
        template: {
          name: flat.template_name,
          language: { code: flat.language_code },
          ...(comps ? { components: comps } : {})
        }
      };
    }

    const { name, template, start_at } = meta || {};
    if (!name) return reply.code(400).send({ error: 'name é obrigatório' });
    if (!template?.name || !template?.language?.code) {
      return reply.code(400).send({ error: 'template{name, language.code} é obrigatório' });
    }

    const campaignId = uuidv4();

    // 3) Define modo: imediata vs agendada (somente para persistir visível no BD)
    const now = new Date();
    const isScheduled = !!start_at && new Date(start_at) > now;
    const startAtVal = isScheduled ? new Date(start_at) : null;  // NULL para imediata
    const statusVal  = isScheduled ? 'scheduled' : 'queued';     // queued = imediata (scheduler dispara já)

    // 4) Cria campanha (tenant-aware via req.db)
    const { rows } = await req.db.query(
      `INSERT INTO campaigns (id, name, template_name, language_code, components, start_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [campaignId, name, template.name, template.language.code, template.components || null,
       startAtVal, statusVal]
    );

    // 5) Parse CSV -> inserir em campaign_items (streaming + flush em lote com await seguro)
    let inserted = 0, skipped = 0;
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
        `INSERT INTO campaign_items (id, campaign_id, to_msisdn, variables) VALUES ${values.join(',')}`,
        params
      );
      inserted += params.length / 4;
    };

    await new Promise((resolve, reject) => {
      fs.createReadStream(tempPath)
        .pipe(csvParser({
          delimiter: ',',
          bom: true,
          skip_empty_lines: true,
          columns: (header) => header.map(h => String(h).trim())
        }))
        .on('data', (row) => {
          try {
            const to = String(row.to || '').replace(/\D/g, '');
            if (!to) { skipped++; return; }
            const vars = { ...row }; delete vars.to;
            rowsToInsert.push({ to, vars });
            if (rowsToInsert.length >= 500) {
              // não await aqui; empilha promessa e segue o stream
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

    // 6) Exclui CSV temporário
    try { fs.unlinkSync(tempPath); } catch {}

    // 7) Retorna — quem dispara é o scheduler
    return {
      ok: true,
      campaign: rows[0],
      inserted,
      skipped,
      mode: isScheduled ? 'scheduled' : 'immediate',
      scheduled_for: startAtVal, // null para imediata
      message: isScheduled
        ? 'Campanha agendada (scheduler vai disparar no horário).'
        : 'Campanha marcada como imediata (scheduler vai disparar agora).'
    };
  });
}
