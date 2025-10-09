import { gget, gpost } from "../services/metaGraph.js";
import { encryptToBytea } from "../services/crypto.js";

export default async function instagramRoutes(fastify) {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) {
    fastify.log.warn("[instagram] META_APP_ID/META_APP_SECRET ausentes");
  }

  const getSubdomain = (req) =>
    req?.tenant?.subdomain ||
    req?.tenant?.name ||
    req?.headers["x-tenant-subdomain"] ||
    req?.query?.subdomain ||
    req?.body?.subdomain ||
    null;

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

  async function upsertInstagramConnection(db, {
    tenantId, subdomain, pageId, pageName, igUserId, igUsername, pageAccessToken
  }) {
    const settings = {
      page_name: pageName || null,
      ig_user_id: igUserId || null,
      ig_username: igUsername || null
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
        credentials_encrypted = COALESCE(EXCLUDED.credentials_encrypted, public.tenant_channel_connections.credentials_encrypted),
        settings              = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
        updated_at            = now()
      RETURNING id, tenant_id, channel, provider, account_id, external_id, display_name, is_active, settings, updated_at
    `;

    const enc = encryptToBytea(pageAccessToken || "");
    const res = await db.query(upsertSql, [
      tenantId,
      subdomain,
      String(pageId),           // account_id = PAGE_ID
      String(igUserId),         // external_id = IG_USER_ID
      igUsername || pageName || "",
      enc || null,              // credentials_encrypted (pode ser null se ENC_KEY ausente)
      JSON.stringify(settings)
    ]);
    return res.rows?.[0] || null;
  }

  // POST /api/v1/instagram/finalize { subdomain, code, redirect_uri, page_id? }
  fastify.post("/finalize", async (req, reply) => {
    const subdomain = getSubdomain(req);
    const { code, redirect_uri, page_id } = req.body || {};
    if (!subdomain || !code) return reply.code(400).send({ ok:false, error:"missing_subdomain_or_code" });
    if (!META_APP_ID || !META_APP_SECRET) return reply.code(500).send({ ok:false, error:"meta_app_credentials_missing" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });

    const tenant = await resolveTenant(req);

    // 1) Troca code -> user access token (NÃO REUTILIZAR CODE)
    let userToken;
    try {
      const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
      if (redirect_uri) qs.redirect_uri = redirect_uri;
      const tok = await gget("/oauth/access_token", { qs });
      userToken = tok?.access_token;
      if (!userToken) throw new Error("user_token_exchange_failed");
    } catch (e) {
      const details = e?.details || e?.response?.data || {};
      const msg = (details?.error?.message || e?.message || "").toLowerCase();
      const looksUsed = msg.includes("authorization code has been used") || msg.includes("invalid_grant");
      const looksRedirect = msg.includes("redirect uri");
      const body = {
        ok: false,
        error: looksUsed ? "oauth_code_used" :
               looksRedirect ? "oauth_redirect_mismatch" :
               "user_token_exchange_failed",
        hint: looksUsed
          ? "Faça login novamente para gerar um novo code (ele é de uso único)."
          : looksRedirect
          ? "A redirect_uri deve casar 100% com a configurada no App."
          : "Falha ao trocar code por token; verifique code e redirect_uri."
      };
      await fastify.audit(req, {
        action: "instagram.connect.exchange_failed",
        resourceType: "channel",
        resourceId: `instagram:${subdomain}`,
        statusCode: 400,
        requestBody: { subdomain, has_code: !!code, redirect_uri },
        responseBody: body,
        extra: { meta_error: details || e?.message }
      });
      return reply.code(400).send(body);
    }

    // 2) Lista Páginas com access_token + IG vinculado
    const pages = await gget("/me/accounts", {
      token: userToken,
      qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
    });
    const list = Array.isArray(pages?.data) ? pages.data : [];

    // Sem page_id → devolve lista pro front escolher
    if (!page_id) {
      return reply.send({
        ok:true, step:"pages_list",
        pages: list.map(p => ({
          id:p.id, name:p.name,
          has_instagram: !!p?.instagram_business_account?.id,
          ig_user_id: p?.instagram_business_account?.id || null,
          ig_username: p?.instagram_business_account?.username || null
        }))
      });
    }

    // 3) Página escolhida
    const chosen = list.find(p => String(p.id) === String(page_id));
    if (!chosen || !chosen.access_token) {
      return reply.code(400).send({ ok:false, error:"invalid_page_id_or_missing_access_token" });
    }
    const pageName = chosen.name || null;
    const pageAccessToken = chosen.access_token;

    // IG user
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
    if (!igUserId) return reply.code(400).send({ ok:false, error:"page_not_linked_to_instagram" });

    // 4) (idempotente) Inscreve o app na Página para receber mensagens/postbacks
    try {
      await gpost(`/${page_id}/subscribed_apps`, {
        token: pageAccessToken,
        form: { subscribed_fields: "messages,messaging_postbacks" }
      });
    } catch (e) {
      fastify.log.warn({ err:e }, "[instagram] subscribed_apps falhou (segue)");
    }

    // 5) Upsert conexão (salva token criptografado)
    const after = await upsertInstagramConnection(req.db, {
      tenantId: tenant.id,
      subdomain,
      pageId: page_id,
      pageName,
      igUserId,
      igUsername,
      pageAccessToken
    });

    await fastify.audit(req, {
      action:"instagram.connect.upsert",
      resourceType:"channel",
      resourceId:`instagram:${igUserId}`,
      statusCode:200,
      requestBody:{ subdomain, has_code:true, page_id },
      responseBody:{ ok:true, page_id, ig_user_id:igUserId, ig_username:igUsername },
      afterData:after
    });

    return reply.send({
      ok:true,
      connected:true,
      page_id:String(page_id),
      page_name:pageName,
      ig_user_id:String(igUserId),
      ig_username:igUsername || null
    });
  });

  // GET /api/v1/instagram/status?subdomain=TENANT
  fastify.get("/status", async (req, reply) => {
    const sub = getSubdomain(req);
    if (!sub) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });
    try {
      const tRes = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain=$1 LIMIT 1`, [sub]);
      const t = tRes.rows[0]; if (!t) return reply.send({ ok:true, connected:false });

      const q = `
        SELECT account_id AS page_id, external_id AS ig_user_id, is_active, settings, display_name
          FROM public.tenant_channel_connections
         WHERE tenant_id=$1 AND channel='instagram' AND provider='meta'
         LIMIT 1`;
      const { rows } = await req.db.query(q, [t.id]);
      const row = rows[0];
      if (!row) return reply.send({ ok:true, connected:false, page_id:null, ig_user_id:null, ig_username:null });

      return reply.send({
        ok:true, connected: !!row.is_active,
        page_id: row.page_id,
        ig_user_id: row.ig_user_id,
        ig_username: row?.settings?.ig_username || row.display_name || null,
        page_name: row?.settings?.page_name || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[GET /instagram/status]");
      return reply.code(500).send({ ok:false, error:"ig_status_failed" });
    }
  });

  // DELETE /api/v1/instagram/disconnect?subdomain=TENANT
  // - remove conexão do banco
  // - tenta desinscrever o app da Página (se ainda tivermos page_access_token salvo)
  fastify.delete("/disconnect", async (req, reply) => {
    const sub = getSubdomain(req);
    if (!sub) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });

    try {
      // busca conexão
      const sel = await req.db.query(
        `SELECT id, tenant_id, account_id AS page_id, external_id AS ig_user_id, credentials_encrypted
           FROM public.tenant_channel_connections
          WHERE subdomain=$1 AND channel='instagram' AND provider='meta'
          LIMIT 1`,
        [sub]
      );
      const row = sel.rows?.[0];

      // tenta desinscrever (se tivermos token)
      if (row?.credentials_encrypted) {
        try {
          const { decryptFromBytea } = await import("../services/crypto.js");
          const token = decryptFromBytea(row.credentials_encrypted);
          if (token && row.page_id) {
            // DELETE não existe; Meta usa POST /subscribed_apps?subscribed=false ou DELETE em alguns edges do Messenger.
            // Para Página, o correto é POST subscribed_apps com subscribed=false
            await gpost(`/${row.page_id}/subscribed_apps`, {
              token,
              form: { subscribed: false }
            });
          }
        } catch (e) {
          fastify.log.warn({ err:e }, "[instagram] unsubscribe falhou (segue)");
        }
      }

      // apaga a conexão
      await req.db.query(
        `DELETE FROM public.tenant_channel_connections
          WHERE subdomain=$1 AND channel='instagram' AND provider='meta'`,
        [sub]
      );

      await fastify.audit(req, {
        action:"instagram.disconnect",
        resourceType:"channel",
        resourceId:`instagram:${sub}`,
        statusCode:200,
        requestBody:{ subdomain: sub },
        responseBody:{ ok:true, disconnected:true }
      });

      return reply.send({ ok:true, disconnected:true });
    } catch (err) {
      fastify.log.error({ err }, "[DELETE /instagram/disconnect]");
      return reply.code(500).send({ ok:false, error:"ig_disconnect_failed" });
    }
  });
}
