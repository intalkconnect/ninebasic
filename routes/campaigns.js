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
    const mp = await req.file();
    if (!mp) return reply.code(400).send({ error: 'CSV (campo file) é obrigatório' });

    let meta = {};
    const fields = mp.fields || {};
    if (fields.meta?.value) {
      try { meta = JSON.parse(fields.meta.value); } catch {}
    }

    const { name, template, start_at } = meta || {};
    if (!name) return reply.code(400).send({ error: 'name é obrigatório' });
    if (!template?.name || !template?.language?.code) {
      return reply.code(400).send({ error: 'template{name, language.code} é obrigatório' });
    }

    // Salva temp para parse robusto (será excluído ao final)
    const tempName = `${uuidv4()}.csv`;
    const tempPath = path.join(UPLOAD_DIR, tempName);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tempPath);
      mp.file.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    const campaignId = uuidv4();

    // Cria campanha no DB (tenant-aware via req.db)
    const { rows } = await req.db.query(
      `INSERT INTO campaigns (id, name, template_name, language_code, components, start_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [campaignId, name, template.name, template.language.code, template.components || null,
       start_at ? new Date(start_at) : null, start_at ? 'scheduled' : 'started']
    );

    // Parse CSV -> inserir em campaign_items (streaming, usando csv-parse)
    let inserted = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      const rowsToInsert = [];

      fs.createReadStream(tempPath)
        .pipe(csvParser({
          delimiter: ',',
          bom: true,
          skip_empty_lines: true,
          // columns como função para normalizar os headers (trim)
          columns: (header) => header.map(h => String(h).trim())
        }))
        .on('data', (row) => {
          const to = String(row.to || '').replace(/\D/g, '');
          if (!to) { skipped++; return; }
          const vars = { ...row }; delete vars.to;
          rowsToInsert.push({ to, vars });

          if (rowsToInsert.length >= 500) {
            // flush em lote
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

    // Exclui o CSV temporário
    try { fs.unlinkSync(tempPath); } catch {}

    // Se start_at AUSENTE -> dispara AGORA a partir do DB e marca finished
    if (!start_at) {
      const tenant = req.tenant?.subdomain || 'default';     // ✅ pega o tenant da request
      const res = await enqueueCampaignFromDB(campaignId, { tenant }); // ✅ fila = `${tenant}.campaign`
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

    // Programada: quem dispara é o worker-campaign-scheduler (lendo do DB)
    return { ok: true, campaign: rows[0], inserted, skipped, launched: false, message: 'Campanha agendada' };
  });
}
