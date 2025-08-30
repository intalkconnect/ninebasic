
// services/campaign/dbToQueue.js
import amqplib from 'amqplib';
import { dbPool } from '../../engine/services/db.js';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const CAMPAIGN_QUEUE = process.env.CAMPAIGN_QUEUE || 'tenant.campaign';

/**
 * Lê campaign_items do DB e publica um job por item.
 * Substitui placeholders no components usando as variáveis da linha.
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

export async function enqueueCampaignFromDB(campaignId) {
  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch = await conn.createChannel();
  await ch.assertQueue(CAMPAIGN_QUEUE, { durable: true });

  const client = await dbPool.connect();
  let published = 0;

  try {
    const { rows: camps } = await client.query(
      `SELECT template_name, language_code, components
         FROM campaigns WHERE id=$1`, [campaignId]
    );
    if (!camps.length) throw new Error('Campanha não encontrada');
    const camp = camps[0];

    // Stream em páginas para não estourar memória
    const pageSize = 500;
    let offset = 0;
    // usa count para laço
    const { rows: cntRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM campaign_items WHERE campaign_id=$1`, [campaignId]
    );
    const total = cntRows[0].c;

    while (offset < total) {
      const { rows: items } = await client.query(
        `SELECT to_msisdn, variables FROM campaign_items
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
        ch.sendToQueue(CAMPAIGN_QUEUE, Buffer.from(JSON.stringify(msg)), {
          persistent: true,
          headers: { 'x-attempts': 0 }
        });
        published++;
      }
    }
  } finally {
    client.release();
    await ch.close();
    await conn.close();
  }

  return { published };
}
