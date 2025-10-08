// server/routes/facebook.js
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

  async function upsertFacebookConnection(db, { tenantId, subdomain, pageId, pageName }) {
    const settings = { page_name: pageName || null, page_access_token: "[SET]" }; // PAT real: cofre/KMS
    const upsertSql = `
      INSERT INTO public.tenant_channel_connections
        (tenant_id, subdomain, channel, provider,
         account_id, external_id, display_name,
         auth_mode, credentials_encrypted, settings, is_active)
      VALUES
        ($1::uuid, $2::text, 'facebook'::channel_type, 'meta'::text,
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
      tenantId, subdomain, String(pageId), String(pageId), pageName || "", encrypted, JSON.stringify(settings)
    ]);
    return res.rows?.[0] || null;
  }

  // POST /facebook/finalize { subdomain, code, redirect_uri, page_id? }
  fastify.post("/facebook/finalize", async (req, reply) => {
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

      const pages = await gget("/me/accounts", { token: userToken, qs: { fields: "id,name,access_token" } });
      const list = Array.isArray(pages?.data) ? pages.data : [];
      if (!page_id) {
        return reply.send({ ok:true, step:"pages_list", pages: list.map(p => ({ id:p.id, name:p.name })) });
      }

      const chosen = list.find(p => String(p.id) === String(page_id));
      if (!chosen || !chosen.access_token) {
        return reply.code(400).send({ ok:false, error:"invalid_page_id_or_missing_access_token" });
      }
      const pageName = chosen.name || null;

      try {
        await gpost(`/${page_id}/subscribed_apps`, {
          token: chosen.access_token,
          form: { subscribed_fields: "messages,messaging_postbacks" }
        });
      } catch (e) {
        fastify.log.warn({ err:e }, "[facebook] subscribed_apps falhou (segue)");
      }

      const after = await upsertFacebookConnection(req.db, {
        tenantId: tenant.id, subdomain, pageId: page_id, pageName
      });

      await fastify.audit(req, {
        action:"facebook.connect.upsert", resourceType:"channel", resourceId:`facebook:${page_id}`,
        statusCode:200, requestBody:{ subdomain, has_code:true, page_id },
        responseBody:{ ok:true, page_id, page_name:pageName },
        afterData:after
      });

      return reply.send({ ok:true, connected:true, page_id:String(page_id), page_name:pageName });
    } catch (err) {
      fastify.log.error({ err }, "[POST /facebook/finalize]");
      const status =
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 : 500;
      return reply.code(status).send({ ok:false, error: err?.message || "fb_connect_failed" });
    }
  });

  // GET /facebook/status?subdomain=TENANT
  fastify.get("/facebook/status", async (req, reply) => {
    const sub = getSubdomain(req);
    if (!sub) return reply.code(400).send({ ok:false, error:"missing_subdomain" });
    if (!req.db) return reply.code(500).send({ ok:false, error:"db_not_available" });
    try {
      const tRes = await req.db.query(`SELECT id FROM public.tenants WHERE subdomain=$1 LIMIT 1`, [sub]);
      const t = tRes.rows[0]; if (!t) return reply.send({ ok:true, connected:false });

      const q = `
        SELECT account_id AS page_id, display_name AS page_name, is_active, settings
          FROM public.tenant_channel_connections
         WHERE tenant_id=$1 AND channel='facebook' AND provider='meta'
         LIMIT 1`;
      const { rows } = await req.db.query(q, [t.id]);
      const row = rows[0];
      if (!row) return reply.send({ ok:true, connected:false, page_id:null, page_name:null });

      return reply.send({
        ok:true, connected: !!row.is_active,
        page_id: row.page_id, page_name: row?.settings?.page_name || row.page_name || null
      });
    } catch (err) {
      fastify.log.error({ err }, "[GET /facebook/status]");
      return reply.code(500).send({ ok:false, error:"fb_status_failed" });
    }
  });
}
