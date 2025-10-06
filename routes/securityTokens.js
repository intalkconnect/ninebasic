// /app/routes/securityTokens.js
import bcrypt from "bcryptjs";
import { pool } from "../services/db.js";

function maskToken(id, hint) {
  if (!id) return "—";
  const h = (hint || "").slice(0, 8);
  return `${id}.${h}${"•".repeat(64 - h.length)}`; // mostra 8, oculta 56
}

export default async function securityTokensRoutes(fastify) {
  // Lista tokens do tenant (mascarados; sem segredo)
  fastify.get("/tokens", async (req, reply) => {
    const tenantId = req.tenant?.id;
    if (!tenantId)
      return reply.code(400).send({ ok: false, error: "missing_tenant" });

    const { rows } = await pool.query(
      `SELECT id, name, is_default, status, created_at, last_used_at, secret_hint
         FROM public.tenant_tokens
        WHERE tenant_id = $1
        ORDER BY is_default DESC, created_at DESC`,
      [tenantId]
    );

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      is_default: r.is_default,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      preview: maskToken(r.id, r.secret_hint),
    }));

    return { ok: true, items };
  });

  // POST /security/tokens
  fastify.post("/tokens", async (req, reply) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      const body400 = { ok: false, error: "missing_tenant" };
      await fastify.audit(req, {
        action: "token.create.invalid",
        resourceType: "security_token",
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    const rawName = req.body?.name;
    const name = String(rawName ?? "").trim();
    if (!name) {
      const body400 = {
        ok: false,
        error: "name_required",
        message: "Informe o nome do token.",
      };
      await fastify.audit(req, {
        action: "token.create.invalid",
        resourceType: "security_token",
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }
    if (name.length > 64) {
      const body400 = {
        ok: false,
        error: "name_too_long",
        message: "Nome do token deve ter até 64 caracteres.",
      };
      await fastify.audit(req, {
        action: "token.create.invalid",
        resourceType: "security_token",
        statusCode: 400,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    const isDefault = !!req.body?.is_default;

    try {
      const { rows } = await pool.query(
        `SELECT token, token_id
         FROM public.issue_tenant_token_id_secret($1, $2, $3)`,
        [tenantId, name, isDefault]
      );

      const out = rows?.[0] || null;

      await fastify.audit(req, {
        action: "token.create",
        resourceType: "security_token",
        resourceId: out?.token_id ? String(out.token_id) : null,
        statusCode: 200,
        requestBody: { name, is_default: isDefault },
        // nunca registre o segredo em claro no audit:
        responseBody: {
          ok: true,
          id: out?.token_id,
          token: out ? "[REDACTED]" : null,
        },
      });

      return reply.send({ ok: true, id: out?.token_id, token: out?.token });
    } catch (err) {
      req.log.error({ err }, "POST /security/tokens");

      const body500 = {
        ok: false,
        error: "internal_error",
        message: "Erro ao emitir token",
      };
      await fastify.audit(req, {
        action: "token.create.error",
        resourceType: "security_token",
        statusCode: 500,
        requestBody: { name, is_default: isDefault },
        responseBody: body500,
        extra: { message: String(err?.message || err) },
      });

      return reply.code(500).send(body500);
    }
  });

  // Revoga (não permite revogar o default)
  fastify.post("/tokens/:id/revoke", async (req, reply) => {
    const tenantId = req.tenant?.id;
    const tokenId = req.params?.id;

    if (!tenantId || !tokenId) {
      const body400 = { ok: false, error: "bad_request" };
      await fastify.audit(req, {
        action: "token.revoke.invalid",
        resourceType: "security_token",
        resourceId: tokenId || null,
        statusCode: 400,
        responseBody: body400,
        extra: { tenantId: tenantId || null },
      });
      return reply.code(400).send(body400);
    }

    try {
      const { rows } = await pool.query(
        `SELECT is_default, status
         FROM public.tenant_tokens
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
        [tokenId, tenantId]
      );

      const rec = rows?.[0];

      if (!rec) {
        const body404 = { ok: false, error: "not_found" };
        await fastify.audit(req, {
          action: "token.revoke.invalid",
          resourceType: "security_token",
          resourceId: tokenId,
          statusCode: 404,
          responseBody: body404,
          extra: { tenantId },
        });
        return reply.code(404).send(body404);
      }

      if (rec.is_default) {
        const body400 = { ok: false, error: "cannot_revoke_default" };
        await fastify.audit(req, {
          action: "token.revoke.invalid",
          resourceType: "security_token",
          resourceId: tokenId,
          statusCode: 400,
          responseBody: body400,
          extra: { tenantId, is_default: true },
        });
        return reply.code(400).send(body400);
      }

      if (rec.status === "revoked") {
        const body200 = { ok: true, already: true };
        await fastify.audit(req, {
          action: "token.revoke.already",
          resourceType: "security_token",
          resourceId: tokenId,
          statusCode: 200,
          responseBody: body200,
          extra: { tenantId, previousStatus: rec.status },
        });
        return reply.send(body200);
      }

      await pool.query(
        `UPDATE public.tenant_tokens
          SET status = 'revoked'
        WHERE id = $1 AND tenant_id = $2`,
        [tokenId, tenantId]
      );

      const bodyOK = { ok: true };
      await fastify.audit(req, {
        action: "token.revoke",
        resourceType: "security_token",
        resourceId: tokenId,
        statusCode: 200,
        responseBody: bodyOK,
        extra: { tenantId, previousStatus: rec.status },
      });

      return reply.send(bodyOK);
    } catch (err) {
      req.log.error({ err }, "POST /security/tokens/:id/revoke");
      const body500 = { ok: false, error: "internal_error" };
      await fastify.audit(req, {
        action: "token.revoke.error",
        resourceType: "security_token",
        resourceId: tokenId,
        statusCode: 500,
        responseBody: body500,
        extra: { tenantId, message: String(err?.message || err) },
      });
      return reply.code(500).send(body500);
    }
  });
}
