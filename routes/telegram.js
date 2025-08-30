// routes/telegram.js
export default async function telegramRoutes(fastify) {
  const WEBHOOK_URL = process.env.WEBHOOK_BASE_URL; // ex.: https://hmg.ninechat.com.br
  if (!WEBHOOK_URL) fastify.log.warn('PUBLIC_BASE_URL não definido');

  fastify.post('/connect', async (req, reply) => {
    const { subdomain, botToken, secret } = req.body || {};
    if (!subdomain || !botToken || !secret) {
      return reply.code(400).send({ error: 'missing_subdomain_or_token_or_secret' });
    }
    if (!req.db) return reply.code(500).send({ error: 'db_not_available' });

    try {
      // 1) tenant
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });

      // 2) valida token (getMe)
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const me = await meRes.json();
      if (!me?.ok || !me?.result?.id) {
        return reply.code(400).send({ error: 'invalid_bot_token', details: me });
      }
      const botId = String(me.result.id);
      const username = me.result.username || null;

      // 3) configura webhook único (Telegram envia o header x-telegram-bot-api-secret-token)
      const swRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: WEBHOOK_URL,
          secret_token: secret,
          allowed_updates: ['message', 'callback_query']
        })
      });
      const sw = await swRes.json();
      if (!sw?.ok) {
        fastify.log.warn({ sw }, '[tg/connect] setWebhook falhou');
        // segue mesmo assim; o usuário pode tentar de novo
      }

      // 4) salva/atualiza conexão
      const AUTH_MODE = 'bot_token'; // use 'bot_token' se você adicionar ao enum
      const settings = {
        secret_token: secret,
        webhook_url: WEBHOOK_URL,
        bot_username: username,
        raw: { getMe: me?.result }
      };

      const upsertSql = `
        INSERT INTO public.tenant_channel_connections
          (tenant_id, subdomain, channel, provider, account_id, external_id, display_name, auth_mode, credentials_encrypted, settings, is_active)
        VALUES
          ($1::uuid, $2::text, 'telegram'::channel_type, 'telegram'::text,
           $3::text, $4::text, $5::text, $6::auth_mode, $7::bytea, $8::jsonb, true)
        ON CONFLICT (tenant_id, channel, external_id)
        DO UPDATE SET
          account_id            = EXCLUDED.account_id,
          display_name          = EXCLUDED.display_name,
          auth_mode             = EXCLUDED.auth_mode,
          credentials_encrypted = EXCLUDED.credentials_encrypted,
          settings              = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
          updated_at            = now()
        RETURNING id
      `;

      await req.db.query(upsertSql, [
        tenant.id,           // $1::uuid
        subdomain,           // $2::text
        botId,               // $3::text (account_id)
        botId,               // $4::text (external_id)
        username,            // $5::text (display_name)
        AUTH_MODE,           // $6::auth_mode
        null,                // $7::bytea (credentials_encrypted) – opcional encriptar token depois
        JSON.stringify(settings) // $8::jsonb
      ]);

      return reply.send({
        ok: true,
        bot_id: botId,
        username,
        webhook_url: WEBHOOK_URL
      });
    } catch (err) {
      fastify.log.error({ err }, '[tg/connect] failed');
      return reply.code(500).send({ error: 'tg_connect_failed', message: err?.message });
    }
  });

  fastify.get('/status', async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers['x-tenant-subdomain'] ||
      req?.query?.subdomain;

    if (!subdomain) {
      return reply.code(400).send({ ok: false, error: 'missing_subdomain' });
    }
    if (!req.db) {
      return reply.code(500).send({ ok: false, error: 'db_not_available' });
    }

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.send({ ok: true, connected: false });

      const q = `
        SELECT external_id AS bot_id,
               display_name AS username,
               is_active,
               settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'telegram'
           AND provider  = 'telegram'
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [tenant.id]);
      const row = rows[0];

      if (!row) {
        return reply.send({ ok: true, connected: false, bot_id: null, username: null, webhook_url: null });
      }

      const webhook_url = row?.settings?.webhook_url || null;

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        bot_id: row.bot_id || null,
        username: row.username || null,
        webhook_url
      });
    } catch (err) {
      fastify.log.error({ err }, '[tg/status] failed');
      return reply.code(500).send({ ok: false, error: 'tg_status_failed' });
    }
  });
}
