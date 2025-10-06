// plugins/auditPlugin.js
import fp from "fastify-plugin";

// quais chaves redigir
const SENSITIVE_KEYS = new Set([
  "password",
  "senha",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "secret",
  "apiKey",
  "api_key",
  "cpf",
  "ssn",
  "card",
  "cvv",
]);

function redact(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(String(k).toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = redact(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function auditPlugin(fastify, opts) {
  // dependência: fastify.pg ou um client em req.db
  const getDb = (req) => req.db || fastify.pg;

  // pega identidade do usuário (adapte ao seu auth)
  const getActor = (req) => {
    // exemplos: req.user?.id (passport/jwt), req.headers['x-user-id'], etc.
    const actor_id = req.user?.id || req.headers["x-user-id"] || null;
    const actor_name =
      req.user?.email ||
      req.headers["x-user-email"] ||
      req.actor?.email ||
      req.user?.name ||
      req.headers["x-user-name"] ||
      req.actor?.name ||
      null;
    return { actor_id, actor_name };
  };

  // expõe utilitário manual
  fastify.decorate(
    "audit",
    async function auditLog(
      req,
      {
        action,
        resourceType,
        resourceId,
        beforeData,
        afterData,
        extra,
        requestBody,
        responseBody,
        statusCode,
      }
    ) {
      const db = getDb(req);
      const { actor_id, actor_name } = getActor(req);
      const ip = req.ip;
      const ua = req.headers["user-agent"] || null;
      const path = req.routerPath || req.raw.url;
      const method = req.method;

      const sql = `
      INSERT INTO audit_logs
        (actor_id, actor_name, method, path, status_code, ip, user_agent,
         action, resource_type, resource_id,
         request_body, response_body, before_data, after_data, extra)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)
    `;
      const params = [
        actor_id,
        actor_name,
        method,
        path,
        statusCode ?? 200,
        ip,
        ua,
        action || null,
        resourceType || null,
        resourceId || null,
        requestBody ? JSON.stringify(redact(requestBody)) : null,
        responseBody ? JSON.stringify(redact(responseBody)) : null,
        beforeData ? JSON.stringify(redact(beforeData)) : null,
        afterData ? JSON.stringify(redact(afterData)) : null,
        extra ? JSON.stringify(redact(extra)) : null,
      ];
      if (db?.query) {
        await db.query(sql, params);
      } else if (db?.pool) {
        await db.pool.query(sql, params);
      } else {
        fastify.log.error("audit: no db client available");
      }
    }
  );

  // hook automático para métodos de escrita
  // fastify.addHook('onSend', async (req, reply, payload) => {
  //   try {
  //     const m = req.method.toUpperCase();
  //     if (!['POST','PUT','PATCH','DELETE'].includes(m)) return;

  //     // o payload pode ser string JSON; evite guardar respostas enormes
  //     let responseBody = null;
  //     if (payload && typeof payload === 'string' && payload.length < 200_000) { // ~200KB
  //       try { responseBody = JSON.parse(payload); } catch { /* ignore */ }
  //     }

  //     await fastify.audit(req, {
  //       statusCode: reply.statusCode,
  //       requestBody: req.body && typeof req.body === 'object' ? req.body : null,
  //       responseBody
  //     });
  //   } catch (e) {
  //     reply.log.error({ err: e }, 'audit onSend failed');
  //   }
  // });
}

export default fp(auditPlugin, { name: "auditPlugin" });
