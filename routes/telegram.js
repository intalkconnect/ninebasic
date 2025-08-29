// routes/telegram.js
import crypto from 'node:crypto';

/**
 * Cifra opcional com AES-256-GCM.
 * Se ENCRYPTION_KEY_HEX (32 bytes em hex) não estiver definida,
 * armazena o token como Buffer puro (NÃO recomendado em produção).
 */
function encryptToBytea(plaintext) {
  const keyHex = process.env.ENCRYPTION_KEY_HEX || '';
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    return Buffer.from(plaintext, 'utf8'); // fallback sem cifra
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: v1|iv|tag|enc
  return Buffer.concat([Buffer.from('v1'), iv, tag, enc]);
}

async function telegramRoutes(fastify) {
  /**
   * POST /api/v1/tg/connect
   * Body: { subdomain, botToken, secret, allowed_updates? }
   * - Webhook ÚNICO: /webhook
   * - Identificação do tenant no webhook: x-telegram-bot-api-secret-token == secret
   */
  fastify.post('/connect', async (req, reply) => {
    const { subdomain, botToken, secret, allowed_updates } = req.body || {};

    if (!subdomain || !botToken || !secret) {
      return reply.code(400).send({ error: 'missing_params' });
    }
    if (!req.db) {
      return reply.code(500).send({ error: 'db_not_available' });
    }

    const { WEBHOOK_BASE_URL } = process.env;
    if (!WEBHOOK_BASE_URL) {
      return reply.code(500).send({ error: 'WEBHOOK_BASE_URL_missing' });
    }

    try {
      // 0) resolve tenant
      const tRes = await req.db.query(
        `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.code(404).send({ error: 'tenant_not_found', subdomain });

      // 1) valida token
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const me = await meRes.json();
      if (!me?.ok) {
        return reply.code(400).send({ error: 'invalid_bot_token', detail: me });
      }
      const botId = String(me.result.id);
      const username = me.result.username ? `@${me.result.username}` : null;
      const displayName = me.result.first_name || username || 'Telegram Bot';

      // 2) setWebhook para endpoint único
      const webhookUrl = `${WEBHOOK_BASE_URL.replace(/\/+$/,'')}/webhook`;
      const updates = Array.isArray(allowed_updates) && allowed_updates.length
        ? allowed_updates
        : ["message", "edited_message", "callback_query"];

      const sw = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret,   // Telegram enviará esse header no webhook único
          allowed_updates: updates
        })
      });
      const swJson = await sw.json();
      if (!swJson?.ok) {
        return reply.code(400).send({ error: 'setWebhook_failed', detail: swJson });
      }

      // 3) persistir conexão — external_id = secret (chave de lookup no webhook)
      const qUpsert = `
        INSERT INTO public.tenant_channel_connections
          (tenant_id, subdomain, channel, provider, account_id, external_id, display_name, auth_mode, credentials_encrypted, settings, is_active)
        VALUES
          ($1,        $2,        'telegram','telegram', $3,       $4,          $5,           'api_key', $6,
           jsonb_build_object('webhook_secret',$7,'allowed_updates',$8::jsonb,'bot_id',$9,'username',$10,'raw_me',$11),
           true)
        ON CONFLICT (tenant_id, channel, external_id)
        DO UPDATE SET
          account_id  = EXCLUDED.account_id,
          display_name= EXCLUDED.display_name,
          credentials_encrypted = EXCLUDED.credentials_encrypted,
          settings    = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
          is_active   = true,
          updated_at  = now()
      `;

      const enc = encryptToBytea(botToken);

      await req.db.query(qUpsert, [
        tenant.id,
        subdomain,
        botId,                // account_id
        secret,               // external_id  <-- usado no webhook para identificar o tenant
        displayName,
        enc,                  // credentials_encrypted
        secret,               // settings.webhook_secret
        JSON.stringify(updates),
        botId,
        username,
        JSON.stringify(me)    // settings.raw_me
      ]);

      return reply.send({
        ok: true,
        subdomain,
        tenant_id: tenant.id,
        bot_id: botId,
        username,
        webhook_url: webhookUrl,
        allowed_updates: updates
      });
    } catch (err) {
      fastify.log.error({ err }, '[tg/connect] failed');
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return reply.code(status).send({ error: 'telegram_connect_failed', message: err?.message || 'unexpected_error' });
    }
  });
}

export default telegramRoutes;
