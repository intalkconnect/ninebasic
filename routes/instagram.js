// server/routes/instagram.js
import { gget, gpost } from "../services/metaGraph.js";

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

  async function upsertInstagramConnection(db, { tenantId, subdomain, pageId, pageName, pageAccessToken, igUserId, igUsername }) {
    const settings = { page_name: pageName || null, ig_user_id: igUserId || null, ig_username: igUsername || null, page_access_token: "[SET]" };
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
    const encrypted = null;
    const res = await db.query(upsertSql, [
      tenantId, subdomain, String(pageId), String(igUserId),
      igUsername || pageName || "", encrypted, JSON.stringify(settings)
    ]);
    return res.rows?.[0] || null;
  }

  // POST /instagram/finalize
  // Body: { subdomain, code, redirect_uri, page_id? }
  fastify.post("/finalize", async (req, reply) => {
    const subdomain = getSubdomain(req);
    const { code, redirect_uri, page_id } = req.body || {};
    if (!subdomain || !code) return reply.code(400).send({ ok:false, error:"missing_subdomain_or_code" });
    if (!META_APP_ID || !META_APP_SECRET) return reply.code(500).send({ ok:false, error:"meta_app_credentials_missing" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });

    try {
      const tenant = await resolveTenant(req);

      const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
      if (redirect_uri) qs.redirect_uri = redirect_uri;
      const tok = await gget("/oauth/access_token", { qs });
      const userToken = tok?.access_token;
      if (!userToken) throw new Error("user_token_exchange_failed");

      // páginas + IG vinculado
      const pages = await gget("/me/accounts", {
        token: userToken,
        qs: { fields: "id,name,access_token,instagram_business_account{id,username}" }
      });
      const list = Array.isArray(pages?.data) ? pages.data : [];

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

      const chosen = list.find(p => String(p.id) === String(page_id));
      if (!chosen || !chosen.access_token) {
        return reply.code(400).send({ ok:false, error:"invalid_page_id_or_missing_access_token" });
      }
      const pageAccessToken = chosen.access_token;
      const pageName = chosen.name || null;

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

      try {
        await gpost(`/${page_id}/subscribed_apps`, {
          token: pageAccessToken,
          form: { subscribed_fields: "messages,messaging_postbacks" }
        });
      } catch (e) {
        fastify.log.warn({ err:e }, "[instagram] subscribed_apps falhou (segue)");
      }

      const after = await upsertInstagramConnection(req.db, {
        tenantId: tenant.id, subdomain, pageId: page_id, pageName,
        pageAccessToken, igUserId, igUsername
      });

      await fastify.audit(req, {
        action:"instagram.connect.upsert", resourceType:"channel", resourceId:`instagram:${igUserId}`,
        statusCode:200, requestBody:{ subdomain, has_code:true, page_id },
        responseBody:{ ok:true, page_id, ig_user_id:igUserId, ig_username:igUsername },
        afterData:after
      });

      return reply.send({
        ok:true, connected:true,
        page_id:String(page_id), page_name:pageName,
        ig_user_id:String(igUserId), ig_username:igUsername || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[POST /instagram/finalize]");
      const status =
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 : 500;
      return reply.code(status).send({ ok:false, error: err?.message || "ig_connect_failed" });
    }
  });

  // GET /instagram/status?subdomain=TENANT
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
}
