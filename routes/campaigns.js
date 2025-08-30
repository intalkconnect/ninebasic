// routes/campaigns.js
import { v4 as uuidv4 } from 'uuid';
import { parse as csvParser } from 'csv-parse';   // ✅ usamos csv-parse (stream), NÃO csv-parser
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enqueueCampaignFromDB } from '../services/campaign/dbToQueue.js';

const UPLOAD_DIR = process.env.CAMPAIGN_UPLOAD_DIR || path.join(os.tmpdir(), 'campaign_csv');

export default async function campaignsRoutes(fastify) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // POST /campaigns
  // multipart:
  //  - file: CSV (obrigatório) com coluna 'to' + variáveis
  //  - meta: JSON string { name, template:{name, language:{code}, components?}, start_at? }
  fastify.post('/', async (req, reply) => {
  // Vamos iterar todas as partes: pegamos o arquivo e os campos (meta ou planos)
  const parts = req.parts(); // @fastify/multipart
  let tempPath, tempName;
  let metaStr = null;

  // fallback de campos planos
  let flat = {
    name: null,
    template_name: null,
    language_code: null,
    components: null,
    start_at: null,
  };

  // 1) Varre multipart
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

  // 2) Monta o "meta" a partir de JSON ou dos campos planos
  let meta = {};
  if (metaStr) {
    try { meta = JSON.parse(metaStr); } catch { /* meta fica {} */ }
  } else {
    // campos planos → converte para o shape esperado
    if (flat.name) {
      meta.name = flat.name;
      if (flat.start_at) meta.start_at = flat.start_at;
      // components pode vir como JSON em texto
      let comps = null;
      if (flat.components) {
        try { comps = JSON.parse(flat.components); } catch { /* deixa null */ }
      }
      if (!flat.template_name || !flat.language_code) {
        return reply.code(400).send({ error: 'template_name e language_code são obrigatórios quando não usar meta' });
      }
      meta.template = {
        name: flat.template_name,
        language: { code: flat.language_code },
        ...(comps ? { components: comps } : {})
      };
    }
  }

  const { name, template, start_at } = meta || {};
  if (!name) return reply.code(400).send({ error: 'name é obrigatório' });
  if (!template?.name || !template?.language?.code) {
    return reply.code(400).send({ error: 'template{name, language.code} é obrigatório' });
  }

  const campaignId = uuidv4();

  // 3) Cria campanha (tenant-aware via req.db)
  const { rows } = await req.db.query(
    `INSERT INTO campaigns (id, name, template_name, language_code, components, start_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [campaignId, name, template.name, template.language.code, template.components || null,
     start_at ? new Date(start_at) : null, start_at ? 'scheduled' : 'started']
  );

  // 4) Parse CSV -> inserir em campaign_items (streaming)
  let inserted = 0, skipped = 0;
  await new Promise((resolve, reject) => {
    const rowsToInsert = [];
    fs.createReadStream(tempPath)
      .pipe(csvParser({
        delimiter: ',',
        bom: true,
        skip_empty_lines: true,
        columns: (header) => header.map(h => String(h).trim())
      }))
      .on('data', (row) => {
        const to = String(row.to || '').replace(/\D/g, '');
        if (!to) { skipped++; return; }
        const vars = { ...row }; delete vars.to;
        rowsToInsert.push({ to, vars });

        if (rowsToInsert.length >= 500) {
          const values = [];
          const params = [];
          let i = 1;
          for (const it of rowsToInsert) {
            values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
            params.push(uuidv4(), campaignId, it.to, JSON.stringify(it.vars));
          }
          rowsToInsert.length = 0;
          req.db.query(
            `INSERT INTO campaign_items (id, campaign_id, to_msisdn, variables) VALUES ${values.join(',')}`,
            params
          ).then(() => { inserted += params.length / 4; }).catch(reject);
        }
      })
      .on('end', async () => {
        try {
          if (rowsToInsert.length) {
            const values = [];
            const params = [];
            let i = 1;
            for (const it of rowsToInsert) {
              values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
              params.push(uuidv4(), campaignId, it.to, JSON.stringify(it.vars));
            }
            await req.db.query(
              `INSERT INTO campaign_items (id, campaign_id, to_msisdn, variables) VALUES ${values.join(',')}`,
              params
            );
            inserted += params.length / 4;
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      })
      .on('error', reject);
  });

  // 5) Exclui o CSV temporário
  try { fs.unlinkSync(tempPath); } catch {}

  // 6) Disparo imediato ou agendado
  if (!start_at) {
    const tenant = req.tenant?.subdomain || 'default';
    const res = await enqueueCampaignFromDB(campaignId, { tenant });
    await req.db.query(`UPDATE campaigns SET status='finished', updated_at=NOW() WHERE id=$1`, [campaignId]);
    return {
      ok: true,
      campaign: rows[0],
      inserted,
      skipped,
      launched: true,
      published: res.published,
      queue: `${tenant}.campaign`
    };
  }

  return { ok: true, campaign: rows[0], inserted, skipped, launched: false, message: 'Campanha agendada' };
});

}
