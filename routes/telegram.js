// routes/telegram.js
export default async function telegramRoutes(fastify) {
  const WEBHOOK_URL = process.env.WEBHOOK_BASE_URL; // ex.: https://hmg.ninechat.com.br
  if (!WEBHOOK_URL) fastify.log.warn("PUBLIC_BASE_URL não definido");

  // ---------------------------
  // POST /telegram/connect
  // Body:
  //  - subdomain (obrigatório)
  //  - botToken  (obrigatório se ainda não houver conexão no tenant)
  //  - secret    (obrigatório)
  //  - flow_id   (opcional) → se presente, já vincula ao flow em flow_channels
  // ---------------------------
  fastify.post("/connect", async (req, reply) => {
    const { subdomain, botToken, secret, flow_id } = req.body || {};

    const safeReqBody = { subdomain, hasFlow: !!flow_id };

    if (!subdomain || !secret) {
      const body400 = { error: "missing_subdomain_or_secret" };
      await fastify.audit?.(req, {
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
      await fastify.audit?.(req, {
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
        await fastify.audit?.(req, {
          action: "telegram.connect.tenant_not_found",
          resourceType: "channel",
          resourceId: subdomain,
          statusCode: 404,
          requestBody: safeReqBody,
          responseBody: body404,
        });
        return reply.code(404).send(body404);
      }

      // 2) verifica se já existe conexão ativa para este tenant
      const existingQ = `
        SELECT external_id AS bot_id, display_name AS username, is_active, settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'telegram'
           AND provider  = 'telegram'
         ORDER BY updated_at DESC
         LIMIT 1
      `;
      const existing = await req.db.query(existingQ, [tenant.id]);
      let botId   = existing.rows?.[0]?.bot_id || null;
      let username= existing.rows?.[0]?.username || null;

      // 3) se não houver conexão ainda, precisamos do token para criar
      if (!botId) {
        if (!botToken) {
          return reply.code(400).send({ error: "missing_bot_token" });
        }
        // valida token (getMe)
        const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const me = await meRes.json();
        if (!me?.ok || !me?.result?.id) {
          const body400 = { error: "invalid_bot_token", details: me };
          await fastify.audit?.(req, {
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
        botId    = String(me.result.id);
        username = me.result.username || null;

        // configura webhook
        const swRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: WEBHOOK_URL,
            secret_token: secret,
            allowed_updates: ["message", "callback_query"],
          }),
        });
        const sw = await swRes.json();
        if (!sw?.ok) {
          fastify.log.warn({ sw }, "[tg/connect] setWebhook falhou");
        }

        // upsert conexão do tenant
        const AUTH_MODE = "bot_token";
        const settings = {
          secret_token: "[SET]",
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
        await req.db.query(upsertSql, [
          tenant.id, subdomain, botId, botId, username, AUTH_MODE, null, JSON.stringify(settings),
        ]);
      }

      // 4) se foi enviado flow_id, vincula (ou reatribui) este bot ao flow
      if (flow_id) {
        const bindSql = `
          INSERT INTO flow_channels (flow_id, channel_key, channel_type, display_name, is_active)
          VALUES ($1, $2, 'telegram', $3, true)
          ON CONFLICT (channel_key)
          DO UPDATE SET
            flow_id      = EXCLUDED.flow_id,
            channel_type = 'telegram',
            display_name = COALESCE(EXCLUDED.display_name, flow_channels.display_name),
            is_active    = true,
            updated_at   = NOW()
          RETURNING id, flow_id, channel_key, channel_type, display_name, is_active
        `;
        await req.db.query(bindSql, [flow_id, botId, username || "Telegram"]);
      }

      const resp = { ok: true, bot_id: botId, username, webhook_url: WEBHOOK_URL, bound: !!flow_id };

      await fastify.audit?.(req, {
        action: existing.rows?.length ? "telegram.connect.update" : "telegram.connect.create",
        resourceType: "channel",
        resourceId: `telegram:${botId}`,
        statusCode: 200,
        requestBody: safeReqBody,
        responseBody: resp,
        extra: { tenantId: tenant.id, subdomain, hasFlow: !!flow_id },
      });

      return reply.send(resp);
    } catch (err) {
      fastify.log.error({ err }, "[tg/connect] failed");
      const body500 = { error: "tg_connect_failed", message: err?.message };

      await fastify.audit?.(req, {
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

  // ---------------------------
  // GET /telegram/status?subdomain=...&flow_id=...
  // - connected: status no tenant
  // - bound: se o bot atual está vinculado ao flow_id informado
  // ---------------------------
  fastify.get("/status", async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers["x-tenant-subdomain"] ||
      req?.query?.subdomain;

    const flowId = req?.query?.flow_id || null;

    if (!subdomain) return reply.code(400).send({ ok: false, error: "missing_subdomain" });
    if (!req.db)     return reply.code(500).send({ ok: false, error: "db_not_available" });

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.send({ ok: true, connected: false, bound: false });

      const q = `
        SELECT external_id AS bot_id,
               display_name AS username,
               is_active,
               settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'telegram'
           AND provider  = 'telegram'
         ORDER BY updated_at DESC
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [tenant.id]);
      const row = rows[0];

      if (!row) {
        return reply.send({
          ok: true,
          connected: false,
          bound: false,
          bot_id: null,
          username: null,
          webhook_url: null,
        });
      }

      const webhook_url = row?.settings?.webhook_url || null;

      // verifica vínculo com flow_id (se fornecido)
      let bound = false;
      if (flowId) {
        const bq = `
          SELECT 1
            FROM flow_channels
           WHERE flow_id = $1
             AND channel_type = 'telegram'
             AND channel_key  = $2
             AND is_active    = true
           LIMIT 1
        `;
        const bres = await req.db.query(bq, [flowId, row.bot_id]);
        bound = !!bres.rowCount;
      }

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        bound,
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
