// services/campaign/dbToQueue.js (API)
import amqplib from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbit:5672/';

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
 * Enfileira itens de campanha lendo com o DB do TENANT (req.db) e publicando na fila do TENANT.
 * @param {object} db       // req.db (tenant-scoped)
 * @param {string} campaignId
 * @param {{ tenant?: string, queueName?: string }} opts
 */
export async function enqueueCampaignFromDB(db, campaignId, opts = {}) {
  // 🔒 robusto: aceita da rota OU pega de env (TENANT/PG_SCHEMA) OU 'default'
  const envTenant = process.env.TENANT || process.env.PG_SCHEMA || '';
  const tenant = String((opts.tenant ?? envTenant) || 'default').trim().toLowerCase();
  const queueName = opts.queueName || `${tenant}.campaign`;

  // Rabbit
  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch = await conn.createChannel();
  await ch.assertQueue(queueName, { durable: true });

  let published = 0;
  try {
    // Cabeçalho da campanha (LENDO NO SCHEMA DO TENANT via req.db)
    const { rows: camps } = await db.query(
      `SELECT template_name, language_code, components
         FROM campaigns
        WHERE id=$1`,
      [campaignId]
    );
    if (!camps.length) throw new Error('Campanha não encontrada');
    const camp = camps[0];

    // paginação
    const pageSize = 500;
    let offset = 0;

    const { rows: cntRows } = await db.query(
      `SELECT COUNT(*)::int AS c
         FROM campaign_items
        WHERE campaign_id=$1`,
      [campaignId]
    );
    const total = cntRows[0].c;

    while (offset < total) {
      const { rows: items } = await db.query(
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
    await ch.close();
    await conn.close();
  }

  return { published, queueName, tenant };
}
