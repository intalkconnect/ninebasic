// routes/instagram.js
import { gget, gpost } from "../services/metaGraph.js";

/**
 * Instagram (Meta) – conexão por tenant
 * POST /api/v1/instagram/finalize
 *   Passo 1: { code, redirect_uri }  ->  { step:'pages_list', user_token, pages[] }
 *   Passo 2: { page_id, user_token, persist_token? } -> salva no banco
 *
 * GET  /api/v1/instagram/status?subdomain=TENANT
 */
export default async function instagramRoutes(fastify) {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) {
    fastify.log.warn("[instagram] META_APP_ID/META_APP_SECRET ausentes");
  }

  // ----------------- helpers de tenant -----------------
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

  // ----------------- upsert conexão IG -----------------
  async function upsertInstagramConnection(db, {
    tenantId,
    subdomain,
    pageId,
    pageName,
    igUserId,
    igUsername,
    pageAccessToken, // opcional – só se persist_token=true
  }) {
    const settings = {
      page_name: pageName || null,
      ig_user_id: igUserId || null,
      ig_username: igUsername || null,
      ...(pageAccessToken ? { page_access_token: pageAccessToken } : {})
    };

    const sql = `
      INSERT INTO public.tenant_channel_connections
        (tenant_id, subdomain, channel, provider,
         account_id, external_id, display_name,
         auth_mode, credentials_encrypted, settings, is_active)
      VALUES
        ($1::uuid, $2::text, 'instagram'::channel_type, 'meta'::text,
         $3::text, $4::text, $5::text,
         'page_token'::auth_mode, NULL, $6::jsonb, true)
      ON CONFLICT (tenant_id, channel, external_id)
      DO UPDATE SET
        account_id   = EXCLUDED.account_id,
        display_name = EXCLUDED.display_name,
        auth_mode    = EXCLUDED.auth_mode,
        settings     = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
        updated_at   = now()
      RETURNING id, tenant_id, channel, provider, account_id, external_id, display_name, is_active, settings, updated_at
    `;

    const res = await db.query(sql, [
      tenantId,
      subdomain,
      String(pageId),     // account_id  -> PAGE_ID
      String(igUserId),   // external_id -> IG_USER_ID
      igUsername || pageName || "",
      JSON.stringify(settings)
    ]);
    return res.rows?.[0] || null;
  }

  // ----------------- finalize (2 passos) -----------------
  fastify.post("/finalize", async (req, reply) => {
    const subdomain = getSubdomain(req);
    // body
    const { code, redirect_uri, page_id, persist_token } = req.body || {};
    // aceitar user_token também por header/query
    const bodyToken   = (req.body || {}).user_token;
    const headerToken = req.headers["x-ig-user-token"];
    const queryToken  = req.query?.user_token;
    let userToken     = bodyToken || headerToken || queryToken || null;

    if (!subdomain) return reply.code(400).send({ ok: false, error: "missing_subdomain" });
    if (!req.db)     return reply.code(500).send({ ok: false, error: "db_not_available" });
    if (!META_APP_ID || !META_APP_SECRET) {
      return reply.code(500).send({ ok: false, error: "meta_app_credentials_missing" });
    }

    try {
      const tenant = await resolveTenant(req);

      // ----------------- PASSO 1: trocar code -> user_token + pages -----------------
      if (!page_id) {
        if (!userToken) {
          if (!code) {
            return reply.code(400).send({ ok: false, error: "missing_code_or_user_token" });
          }

          try {
            const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
            if (redirect_uri) qs.redirect_uri = redirect_uri;
            const tok = await gget("/oauth/access_token", { qs });
            userToken = tok?.access_token || null;
          } catch (e) {
            // code já consumido
            const subcode = e?.details?.error_subcode;
            if (subcode === 36009) {
              return reply.code(400).send({
                ok: false,
                error: "oauth_code_used",
                hint: "Faça login novamente para gerar um novo code (ele é de uso único)."
              });
            }
            throw e;
          }
        }

        if (!userToken) {
          return reply.code(400).send({ ok: false, error: "user_token_exchange_failed" });
        }

        const pages = await gget("/me/accounts", {
          token: userToken,
          qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
        });
        const list = Array.isArray(pages?.data) ? pages.data : [];

        // devolve o token para ser usado no passo 2
        return reply.send({
          ok: true,
          step: "pages_list",
          user_token: userToken,
          pages: list.map((p) => ({
            id: p.id,
            name: p.name,
            has_instagram: !!p?.instagram_business_account?.id,
            ig_user_id: p?.instagram_business_account?.id || null,
            ig_username: p?.instagram_business_account?.username || null
          }))
        });
      }

      // ----------------- PASSO 2: concluir com page_id + user_token -----------------
      if (!userToken) {
        return reply.code(400).send({ ok: false, error: "missing_user_token_for_finalize" });
      }

      // Carrega páginas novamente com o mesmo user_token
      const pages = await gget("/me/accounts", {
        token: userToken,
        qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
      });
      const list = Array.isArray(pages?.data) ? pages.data : [];
      const chosen = list.find((p) => String(p.id) === String(page_id));

      if (!chosen || !chosen.access_token) {
        return reply.code(400).send({ ok: false, error: "invalid_page_id_or_missing_access_token" });
      }

      const pageAccessToken = chosen.access_token;                   // PAT da página
      const pageName        = chosen.name || null;
      let igUserId          = chosen?.instagram_business_account?.id || null;
      let igUsername        = chosen?.instagram_business_account?.username || null;

      // fallback: página não mostrava o ig vinculado
      if (!igUserId) {
        const p = await gget(`/${page_id}`, {
          token: userToken,
          qs: { fields: "instagram_business_account{id,username}" }
        });
        igUserId   = p?.instagram_business_account?.id || null;
        igUsername = p?.instagram_business_account?.username || null;
      }
      if (!igUserId) {
        return reply.code(400).send({ ok: false, error: "page_not_linked_to_instagram" });
      }

      // Assina webhooks do app nessa Página (mensagens/postbacks)
      try {
        await gpost(`/${page_id}/subscribed_apps`, {
          token: pageAccessToken,
          form: { subscribed_fields: "messages,messaging_postbacks" }
        });
      } catch (e) {
        fastify.log.warn({ err: e }, "[instagram] subscribed_apps falhou (segue)");
      }

      // Persiste conexão (com PAT apenas se persist_token=true)
      const saved = await upsertInstagramConnection(req.db, {
        tenantId: tenant.id,
        subdomain,
        pageId: page_id,
        pageName,
        igUserId,
        igUsername,
        pageAccessToken: persist_token ? pageAccessToken : undefined
      });

      await fastify.audit(req, {
        action: "instagram.connect.upsert",
        resourceType: "channel",
        resourceId: `instagram:${igUserId}`,
        statusCode: 200,
        requestBody: {
          subdomain,
          step: "finalize",
          page_id,
          persist_token: !!persist_token
        },
        responseBody: {
          ok: true,
          page_id,
          ig_user_id: igUserId,
          ig_username: igUsername,
          token_persisted: !!persist_token
        },
        afterData: {
          id: saved?.id,
          account_id: saved?.account_id,
          external_id: saved?.external_id
        }
      });

      return reply.send({
        ok: true,
        connected: true,
        page_id: String(page_id),
        page_name: pageName,
        ig_user_id: String(igUserId),
        ig_username: igUsername || null,
        token_persisted: !!persist_token
      });
    } catch (err) {
      fastify.log.error({ err }, "[POST /instagram/finalize]");
      const status =
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 : 500;
      return reply.code(status).send({
        ok: false,
        error: err?.message || "ig_connect_failed",
        details: err?.details
      });
    }
  });

  // ----------------- status -----------------
  fastify.get("/status", async (req, reply) => {
    const sub = getSubdomain(req);
    if (!sub) return reply.code(400).send({ ok: false, error: "missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok: false, error: "db_not_available" });

    try {
      const tRes = await req.db.query(
        `SELECT id FROM public.tenants WHERE subdomain=$1 LIMIT 1`,
        [sub]
      );
      const t = tRes.rows[0];
      if (!t) return reply.send({ ok: true, connected: false });

      const q = `
        SELECT account_id AS page_id,
               external_id AS ig_user_id,
               is_active,
               settings,
               display_name
          FROM public.tenant_channel_connections
         WHERE tenant_id=$1 AND channel='instagram' AND provider='meta'
         ORDER BY updated_at DESC
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [t.id]);
      const row = rows[0];

      if (!row) {
        return reply.send({
          ok: true,
          connected: false,
          page_id: null,
          ig_user_id: null,
          ig_username: null
        });
      }

      return reply.send({
        ok: true,
        connected: !!row.is_active,
        page_id: row.page_id,
        ig_user_id: row.ig_user_id,
        ig_username: row?.settings?.ig_username || row.display_name || null,
        page_name: row?.settings?.page_name || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[GET /instagram/status]");
      return reply.code(500).send({ ok: false, error: "ig_status_failed" });
    }
  });
}
