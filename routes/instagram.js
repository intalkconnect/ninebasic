import { gget, gpost } from "../services/metaGraph.js";

export default async function instagramRoutes(fastify) {
  const { META_APP_ID, META_APP_SECRET } = process.env;

  const getSub = (req) =>
    req?.tenant?.subdomain ||
    req?.headers["x-tenant-subdomain"] ||
    req?.query?.subdomain ||
    req?.body?.subdomain || null;

  async function resolveTenant(req) {
    const sub = getSub(req);
    if (!sub) throw new Error("missing_subdomain");
    const { rows } = await req.db.query(
      `SELECT id, subdomain FROM public.tenants WHERE subdomain=$1 LIMIT 1`,
      [sub]
    );
    if (!rows[0]) throw new Error("tenant_not_found");
    return rows[0];
  }

  async function upsertIG(db, {
    tenantId, subdomain, pageId, pageName, igUserId, igUsername, pageAccessToken
  }) {
    const settings = {
      page_name: pageName || null,
      ig_user_id: igUserId || null,
      ig_username: igUsername || null,
      ...(pageAccessToken ? { page_access_token: pageAccessToken } : {})
    };
    const sql = `
      INSERT INTO flow_channels
        (tenant_id, subdomain, channel, provider,
         account_id, external_id, display_name,
         auth_mode, credentials_encrypted, settings, is_active)
      VALUES
        ($1, $2, 'instagram', 'meta',
         $3, $4, $5,
         'page_token', NULL, $6, true)
      ON CONFLICT (tenant_id, channel, external_id)
      DO UPDATE SET
        account_id = EXCLUDED.account_id,
        display_name = EXCLUDED.display_name,
        settings = COALESCE(flow_channels.settings,'{}'::jsonb) || EXCLUDED.settings,
        updated_at = now()
      RETURNING id, account_id, external_id, settings, is_active
    `;
    const { rows } = await db.query(sql, [
      tenantId, subdomain,
      String(pageId),         // account_id = PAGE_ID
      String(igUserId),       // external_id = IG_USER_ID
      igUsername || pageName || "",
      JSON.stringify(settings)
    ]);
    return rows[0];
  }

  // POST /api/v1/instagram/finalize
  fastify.post("/finalize", async (req, reply) => {
    const subdomain = getSub(req);
    const { code, redirect_uri, page_id, persist_token } = req.body || {};
    const bodyToken   = req.body?.user_token;
    const headerToken = req.headers["x-ig-user-token"];
    const queryToken  = req.query?.user_token;
    let userToken     = bodyToken || headerToken || queryToken || null;

    if (!subdomain) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db)     return reply.code(500).send({ ok:false, error:"db_not_available" });
    if (!META_APP_ID || !META_APP_SECRET) {
      return reply.code(500).send({ ok:false, error:"meta_app_credentials_missing" });
    }

    try {
      const tenant = await resolveTenant(req);

      // Passo 1: trocar code -> user_token e listar páginas
      if (!page_id) {
        if (!userToken) {
          if (!code) return reply.code(400).send({ ok:false, error:"missing_code_or_user_token" });
          try {
            const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
            if (redirect_uri) qs.redirect_uri = redirect_uri;
            const tok = await gget("/oauth/access_token", { qs });
            userToken = tok?.access_token || null;
          } catch (e) {
            if (e?.details?.error_subcode === 36009) {
              return reply.code(400).send({ ok:false, error:"oauth_code_used", hint:"Refaça o login para um novo code." });
            }
            throw e;
          }
        }
        if (!userToken) return reply.code(400).send({ ok:false, error:"user_token_exchange_failed" });

        const pages = await gget("/me/accounts", {
          token: userToken,
          qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
        });
        const list = Array.isArray(pages?.data) ? pages.data : [];

        return reply.send({
          ok: true,
          step: "pages_list",
          user_token: userToken, // devolve para o passo 2
          pages: list.map(p => ({
            id: p.id,
            name: p.name,
            has_instagram: !!p?.instagram_business_account?.id,
            ig_user_id: p?.instagram_business_account?.id || null,
            ig_username: p?.instagram_business_account?.username || null
          }))
        });
      }

      // Passo 2: finalizar com page_id + user_token
      if (!userToken) return reply.code(400).send({ ok:false, error:"missing_user_token_for_finalize" });

      const pages = await gget("/me/accounts", {
        token: userToken,
        qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
      });
      const list   = Array.isArray(pages?.data) ? pages.data : [];
      const chosen = list.find(p => String(p.id) === String(page_id));
      if (!chosen || !chosen.access_token)
        return reply.code(400).send({ ok:false, error:"invalid_page_id_or_missing_access_token" });

      const pageAccessToken = chosen.access_token;
      const pageName        = chosen.name || null;
      let igUserId          = chosen?.instagram_business_account?.id || null;
      let igUsername        = chosen?.instagram_business_account?.username || null;

      if (!igUserId) {
        const p = await gget(`/${page_id}`, { token: userToken, qs:{ fields:"instagram_business_account{id,username}" }});
        igUserId   = p?.instagram_business_account?.id || null;
        igUsername = p?.instagram_business_account?.username || null;
      }
      if (!igUserId)
        return reply.code(400).send({ ok:false, error:"page_not_linked_to_instagram" });

      // ✅ Assinar IG DMs no IG USER (não a Página)
      let igSubscribed = false;
      try {
        const subRes = await gpost(`/${igUserId}/subscribed_apps`, {
          token: pageAccessToken,               // PAT da Página
          form:  { subscribed_fields: "messages" }
        });
        igSubscribed = !!(subRes && (subRes.success === true || subRes.result === "success"));
      } catch (e) {
        fastify.log.error({ err:e, igUserId }, "[instagram] subscribe IG user failed");
        return reply.code(400).send({
          ok:false,
          error:"ig_user_subscribe_failed",
          details:e?.details || e?.message || null
        });
      }
      if (!igSubscribed) {
        return reply.code(400).send({ ok:false, error:"ig_user_subscribe_not_confirmed" });
      }

      // (opcional) Se também quiser Messenger, assine a Página aqui:
      // await gpost(`/${page_id}/subscribed_apps`, {
      //   token: pageAccessToken,
      //   form: { subscribed_fields: "messages,messaging_postbacks" }
      // });

      const saved = await upsertIG(req.db, {
        tenantId: tenant.id,
        subdomain,
        pageId: page_id,
        pageName,
        igUserId,
        igUsername,
        pageAccessToken: persist_token ? pageAccessToken : undefined
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
      return reply.code(status).send({ ok:false, error: err?.message || "ig_connect_failed", details: err?.details });
    }
  });

  // GET /api/v1/instagram/status
  fastify.get("/status", async (req, reply) => {
    const sub = getSub(req);
    if (!sub) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });

    try {
      const { rows: tRows } = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain=$1 LIMIT 1`, [sub]);
      if (!tRows[0]) return reply.send({ ok:true, connected:false });

      const { rows } = await req.db.query(
        `SELECT account_id AS page_id, external_id AS ig_user_id, is_active, settings, display_name
           FROM flow_channels
          WHERE tenant_id=$1 AND channel='instagram' AND provider='meta'
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tRows[0].id]
      );
      const row = rows[0];
      if (!row) return reply.send({ ok:true, connected:false, page_id:null, ig_user_id:null, ig_username:null });

      reply.send({
        ok: true,
        connected: !!row.is_active,
        page_id: row.page_id,
        page_name: row?.settings?.page_name || null,
        ig_user_id: row.ig_user_id,
        ig_username: row?.settings?.ig_username || row.display_name || null
      });
    } catch (e) {
      fastify.log.error({ err:e }, "[GET /instagram/status]");
      reply.code(500).send({ ok:false, error:"ig_status_failed" });
    }
  });
}
