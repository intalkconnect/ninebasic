// routes/instagram.js
// Conecta uma Página do Facebook (ligada a um Instagram Business/Creator)
// e habilita o recebimento/envio de DMs do Instagram via Graph API.
//
// Requisitos de App (Meta for Developers):
// - Permissões: pages_show_list, pages_manage_metadata, pages_messaging,
//               instagram_basic, instagram_manage_messages
//
// Fluxo (um endpoint principal "finalize"):
// 1) Front abre o OAuth (dialog/oauth) -> obtém ?code
// 2) POST /instagram/finalize { subdomain, code, redirect_uri, page_id? }
//    - troca code->user token
//    - lista páginas do usuário (com access_token + instagram_business_account)
//    - se NÃO vier page_id: retorna lista para o front escolher
//    - se vier page_id: assina /{page_id}/subscribed_apps e salva conexão
//
// Extras:
// - GET /instagram/status?subdomain=TENANT
// - POST /instagram/send (teste de envio de DM) { subdomain, recipient_psid, text }

import { gget, gpost } from "../services/metaGraph.js";

export default async function instagramRoutes(fastify) {
  const {
    META_APP_ID,
    META_APP_SECRET,
  } = process.env;

  if (!META_APP_ID || !META_APP_SECRET) {
    fastify.log.warn("[instagram] META_APP_ID/META_APP_SECRET ausentes");
  }

  /* ================= helpers ================= */

  function getSubdomain(req) {
    return (
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers["x-tenant-subdomain"] ||
      req?.query?.subdomain ||
      req?.body?.subdomain ||
      null
    );
  }

  async function resolveTenant(req) {
    const sub = getSubdomain(req);
    if (!sub) throw new Error("missing_subdomain");
    if (!req.db) throw new Error("db_not_available");

    const tRes = await req.db.query(
      `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
      [sub]
    );
    const t = tRes.rows[0];
    if (!t) throw new Error("tenant_not_found");
    return t;
  }

  // Upsert da conexão IG/FB Page na sua tabela padrão
  async function upsertInstagramConnection(db, {
    tenantId,
    subdomain,
    pageId,
    pageName,
    pageAccessToken,
    igUserId,
    igUsername,
  }) {
    const settings = {
      page_name: pageName || null,
      ig_user_id: igUserId || null,
      ig_username: igUsername || null,
      // Evite armazenar o token em claro nos logs;
      // Se você tiver KMS/cofre, grave cifrado em credentials_encrypted.
      page_access_token: "[SET]"
    };

    const upsertSql = `
      INSERT INTO public.tenant_channel_connections
        (tenant_id, subdomain, channel, provider,
         account_id, external_id, display_name,
         auth_mode, credentials_encrypted, settings, is_active)
      VALUES
        ($1::uuid, $2::text, 'instagram'::channel_type, 'meta'::text,
         $3::text, $4::text, $5::text,
         'page_token'::auth_mode, $6::bytea, $7::jsonb, true)
      ON CONFLICT (tenant_id, channel, external_id)
      DO UPDATE SET
        account_id            = EXCLUDED.account_id,
        display_name          = EXCLUDED.display_name,
        auth_mode             = EXCLUDED.auth_mode,
        -- se você guardar token cifrado, troque aqui:
        credentials_encrypted = COALESCE(EXCLUDED.credentials_encrypted, public.tenant_channel_connections.credentials_encrypted),
        settings              = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
        updated_at            = now()
      RETURNING id, tenant_id, channel, provider, account_id, external_id, display_name, is_active, settings, updated_at
    `;

    // coloque o token real no cofre/cripto e armazene no campo credentials_encrypted
    const encrypted = null;

    const res = await db.query(upsertSql, [
      tenantId,
      subdomain,
      pageId,             // account_id = PAGE_ID
      igUserId,           // external_id = IG_USER_ID (chave externa p/ IG)
      igUsername || pageName || "", // display_name
      encrypted,
      JSON.stringify(settings),
    ]);

    return res.rows?.[0] || null;
  }

  /* ================= ROUTES ================= */

  // 1) FINALIZE: troca code -> user token, lista páginas, assina página (opcional), salva conexão
  // Body: { subdomain, code, redirect_uri, page_id? }
  fastify.post("/finalize", async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers["x-tenant-subdomain"] ||
      req?.body?.subdomain;

    const { code, redirect_uri, page_id } = req.body || {};

    // para auditoria segura
    const safeReq = { subdomain, has_code: !!code, has_redirect: !!redirect_uri, page_id };

    if (!subdomain || !code) {
      return reply.code(400).send({ ok: false, error: "missing_subdomain_or_code" });
    }
    if (!META_APP_ID || !META_APP_SECRET) {
      return reply.code(500).send({ ok: false, error: "meta_app_credentials_missing" });
    }
    if (!req.db) {
      return reply.code(500).send({ ok: false, error: "db_not_available" });
    }

    try {
      const tenant = await resolveTenant(req);

      // 1) exchange code -> user access token
      const qs = {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        code
      };
      if (redirect_uri) qs.redirect_uri = redirect_uri;

      const tok = await gget("/oauth/access_token", { qs });
      const userToken = tok?.access_token;
      if (!userToken) {
        throw new Error("user_token_exchange_failed");
      }

      // 2) listar páginas do usuário (cada uma vem com access_token e instagram_business_account)
      const pages = await gget("/me/accounts", {
        token: userToken,
        qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
      });
      const list = Array.isArray(pages?.data) ? pages.data : [];

      // Se o front ainda não sabe qual página, devolvemos a lista para escolha
      if (!page_id) {
        return reply.send({
          ok: true,
          step: "pages_list",
          pages: list.map(p => ({
            id: p.id,
            name: p.name,
            has_instagram: !!p?.instagram_business_account?.id,
            ig_user_id: p?.instagram_business_account?.id || null,
            ig_username: p?.instagram_business_account?.username || null
          }))
        });
      }

      // 3) localizar a página escolhida
      const chosen = list.find(p => String(p.id) === String(page_id));
      if (!chosen || !chosen.access_token) {
        return reply.code(400).send({ ok: false, error: "invalid_page_id_or_missing_access_token" });
      }

      const pageAccessToken = chosen.access_token;
      const pageName = chosen.name || null;

      // 3.1) garantir IG user id
      let igUserId = chosen?.instagram_business_account?.id || null;
      let igUsername = chosen?.instagram_business_account?.username || null;

      if (!igUserId) {
        const p = await gget(`/${page_id}`, {
          token: userToken,
          qs: { fields: "instagram_business_account{id,username}" }
        });
        igUserId = p?.instagram_business_account?.id || null;
        igUsername = p?.instagram_business_account?.username || null;
      }
      if (!igUserId) {
        return reply.code(400).send({ ok: false, error: "page_not_linked_to_instagram" });
      }

      // 4) assinar webhooks para essa página (mensagens)
      try {
        await gpost(`/${page_id}/subscribed_apps`, {
          token: pageAccessToken,
          form: { subscribed_fields: "messages,messaging_postbacks" }
        });
      } catch (e) {
        // segue mesmo assim, mas loga para diagnóstico
        fastify.log.warn({ err: e }, "[instagram] subscribed_apps falhou (segue)");
      }

      // 5) persistir conexão
      const beforeRes = await req.db.query(
        `SELECT * FROM public.tenant_channel_connections
          WHERE tenant_id = $1 AND channel = 'instagram' AND provider = 'meta'
            AND external_id = $2
          LIMIT 1`,
        [tenant.id, igUserId]
      );
      const before = beforeRes.rows?.[0] || null;

      const after = await upsertInstagramConnection(req.db, {
        tenantId: tenant.id,
        subdomain,
        pageId: String(page_id),
        pageName,
        pageAccessToken, // guarde cifrado se tiver cofre/KMS
        igUserId: String(igUserId),
        igUsername: igUsername || null
      });

      // auditoria
      await fastify.audit(req, {
        action: before ? "instagram.connect.update" : "instagram.connect.create",
        resourceType: "channel",
        resourceId: `instagram:${igUserId}`,
        statusCode: 200,
        requestBody: safeReq,
        responseBody: { ok: true, page_id, ig_user_id: igUserId, ig_username: igUsername },
        beforeData: before,
        afterData: after
      });

      return reply.send({
        ok: true,
        connected: true,
        page_id: String(page_id),
        page_name: pageName,
        ig_user_id: String(igUserId),
        ig_username: igUsername || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[POST /instagram/finalize] failed");

      const status =
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        500;

      await fastify.audit(req, {
        action: "instagram.connect.error",
        resourceType: "channel",
        resourceId: getSubdomain(req),
        statusCode: status,
        requestBody: { has_code: !!req?.body?.code, page_id: req?.body?.page_id || null },
        responseBody: { ok: false, error: err?.message || "ig_connect_failed" },
      });

      return reply.code(status).send({ ok: false, error: err?.message || "ig_connect_failed" });
    }
  });

  // 2) STATUS: devolve se o tenant está conectado ao IG
  // GET /instagram/status?subdomain=TENANT
  fastify.get("/status", async (req, reply) => {
    const subdomain = getSubdomain(req);
    if (!subdomain) return reply.code(400).send({ ok: false, error: "missing_subdomain" });
    if (!req.db)      return reply.code(500).send({ ok: false, error: "db_not_available" });

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.send({ ok: true, connected: false });

      const q = `
        SELECT account_id AS page_id,
               external_id AS ig_user_id,
               display_name AS name,
               is_active,
               settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1
           AND channel   = 'instagram'
           AND provider  = 'meta'
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [tenant.id]);
      const row = rows[0];

      if (!row) {
        return reply.send({ ok: true, connected: false, page_id: null, ig_user_id: null, ig_username: null });
      }

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        page_id: row.page_id,
        page_name: row?.settings?.page_name || row.name || null,
        ig_user_id: row.ig_user_id,
        ig_username: row?.settings?.ig_username || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[GET /instagram/status] failed");
      return reply.code(500).send({ ok: false, error: "ig_status_failed" });
    }
  });

  // 3) SEND: helper para testar envio de DM
  // body: { subdomain, recipient_psid, text }
  fastify.post("/send", async (req, reply) => {
    const subdomain = getSubdomain(req);
    const { recipient_psid, text } = req.body || {};

    if (!subdomain || !recipient_psid || !text) {
      return reply.code(400).send({ ok: false, error: "missing_params" });
    }
    if (!req.db) return reply.code(500).send({ ok: false, error: "db_not_available" });

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenant = tRes.rows[0];
      if (!tenant) return reply.code(404).send({ ok: false, error: "tenant_not_found" });

      const q = `
        SELECT account_id AS page_id,
               settings
          FROM public.tenant_channel_connections
         WHERE tenant_id = $1 AND channel = 'instagram' AND provider = 'meta'
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [tenant.id]);
      const row = rows[0];
      if (!row) return reply.code(400).send({ ok: false, error: "instagram_not_connected" });

      const pageId = row.page_id;
      // recupere o Page Access Token real do seu cofre/KMS; aqui está mascarado em settings
      const pageAccessToken = await fastify.secrets?.get(`ig:${tenant.id}:${pageId}:pat`);
      if (!pageAccessToken) {
        return reply.code(500).send({ ok: false, error: "page_access_token_unavailable" });
      }

      const res = await gpost(`/${pageId}/messages`, {
        token: pageAccessToken,
        json: {
          recipient: { id: String(recipient_psid) },
          messaging_type: "RESPONSE",
          message: { text: String(text).slice(0, 1000) }
        }
      });

      return reply.send({ ok: true, provider: { success: !!res?.recipient_id, message_id: res?.message_id } });
    } catch (err) {
      fastify.log.error({ err }, "[POST /instagram/send] failed");
      return reply.code(500).send({ ok: false, error: "ig_send_failed" });
    }
  });
}
