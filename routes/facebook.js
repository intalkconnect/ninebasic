// routes/facebook.js
import { gget, gpost } from "../services/metaGraph.js";

export default async function facebookRoutes(fastify) {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) {
    fastify.log.warn("[facebook] META_APP_ID/META_APP_SECRET ausentes");
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

  async function upsertFacebookConnection(db, {
    tenantId, subdomain, pageId, pageName, pageAccessToken
  }) {
    const settings = {
      page_name: pageName || null,
      ...(pageAccessToken ? { page_access_token: pageAccessToken } : {})
    };

    const sql = `
      INSERT INTO flow_channels
        (tenant_id, subdomain, channel_type, provider,
         account_id, external_id, display_name,
         auth_mode, credentials_encrypted, settings, is_active)
      VALUES
        ($1::uuid, $2::text, 'facebook'::channel_type, 'meta'::text,
         $3::text, $3::text, $4::text,
         'oauth'::auth_mode, NULL, $5::jsonb, true)
      ON CONFLICT (tenant_id, channel_type, external_id)
      DO UPDATE SET
        account_id   = EXCLUDED.account_id,
        display_name = EXCLUDED.display_name,
        auth_mode    = EXCLUDED.auth_mode,
        settings     = COALESCE(flow_channels.settings,'{}'::jsonb) || EXCLUDED.settings,
        updated_at   = now()
      RETURNING id, tenant_id, channel_type, provider, account_id, external_id,
                display_name, is_active, settings, updated_at
    `;

    try {
      const res = await db.query(sql, [
        tenantId,
        subdomain,
        String(pageId),
        pageName || "",
        JSON.stringify(settings),
      ]);
      return res.rows?.[0] || null;
    } catch (e) {
      // Log explícito para facilitar diagnóstico
      fastify.log.error({ err:e, pageId, subdomain }, "[facebook] upsert DB failed");
      throw e;
    }
  }

  // POST /api/v1/facebook/finalize (2 passos)
  fastify.post("/finalize", async (req, reply) => {
    const subdomain = getSubdomain(req);
    const { code, redirect_uri, page_id, persist_token } = req.body || {};

    const bodyToken   = req.body?.user_token;
    const headerToken = req.headers["x-fb-user-token"];
    const queryToken  = req.query?.user_token;
    let userToken     = bodyToken || headerToken || queryToken || null;

    if (!subdomain) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db)     return reply.code(500).send({ ok:false, error:"db_not_available" });
    if (!META_APP_ID || !META_APP_SECRET)
      return reply.code(500).send({ ok:false, error:"meta_app_credentials_missing" });

    try {
      const tenant = await resolveTenant(req);

      // PASSO 1
      if (!page_id) {
        if (!userToken) {
          if (!code) return reply.code(400).send({ ok:false, error:"missing_code_or_user_token" });
          const qs = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
          if (redirect_uri) qs.redirect_uri = redirect_uri;
          const tok = await gget("/oauth/access_token", { qs });
          userToken = tok?.access_token;
        }
        if (!userToken) return reply.code(400).send({ ok:false, error:"user_token_exchange_failed" });

        const pages = await gget("/me/accounts", {
          token: userToken,
          qs: { fields: "id,name,access_token" }
        });
        const list = Array.isArray(pages?.data) ? pages.data : [];

        return reply.send({
          ok: true,
          step: "pages_list",
          user_token: userToken,
          pages: list.map(p => ({ id: p.id, name: p.name }))
        });
      }

      // PASSO 2
      if (!userToken)
        return reply.code(400).send({ ok:false, error:"missing_user_token_for_finalize" });

      const pages = await gget("/me/accounts", {
        token: userToken,
        qs: { fields: "id,name,access_token" }
      });
      const list = Array.isArray(pages?.data) ? pages.data : [];
      const chosen = list.find(p => String(p.id) === String(page_id));
      if (!chosen || !chosen.access_token)
        return reply.code(400).send({ ok:false, error:"invalid_page_id_or_missing_access_token" });

      const pageAccessToken = chosen.access_token;
      const pageName        = chosen.name || null;

      try {
        await gpost(`/${page_id}/subscribed_apps`, {
          token: pageAccessToken,
          form: { subscribed_fields: "messages" }
        });
      } catch (e) {
        fastify.log.warn({ err:e }, "[facebook] subscribed_apps falhou (segue)");
      }

      const saved = await upsertFacebookConnection(req.db, {
        tenantId: tenant.id,
        subdomain,
        pageId: page_id,
        pageName,
        pageAccessToken: persist_token ? pageAccessToken : undefined
      });

      await fastify.audit(req, {
        action:"facebook.connect.upsert",
        resourceType:"channel",
        resourceId:`facebook:${page_id}`,
        statusCode:200,
        requestBody:{ subdomain, step:"finalize", page_id, persist_token: !!persist_token },
        responseBody:{ ok:true, page_id, page_name: pageName, token_persisted: !!persist_token },
        afterData:saved
      });

      return reply.send({
        ok:true,
        connected:true,
        page_id:String(page_id),
        page_name:pageName,
        token_persisted: !!persist_token
      });
    } catch (err) {
      fastify.log.error({ err }, "[POST /facebook/finalize]");
      const status =
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 : 500;
      return reply.code(status).send({ ok:false, error: err?.message || "fb_connect_failed", details: err?.details });
    }
  });

  // GET /api/v1/facebook/status
  fastify.get("/status", async (req, reply) => {
    const sub = getSubdomain(req);
    if (!sub) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });

    try {
      const tRes = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain=$1 LIMIT 1`, [sub]);
      const t = tRes.rows[0];
      if (!t) return reply.send({ ok:true, connected:false });

      const q = `
        SELECT account_id AS page_id, is_active, settings, display_name
          FROM flow_channels
         WHERE tenant_id=$1 AND channel_type='facebook' AND provider='meta'
         ORDER BY updated_at DESC
         LIMIT 1`;
      const { rows } = await req.db.query(q, [t.id]);
      const row = rows[0];
      if (!row) return reply.send({ ok:true, connected:false, page_id:null, page_name:null });

      return reply.send({
        ok:true,
        connected: !!row.is_active,
        page_id: row.page_id,
        page_name: row?.settings?.page_name || row.display_name || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[GET /facebook/status]");
      return reply.code(500).send({ ok:false, error:"fb_status_failed" });
    }
  });
}
