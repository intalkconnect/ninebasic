// routes/telegram.js
import { request } from 'undici';

export default async function telegramRoutes(fastify) {
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: https://hmg.ninechat.com.br
  if (!PUBLIC_BASE_URL) fastify.log.warn('PUBLIC_BASE_URL não definido');

  fastify.post('/connect', async (req, reply) => {
    const { subdomain, botToken, secret } = req.body || {};
    if (!subdomain || !botToken || !secret) {
      return reply.code(400).send({ error: 'missing_subdomain_or_token_or_secret' });
    }
    if (!req.db) return reply.code(500).send({ error: 'db_not_available' });

    try {
      // 1) resolve tenant
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
      const tenantId = tenant.id;

      // 2) getMe pra validar token e obter id/username
      const meRes = await request(`https://api.telegram.org/bot${botToken}/getMe`, { method: 'GET' });
      const me = await meRes.body.json();
      if (!me?.ok || !me?.result?.id) {
        return reply.code(400).send({ error: 'invalid_bot_token', details: me });
      }
      const botId = String(me.result.id);
      const username = me.result.username || null;

      // 3) define webhook único (identificação por secret no header do Telegram)
      const WEBHOOK_URL = `${PUBLIC_BASE_URL}/webhooks/telegram`;
      const swRes = await request(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: WEBHOOK_URL,
          secret_token: secret,                // Telegram vai enviar no header
          allowed_updates: ['message','callback_query']
        })
      });
      const sw = await swRes.body.json();
      if (!sw?.ok) {
        fastify.log.warn({ sw }, '[tg/connect] setWebhook falhou');
        // não bloqueio a conexão; apenas aviso
      }

      // 4) prepara credencial (opcional: encriptar botToken)
      let credBuf = null;
      try {
        // Se você tiver util de criptografia:
        // const b64 = fastify.crypto.encrypt(JSON.stringify({ botToken }));
        // credBuf = Buffer.from(b64, 'base64');
        // Como fallback, não salva nada em bytea:
        credBuf = null;
      } catch (e) {
        fastify.log.warn(e, '[tg/connect] falha ao encriptar credencial; seguindo sem credentials_encrypted');
      }

      // 5) salva/atualiza conexão
      const AUTH_MODE = 'system_user'; // ou crie 'bot_token' no enum auth_mode
      const settings = {
        secret_token: secret,        // usado para mapear tenant no webhook único
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
        tenantId,
        subdomain,
        botId,                     // account_id → uso o id do bot
        botId,                     // external_id → id do bot também (chave de conflito por tenant+canal+external)
        username,                  // display_name
        AUTH_MODE,                 // auth_mode (enum existente)
        credBuf,                   // ::bytea (NULL ok)
        JSON.stringify(settings)   // ::jsonb
      ]);

      // (opcional) também pode gravar em tenants.telegram_external_id se quiser:
      // await req.db.query(`UPDATE public.tenants SET telegram_external_id = $1 WHERE id = $2`, [botId, tenantId]);

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
}
