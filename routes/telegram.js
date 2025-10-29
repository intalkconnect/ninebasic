export default async function telegramRoutes(fastify) {
  const WEBHOOK_URL = process.env.WEBHOOK_BASE_URL;
  if (!WEBHOOK_URL) fastify.log.warn("PUBLIC_BASE_URL não definido");

  // POST /telegram/connect
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
    if (!botToken) return reply.code(400).send({ error: "missing_bot_token" });

    try {
      // tenant
      const tRes = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`, [subdomain]);
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

      // getMe do TOKEN informado (sempre nova conexão para ESTE bot)
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
      const botId = String(me.result.id);
      const username = me.result.username || null;

      // setWebhook para ESTE bot
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
      if (!sw?.ok) fastify.log.warn({ sw }, "[tg/connect] setWebhook falhou");

      // upsert conexão do tenant — POR external_id (permite vários bots; não reaproveita outro)
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
        RETURNING id
      `;
      await req.db.query(upsertSql, [
        tenant.id, subdomain, botId, botId, username, AUTH_MODE, null, JSON.stringify(settings),
      ]);

      // vincular ao flow (se enviado)
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
        `;
        await req.db.query(bindSql, [flow_id, botId, username || "Telegram"]);
      }

      const resp = { ok: true, bot_id: botId, username, webhook_url: WEBHOOK_URL, bound: !!flow_id };
      await fastify.audit?.(req, {
        action: "telegram.connect.upsert",
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

  // GET /telegram/status?subdomain=...&flow_id=...
  // AJUSTE: quando flow_id for fornecido, priorizamos o bot VINCULADO ao flow.
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
      const tRes = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`, [subdomain]);
      const tenant = tRes.rows[0];
      if (!tenant) return reply.send({ ok: true, connected: false, bound: false });

      // Se flow_id foi informado, tenta pegar o bot vinculado a ESTE flow
      if (flowId) {
        const fbq = `
          SELECT channel_key AS bot_id, display_name
            FROM flow_channels
           WHERE flow_id = $1
             AND channel_type = 'telegram'
             AND is_active = true
           LIMIT 1
        `;
        const { rows: frows } = await req.db.query(fbq, [String(flowId)]);
        const boundBot = frows?.[0] || null;

        if (boundBot?.bot_id) {
          // Busca a conexão específica desse bot no tenant
          const cq = `
            SELECT external_id AS bot_id, display_name AS username, is_active, settings
              FROM public.tenant_channel_connections
             WHERE tenant_id = $1
               AND channel   = 'telegram'
               AND provider  = 'telegram'
               AND external_id = $2
             LIMIT 1
          `;
          const { rows: crows } = await req.db.query(cq, [tenant.id, boundBot.bot_id]);
          const conn = crows?.[0] || null;

          return reply.send({
            ok: true,
            connected: !!conn?.is_active,
            bound: true,
            bot_id: boundBot.bot_id,
            username: (conn?.username || boundBot.display_name || null),
            webhook_url: conn?.settings?.webhook_url || null,
          });
        }
        // Se não houver vínculo, caímos para o comportamento de tenant (bound=false)
      }

      // Sem flow vinculado: retorna a conexão mais recente do tenant (sem marcar bound)
      const tq = `
        SELECT external_id AS bot_id, display_name AS username, is_active, settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'telegram'
           AND provider  = 'telegram'
         ORDER BY updated_at DESC
         LIMIT 1
      `;
      const { rows } = await req.db.query(tq, [tenant.id]);
      const row = rows[0];

      if (!row) {
        return reply.send({
          ok: true, connected: false, bound: false, bot_id: null, username: null, webhook_url: null
        });
      }

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        bound: false,
        bot_id: row.bot_id || null,
        username: row.username || null,
        webhook_url: row?.settings?.webhook_url || null,
      });
    } catch (err) {
      fastify.log.error({ err }, "[tg/status] failed");
      return reply.code(500).send({ ok: false, error: "tg_status_failed" });
    }
  });
}
