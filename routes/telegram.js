// routes/telegram.js
export default async function telegramRoutes(fastify) {
  const WEBHOOK_URL = process.env.WEBHOOK_BASE_URL; // ex.: https://hmg.ninechat.com.br
  if (!WEBHOOK_URL) fastify.log.warn("PUBLIC_BASE_URL não definido");

  fastify.post("/connect", async (req, reply) => {
    const { subdomain, botToken, secret } = req.body || {};

    // helper para requestBody seguro na auditoria
    const safeReqBody = { subdomain };

    if (!subdomain || !botToken || !secret) {
      const body400 = { error: "missing_subdomain_or_token_or_secret" };
      await fastify.audit(req, {
        action: "telegram.connect.invalid",
        resourceType: "channel",
        resourceId: subdomain || null,
        statusCode: 400,
        requestBody: safeReqBody,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    if (!req.db) {
      const body500 = { error: "db_not_available" };
      await fastify.audit(req, {
        action: "telegram.connect.error",
        resourceType: "channel",
        resourceId: subdomain,
        statusCode: 500,
        requestBody: safeReqBody,
        responseBody: body500,
      });
      return reply.code(500).send(body500);
    }

    try {
      // 1) tenant
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) {
        const body404 = { error: "tenant_not_found" };
        await fastify.audit(req, {
          action: "telegram.connect.tenant_not_found",
          resourceType: "channel",
          resourceId: subdomain,
          statusCode: 404,
          requestBody: safeReqBody,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // 2) valida token (getMe)
      const meRes = await fetch(
        `https://api.telegram.org/bot${botToken}/getMe`
      );
      const me = await meRes.json();
      if (!me?.ok || !me?.result?.id) {
        const body400 = { error: "invalid_bot_token", details: me };
        await fastify.audit(req, {
          action: "telegram.connect.invalid_token",
          resourceType: "channel",
          resourceId: subdomain,
          statusCode: 400,
          requestBody: safeReqBody,
          responseBody: body400,
          extra: { tenantId: tenant.id },
        });
        return reply.code(400).send(body400);
      }
      const botId = String(me.result.id);
      const username = me.result.username || null;

      // 3) configura webhook
      const swRes = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: WEBHOOK_URL,
            secret_token: secret,
            allowed_updates: ["message", "callback_query"],
          }),
        }
      );
      const sw = await swRes.json();
      if (!sw?.ok) {
        fastify.log.warn({ sw }, "[tg/connect] setWebhook falhou");
        // segue mesmo assim
      }

      // 3.1) captura "before" (se já existe conexão)
      const beforeRes = await req.db.query(
        `SELECT id, tenant_id, channel, provider, account_id, external_id,
              display_name, auth_mode, is_active, settings, updated_at
         FROM public.tenant_channel_connections
        WHERE tenant_id = $1 AND channel = 'telegram' AND external_id = $2
        LIMIT 1`,
        [tenant.id, botId]
      );
      const before = beforeRes.rows?.[0] || null;

      // 4) salva/atualiza conexão
      const AUTH_MODE = "bot_token";
      const settings = {
        secret_token: "[SET]", // evita ecoar o segredo na base de logs
        webhook_url: WEBHOOK_URL,
        bot_username: username,
        raw: { getMe: me?.result },
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
      RETURNING id, tenant_id, channel, provider, account_id, external_id,
                display_name, auth_mode, is_active, settings, updated_at
    `;

      const upsertRes = await req.db.query(upsertSql, [
        tenant.id, // $1::uuid
        subdomain, // $2::text
        botId, // $3::text (account_id)
        botId, // $4::text (external_id)
        username, // $5::text (display_name)
        AUTH_MODE, // $6::auth_mode
        null, // $7::bytea (credentials_encrypted) – pode encriptar depois
        JSON.stringify(settings), // $8::jsonb
      ]);

      const after = upsertRes.rows?.[0] || null;

      const resp = {
        ok: true,
        bot_id: botId,
        username,
        webhook_url: WEBHOOK_URL,
      };

      // auditoria de sucesso
      await fastify.audit(req, {
        action: before ? "telegram.connect.update" : "telegram.connect.create",
        resourceType: "channel",
        resourceId: `telegram:${botId}`,
        statusCode: 200,
        requestBody: safeReqBody,
        responseBody: resp,
        beforeData: before,
        afterData: after,
        extra: {
          tenantId: tenant.id,
          subdomain,
          setWebhookOk: !!sw?.ok,
        },
      });

      return reply.send(resp);
    } catch (err) {
      fastify.log.error({ err }, "[tg/connect] failed");
      const body500 = { error: "tg_connect_failed", message: err?.message };

      await fastify.audit(req, {
        action: "telegram.connect.error",
        resourceType: "channel",
        resourceId: subdomain || null,
        statusCode: 500,
        requestBody: safeReqBody,
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });

  fastify.get("/status", async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers["x-tenant-subdomain"] ||
      req?.query?.subdomain;

    if (!subdomain) {
      return reply.code(400).send({ ok: false, error: "missing_subdomain" });
    }
    if (!req.db) {
      return reply.code(500).send({ ok: false, error: "db_not_available" });
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
        return reply.send({
          ok: true,
          connected: false,
          bot_id: null,
          username: null,
          webhook_url: null,
        });
      }

      const webhook_url = row?.settings?.webhook_url || null;

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        bot_id: row.bot_id || null,
        username: row.username || null,
        webhook_url,
      });
    } catch (err) {
      fastify.log.error({ err }, "[tg/status] failed");
      return reply.code(500).send({ ok: false, error: "tg_status_failed" });
    }
  });
}
