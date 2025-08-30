// services/campaign/dbToQueue.js
import amqplib from 'amqplib';
import { dbPool } from '../db.js';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';

/**
 * Substitui placeholders {chave} nos components usando as variáveis da linha
 */
function hydrateComponents(components, vars) {
  if (!components) return undefined;
  try {
    const s = JSON.stringify(components);
    const out = s.replace(/\{(\w+)\}/g, (_, k) => (vars?.[k] ?? ''));
    return JSON.parse(out);
  } catch {
    return components;
  }
}

/**
 * Enfileira todos os itens de uma campanha lendo do DB e publicando na fila do tenant.
 * A fila SEMPRE é `${tenant}.campaign` (ex.: "hmg.campaign").
 *
 * @param {string} campaignId
 * @param {object} opts
 * @param {string} opts.tenant   // subdomínio do tenant (obrigatório), ex.: "hmg"
 * @returns {Promise<{published:number, queueName:string, tenant:string}>}
 */
export async function enqueueCampaignFromDB(campaignId, opts = {}) {
  const tenant = String(opts.tenant || '').trim().toLowerCase();
  if (!tenant) throw new Error('[enqueueCampaignFromDB] "tenant" é obrigatório');
  const queueName = `${tenant}.campaign`;

  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch = await conn.createChannel();
  await ch.assertQueue(queueName, { durable: true });

  const client = await dbPool.connect();
  let published = 0;

  try {
    // Cabeçalho da campanha
    const { rows: camps } = await client.query(
      `SELECT template_name, language_code, components
         FROM campaigns
        WHERE id=$1`,
      [campaignId]
    );
    if (!camps.length) throw new Error('Campanha não encontrada');
    const camp = camps[0];

    // Paginação para não estourar memória
    const pageSize = 500;
    let offset = 0;

    const { rows: cntRows } = await client.query(
      `SELECT COUNT(*)::int AS c
         FROM campaign_items
        WHERE campaign_id=$1`,
      [campaignId]
    );
    const total = cntRows[0].c;

    while (offset < total) {
      const { rows: items } = await client.query(
        `SELECT to_msisdn, variables
           FROM campaign_items
          WHERE campaign_id=$1
          ORDER BY created_at ASC
          LIMIT $2 OFFSET $3`,
        [campaignId, pageSize, offset]
      );
      offset += items.length;

      for (const it of items) {
        const msg = {
          channel: 'whatsapp',
          to: it.to_msisdn,
          type: 'template',
          template: {
            name: camp.template_name,
            language: { code: camp.language_code },
            ...(camp.components ? { components: hydrateComponents(camp.components, it.variables) } : {})
          }
        };

        ch.sendToQueue(
          queueName,
          Buffer.from(JSON.stringify(msg)),
          { persistent: true, headers: { 'x-attempts': 0 } }
        );
        published++;
      }
    }
  } finally {
    client.release();
    await ch.close();
    await conn.close();
  }

  return { published, queueName, tenant };
}
