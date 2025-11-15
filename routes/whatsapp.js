// routes/waProfile.js
import { gget, gpost } from "../services/metaGraph.js";

async function whatsappRoutes(fastify) {
  const TOKEN =
    process.env.WHATSAPP_TOKEN ||
    process.env.SYSTEM_USER_TOKEN ||
    process.env.SYSTEM_USER_ADMIN_TOKEN;

  const requireToken = () => {
    if (!TOKEN) throw new Error("meta_token_missing");
    return TOKEN;
  };

  // ---------- helpers ----------
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

  /**
   * Resolve o phone_id obedecendo a prioridade:
   * 1) phone_id explícito (query/body) -> aceita external_id OU id (UUID) e normaliza para external_id
   * 2) flow_id (canal vinculado ao flow) -> aceita channel_key como external_id OU id (UUID) e normaliza para external_id
   * 3) fallback: número "ativo" do tenant
   */
  async function resolvePhoneForRequest(req) {
    const tenant = await resolveTenant(req);

    const phoneIdParam = req?.query?.phone_id || req?.body?.phone_id || null;
    const flowIdParam  = req?.query?.flow_id  || req?.body?.flow_id  || null;

    // 1) phone_id explícito (pode ser external_id ou UUID interno)
    if (phoneIdParam) {
      const q = `
        SELECT id, external_id, settings, is_active
          FROM flow_channels
         WHERE tenant_id = $1
           AND channel   = 'whatsapp'
           AND provider  = 'meta'
           AND (external_id = $2 OR id::text = $2)
         LIMIT 1
      `;
      const { rows } = await req.db.query(q, [tenant.id, String(phoneIdParam)]);
      const row = rows[0];
      if (!row?.external_id) throw new Error("phone_not_found_for_tenant");

      const waba_id =
        row?.settings?.waba_id ||
        (row?.settings && typeof row.settings === "string"
          ? (() => { try { return JSON.parse(row.settings)?.waba_id; } catch { return null; } })()
          : null);

      return { tenant, phone_id: row.external_id, waba_id };
    }

    // 2) via flow_id (flow_channels.channel_key pode ser external_id ou UUID interno)
    if (flowIdParam) {
      const bq = `
        SELECT fc.channel_key AS phone_id
          FROM flow_channels fc
         WHERE fc.flow_id = $1
           AND fc.channel_type = 'whatsapp'
           AND fc.is_active = true
         LIMIT 1
      `;
      const { rows: bRows } = await req.db.query(bq, [String(flowIdParam)]);
      const phoneFromFlow = bRows?.[0]?.phone_id || null;
      if (!phoneFromFlow) throw new Error("flow_not_bound_to_whatsapp");

      // valida que o phone pertence ao tenant e normalize para external_id
      const vq = `
        SELECT external_id, settings
          FROM flow_channels
         WHERE tenant_id = $1
           AND channel   = 'whatsapp'
           AND provider  = 'meta'
           AND (external_id = $2 OR id::text = $2)
         LIMIT 1
      `;
      const { rows: vRows } = await req.db.query(vq, [tenant.id, String(phoneFromFlow)]);
      const v = vRows[0];
      if (!v?.external_id) throw new Error("phone_not_found_for_tenant");

      const waba_id =
        v?.settings?.waba_id ||
        (v?.settings && typeof v.settings === "string"
          ? (() => { try { return JSON.parse(v.settings)?.waba_id; } catch { return null; } })()
          : null);

      return { tenant, phone_id: v.external_id, waba_id };
    }

    // 3) fallback: “ativo”/mais recente no tenant
    const q = `
      SELECT external_id AS phone_id, settings, is_active
        FROM flow_channels
       WHERE tenant_id = $1
         AND channel   = 'whatsapp'
         AND provider  = 'meta'
       ORDER BY is_active DESC, updated_at DESC
       LIMIT 1
    `;
    const { rows } = await req.db.query(q, [tenant.id]);
    const row = rows[0];
    if (!row?.phone_id) throw new Error("no_whatsapp_connection");

    const waba_id =
      row?.settings?.waba_id ||
      (row?.settings && typeof row.settings === "string"
        ? (() => { try { return JSON.parse(row.settings)?.waba_id; } catch { return null; } })()
        : null);

    return { tenant, phone_id: row.phone_id, waba_id };
  }

  const sanitizeWebsites = (raw) => {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
    return arr.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 2);
  };
  const sanitizeVertical = (v) => (v ? String(v).toUpperCase() : undefined);

  // ---------- ENDPOINTS ----------

  // GET /whatsapp/profile -> phone + business profile
  // Aceita: subdomain & (phone_id | flow_id)
  fastify.get("/profile", async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolvePhoneForRequest(req);

      const phoneFields = [
        "id",
        "display_phone_number",
        "verified_name",
        "quality_rating",
        "is_official_business_account",
        "account_mode",
        "code_verification_status",
      ].join(",");

      const profileFields = [
        "about",
        "address",
        "description",
        "email",
        "vertical",
        "websites",
        "profile_picture_url",
      ].join(",");

      const phone = await gget(`/${phone_id}`, {
        token: TOKEN,
        qs: { fields: phoneFields },
      });

      const prof = await gget(`/${phone_id}/whatsapp_business_profile`, {
        token: TOKEN,
        qs: { fields: profileFields },
      });

      const profile = prof?.data ? prof.data[0] || {} : prof || {};
      return reply.send({ ok: true, phone, profile });
    } catch (err) {
      fastify.log.error({ err }, "[GET /whatsapp/profile]");
      const code =
        err?.message === "meta_token_missing" ? 500 :
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        err?.message === "flow_not_bound_to_whatsapp" ? 404 :
        err?.message === "phone_not_found_for_tenant" ? 404 :
        err?.message === "no_whatsapp_connection" ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || "unexpected_error" });
    }
  });

  // POST /whatsapp/profile -> update about/address/description/email/vertical/websites
  // Body: subdomain, (phone_id|flow_id), campos
  fastify.post("/profile", async (req, reply) => {
    let phoneId = null;
    let payload = {};
    try {
      requireToken();
      const act = await resolvePhoneForRequest(req);
      phoneId = act?.phone_id;

      const { about, address, description, email, vertical, websites } = req.body || {};
      payload = {};
      if (about !== undefined) payload.about = String(about).slice(0, 139);
      if (address !== undefined) payload.address = String(address).slice(0, 256);
      if (description !== undefined) payload.description = String(description).slice(0, 512);
      if (email !== undefined) payload.email = String(email).slice(0, 128);
      if (vertical !== undefined) payload.vertical = sanitizeVertical(vertical);
      if (websites !== undefined) payload.websites = sanitizeWebsites(websites);

      if (!Object.keys(payload).length) {
        const body400 = { ok: false, error: "no_allowed_fields" };
        await fastify.audit?.(req, {
          action: "wa.profile.update.invalid",
          resourceType: "whatsapp_profile",
          resourceId: phoneId,
          statusCode: 400,
          requestBody: req.body,
          responseBody: body400,
          extra: { payload_keys: Object.keys(payload), phone_id: phoneId },
        });
        return reply.code(400).send(body400);
      }

      const res = await gpost(`/${phoneId}/whatsapp_business_profile`, {
        token: TOKEN,
        form: payload,
      });

      const body200 = { ok: true, provider: res };
      await fastify.audit?.(req, {
        action: "wa.profile.update",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: 200,
        requestBody: payload,
        responseBody: { ok: true },
        extra: {
          phone_id: phoneId,
          provider_summary: { ok: !!res?.success, keys: Object.keys(res || {}) },
        },
      });

      return reply.send(body200);
    } catch (err) {
      fastify.log.error({ err }, "[POST /whatsapp/profile]");
      const code =
        err?.message === "meta_token_missing" ? 500 :
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        err?.message === "flow_not_bound_to_whatsapp" ? 404 :
        err?.message === "phone_not_found_for_tenant" ? 404 :
        err?.message === "no_whatsapp_connection" ? 404 : 500;

      const bodyErr = { ok: false, error: err?.message || "unexpected_error" };

      await fastify.audit?.(req, {
        action: "wa.profile.update.error",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: code,
        requestBody: payload,
        responseBody: bodyErr,
        extra: {
          phone_id: phoneId,
          message: String(err?.message || err),
          name: err?.name || null,
        },
      });

      return reply.code(code).send(bodyErr);
    }
  });

  // POST /whatsapp/photo-from-url -> upload + aplicar foto
  // body: { subdomain, file_url, type?, phone_id?|flow_id? }
  fastify.post("/photo-from-url", async (req, reply) => {
    let phoneId = null;
    let wabaId = null;
    let payload = {};
    try {
      requireToken();
      const act = await resolvePhoneForRequest(req);
      phoneId = act?.phone_id;
      wabaId  = act?.waba_id;

      const { file_url, type = "image/jpeg" } = req.body || {};
      payload = { file_url, type };

      if (!file_url) {
        const body400 = { ok: false, error: "missing_file_url" };
        await fastify.audit?.(req, {
          action: "wa.profile.photo.invalid",
          resourceType: "whatsapp_profile",
          resourceId: phoneId,
          statusCode: 400,
          requestBody: req.body,
          responseBody: body400,
          extra: { phone_id: phoneId, waba_id: wabaId },
        });
        return reply.code(400).send(body400);
      }

      const up = await gpost(`/${wabaId}/media`, {
        token: TOKEN,
        form: { messaging_product: "whatsapp", type, link: file_url },
      });
      const handle = up?.id;
      if (!handle) {
        const body502 = { ok: false, error: "upload_no_handle" };
        await fastify.audit?.(req, {
          action: "wa.profile.photo.upload_failed",
          resourceType: "whatsapp_profile",
          resourceId: phoneId,
          statusCode: 502,
          requestBody: payload,
          responseBody: body502,
          extra: {
            phone_id: phoneId,
            waba_id: wabaId,
            provider_summary: Object.keys(up || {}),
          },
        });
        return reply.code(502).send(body502);
      }

      const res = await gpost(`/${phoneId}/whatsapp_business_profile`, {
        token: TOKEN,
        form: { profile_picture_handle: handle },
      });

      const body200 = { ok: true, media_id: handle, provider: res };
      await fastify.audit?.(req, {
        action: "wa.profile.photo.set",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: 200,
        requestBody: { ...payload, profile_picture_handle: handle },
        responseBody: { ok: true, media_id: handle },
        extra: {
          phone_id: phoneId,
          waba_id: wabaId,
          provider_summary: Object.keys(res || {}),
        },
      });

      return reply.send(body200);
    } catch (err) {
      fastify.log.error({ err }, "[POST /whatsapp/photo-from-url]");
      const code =
        err?.message === "meta_token_missing" ? 500 :
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        err?.message === "flow_not_bound_to_whatsapp" ? 404 :
        err?.message === "phone_not_found_for_tenant" ? 404 :
        err?.message === "no_whatsapp_connection" ? 404 : 500;

      const bodyErr = { ok: false, error: err?.message || "unexpected_error" };

      await fastify.audit?.(req, {
        action: "wa.profile.photo.error",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: code,
        requestBody: payload,
        responseBody: bodyErr,
        extra: {
          phone_id: phoneId,
          waba_id: wabaId,
          message: String(err?.message || err),
          name: err?.name || null,
        },
      });

      return reply.code(code).send(bodyErr);
    }
  });

  // DELETE /whatsapp/profile/photo -> remove foto
  // body/query: subdomain, (phone_id|flow_id)
  fastify.delete("/profile/photo", async (req, reply) => {
    let phoneId = null;
    let payload = {};
    try {
      requireToken();
      const { phone_id } = await resolvePhoneForRequest(req);
      phoneId = phone_id;
      payload = { profile_picture_handle: "" };

      const res = await gpost(`/${phoneId}/whatsapp_business_profile`, {
        token: TOKEN,
        form: payload,
      });

      const body200 = { ok: true, provider: res };

      await fastify.audit?.(req, {
        action: "wa.profile.photo.unset",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: 200,
        requestBody: payload,
        responseBody: { ok: true },
        extra: { phone_id: phoneId, provider_summary: Object.keys(res || {}) },
      });

      return reply.send(body200);
    } catch (err) {
      fastify.log.error({ err }, "[DELETE /whatsapp/profile/photo]");
      const code =
        err?.message === "meta_token_missing" ? 500 :
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        err?.message === "flow_not_bound_to_whatsapp" ? 404 :
        err?.message === "phone_not_found_for_tenant" ? 404 :
        err?.message === "no_whatsapp_connection" ? 404 : 500;

      const bodyErr = { ok: false, error: err?.message || "unexpected_error" };

      await fastify.audit?.(req, {
        action: "wa.profile.photo.error",
        resourceType: "whatsapp_profile",
        resourceId: phoneId,
        statusCode: code,
        requestBody: payload,
        responseBody: bodyErr,
        extra: {
          phone_id: phoneId,
          message: String(err?.message || err),
          name: err?.name || null,
        },
      });

      return reply.code(code).send(bodyErr);
    }
  });

  // GET /whatsapp/number -> metadados do número (UI)
  // Aceita: subdomain & (phone_id | flow_id)
  fastify.get("/number", async (req, reply) => {
    try {
      requireToken();
      const { phone_id } = await resolvePhoneForRequest(req);

      const fields = [
        "id",
        "display_phone_number",
        "verified_name",
        "quality_rating",
        "is_official_business_account",
        "account_mode",
      ].join(",");

      const phone = await gget(`/${phone_id}`, { token: TOKEN, qs: { fields } });
      return reply.send({ ok: true, phone });
    } catch (err) {
      fastify.log.error({ err }, "[GET /whatsapp/number]");
      const code =
        err?.message === "meta_token_missing" ? 500 :
        err?.message === "missing_subdomain" ? 400 :
        err?.message === "db_not_available" ? 500 :
        err?.message === "tenant_not_found" ? 404 :
        err?.message === "flow_not_bound_to_whatsapp" ? 404 :
        err?.message === "phone_not_found_for_tenant" ? 404 :
        err?.message === "no_whatsapp_connection" ? 404 : 500;
      return reply.code(code).send({ ok: false, error: err?.message || "unexpected_error" });
    }
  });

  // ---------- Embedded Signup helpers ----------

  // POST /whatsapp/embedded/es/pick-number
  fastify.post("/embedded/es/pick-number", async (req, reply) => {
    const { subdomain, phone_number_id } = req.body || {};
    if (!subdomain || !phone_number_id) {
      return reply.code(400).send({ error: "missing_params" });
    }
    if (!req.db) return reply.code(500).send({ error: "db_not_available" });

    // resolve tenant
    const tRes = await req.db.query(
      `SELECT id FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
      [subdomain]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    // ✅ ativa só o escolhido; NÃO mexe nos demais
    await req.db.query(
      `
      UPDATE flow_channels
         SET is_active = true,
             updated_at = now()
       WHERE tenant_id = $1
         AND channel   = 'whatsapp'
         AND provider  = 'meta'
         AND external_id = $2
      `,
      [tenant.id, phone_number_id]
    );

    return reply.send({ ok: true, tenant_id: tenant.id, phone_number_id });
  });

  // ============ FINALIZE (Embedded Signup) ============
  // POST /whatsapp/embedded/es/finalize
  fastify.post("/embedded/es/finalize", async (req, reply) => {
    const subdomain =
      req?.tenant?.subdomain ||
      req?.tenant?.name ||
      req?.headers["x-tenant-subdomain"] ||
      req?.body?.subdomain;

    const { code, redirect_uri: bodyRedirectUri } = req.body || {};
    if (!code || !subdomain) {
      return reply.code(400).send({ error: "missing_code_or_subdomain" });
    }

    const {
      META_APP_ID,
      META_APP_SECRET,
      META_REDIRECT_URI,
      YOUR_BUSINESS_ID,
      SYSTEM_USER_ID,
      SYSTEM_USER_TOKEN,
      SYSTEM_USER_ADMIN_TOKEN,
    } = process.env;

    if (!META_APP_ID || !META_APP_SECRET) {
      return reply.code(500).send({ error: "meta_app_credentials_missing" });
    }
    if (!YOUR_BUSINESS_ID || !SYSTEM_USER_ID || !SYSTEM_USER_TOKEN) {
      return reply.code(500).send({ error: "system_user_or_business_env_missing" });
    }
    if (!req.db) {
      return reply.code(500).send({ error: "db_not_available" });
    }

    try {
      // tenant
      const tRes = await req.db.query(
        `SELECT id, subdomain FROM public.tenants WHERE subdomain = $1 LIMIT 1`,
        [subdomain]
      );
      const tenantRow = tRes.rows[0];
      if (!tenantRow) return reply.code(404).send({ error: "tenant_not_found", subdomain });
      const tenantId = tenantRow.id;

      // exchange code -> user access_token
      const qs = {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        code,
      };

      // ✅ usa o redirect_uri real usado na etapa do OAuth
      if (bodyRedirectUri) {
        qs.redirect_uri = bodyRedirectUri;
      } else if (META_REDIRECT_URI) {
        qs.redirect_uri = META_REDIRECT_URI;
      }

      const tok = await gget("/oauth/access_token", { qs });
      const userToken = tok.access_token;

      // descobrir TODAS as WABAs
      const wabaSet = new Set();

      // granular_scopes
      try {
        const dbg = await gget("/debug_token", {
          qs: {
            input_token: userToken,
            access_token: `${META_APP_ID}|${META_APP_SECRET}`,
          },
        });
        const gs = dbg?.data?.granular_scopes || [];
        gs.forEach((s) => {
          if (s?.scope === "whatsapp_business_management" && Array.isArray(s?.target_ids)) {
            s.target_ids.forEach((id) => id && wabaSet.add(String(id)));
          }
        });
      } catch (e) {
        fastify.log.warn({ err: e }, "[wa/es/finalize] debug_token warn");
      }

      // WABAs do usuário
      try {
        const acc = await gget("/me/whatsapp_business_accounts", { token: userToken });
        (acc?.data || []).forEach((a) => a?.id && wabaSet.add(String(a.id)));
      } catch (e) {
        fastify.log.warn({ err: e }, "[wa/es/finalize] /me/whatsapp_business_accounts warn");
      }

      // WABAs próprias
      try {
        const own = await gget("/me/owned_whatsapp_business_accounts", { token: userToken });
        (own?.data || []).forEach((a) => a?.id && wabaSet.add(String(a.id)));
      } catch (e) {
        fastify.log.warn({ err: e }, "[wa/es/finalize] /me/owned_whatsapp_business_accounts warn");
      }

      // WABAs compartilhadas com seu Business
      try {
        const shared = await gget(`/${YOUR_BUSINESS_ID}/client_whatsapp_business_accounts`, {
          token: SYSTEM_USER_TOKEN,
        });
        (shared?.data || []).forEach((a) => a?.id && wabaSet.add(String(a.id)));
      } catch (e) {
        fastify.log.warn({ err: e }, "[wa/es/finalize] /client_whatsapp_business_accounts warn");
      }

      const wabaIds = Array.from(wabaSet);
      if (!wabaIds.length) {
        return reply.code(400).send({ error: "no_waba_found" });
      }

      // coleta nomes dos portfólios
      const portfolios = [];
      for (const wabaId of wabaIds) {
        let name = null;
        try {
          const w = await gget(`/${wabaId}`, { token: SYSTEM_USER_TOKEN, qs: { fields: "name" } });
          name = w?.name || null;
        } catch {
          // ignore
        }
        portfolios.push({ id: wabaId, name });
      }

      // assinar webhooks + atribuir system user (best-effort)
      for (const wabaId of wabaIds) {
        try { await gpost(`/${wabaId}/subscribed_apps`, { token: userToken }); } catch (e) {
          fastify.log.warn({ err: e, wabaId }, "[wa/es/finalize] subscribed_apps warn");
        }
        try {
          await gpost(`/${wabaId}/assigned_users`, {
            token: SYSTEM_USER_ADMIN_TOKEN || SYSTEM_USER_TOKEN,
            form: { user: SYSTEM_USER_ID, tasks: "['MANAGE']" },
          });
        } catch (e) {
          fastify.log.warn({ err: e, wabaId }, "[wa/es/finalize] assigned_users warn");
        }
      }

      // listar números e persistir (sem ativar)
      const allNumbers = [];
      const qUpsert = `
        INSERT INTO flow_channels
          (tenant_id, subdomain, channel, provider, account_id, external_id, display_name, auth_mode, settings, is_active)
        VALUES
          ($1,        $2,        'whatsapp','meta',  $3,         $4,          $5,           'system_user', $6,       false)
        ON CONFLICT (tenant_id, channel, external_id)
        DO UPDATE SET
          account_id   = EXCLUDED.account_id,
          display_name = EXCLUDED.display_name,
          settings     = COALESCE(public.tenant_channel_connections.settings,'{}'::jsonb) || EXCLUDED.settings,
          updated_at   = now()
      `;

      for (const wabaId of wabaIds) {
        let pn = null;
        try {
          pn = await gget(`/${wabaId}/phone_numbers`, { token: SYSTEM_USER_TOKEN });
        } catch (eSys) {
          fastify.log.warn({ err: eSys, wabaId }, "[wa/es/finalize] phone_numbers sys warn");
          try {
            pn = await gget(`/${wabaId}/phone_numbers`, { token: userToken });
          } catch (eUsr) {
            fastify.log.error({ err: eUsr, wabaId }, "[wa/es/finalize] phone_numbers failed");
            pn = { data: [] };
          }
        }
        const numbers = Array.isArray(pn?.data) ? pn.data : [];
        for (const num of numbers) {
          const phoneId = num?.id;
          if (!phoneId) continue;
          const disp = num?.display_phone_number || num?.verified_name || null;
          const settings = { waba_id: wabaId, raw: num };

          await req.db.query(qUpsert, [
            tenantId,
            subdomain,
            wabaId,
            phoneId,
            disp,
            JSON.stringify(settings),
          ]);

          allNumbers.push({
            id: phoneId,
            display_phone_number: num?.display_phone_number || null,
            verified_name: num?.verified_name || null,
            waba_id: wabaId,
          });
        }
      }

      return reply.send({
        ok: true,
        subdomain,
        tenant_id: tenantId,
        portfolios,
        numbers: allNumbers,
      });
    } catch (err) {
      fastify.log.error(err, "[wa/es/finalize] falha no onboarding");
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return reply.code(status).send({
        error: "wa_embedded_finalize_failed",
        message: err?.message || "Erro inesperado",
        details: err?.details,
      });
    }
  });

  // status do tenant (mantido)
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
        SELECT external_id, display_name, is_active, settings
          FROM flow_channels
         WHERE tenant_id = $1
           AND channel   = 'whatsapp'
           AND provider  = 'meta'
      `;
      const { rows } = await req.db.query(q, [tenant.id]);

      if (!rows.length) {
        return reply.send({
          ok: true,
          connected: false,
          waba_id: null,
          numbers: [],
        });
      }

      const waba_id =
        rows.find((r) => r?.settings?.waba_id)?.settings?.waba_id ||
        rows[0]?.settings?.waba_id ||
        null;

      const numbers = rows.map((r) => {
        const raw = r?.settings?.raw || {};
        return {
          id: r.external_id,
          display_phone_number:
            raw.display_phone_number || r.display_name || null,
          verified_name: raw.verified_name || null,
          is_active: !!r.is_active,
        };
      });

      return reply.send({
        ok: true,
        connected: true,
        waba_id,
        numbers,
      });
    } catch (err) {
      fastify.log.error({ err }, "[wa/status] failed");
      return reply.code(500).send({ ok: false, error: "wa_status_failed" });
    }
  });
}

export default whatsappRoutes;
