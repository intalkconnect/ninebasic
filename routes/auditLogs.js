// src/routes/auditLogsRoutes.js
export default async function auditLogsRoutes(fastify) {
  /**
   * GET /audit/logs
   * Query params:
   *  - q: texto livre (action, path, actor_user, resource_type/id)
   *  - actor_id, actor_user, author (alias de actor_user)
   *  - action
   *  - method (GET/POST/PUT/DELETE…)
   *  - status (pode ser: 200 | 2xx | success | fail | csv de valores)
   *  - resource_type, resource_id
   *  - ip
   *  - from, to (ISO date/time) — intervalo de ts
   *  - limit (default 25, max 100), offset (default 0)
   *  - order (asc|desc)
   */
  fastify.get("/logs", async (req, reply) => {
    const {
      q,
      actor_id,
      actor_user,
      author, // alias
      action,
      method,
      status,
      resource_type,
      resource_id,
      ip,
      from,
      to,
      limit = 25,
      offset = 0,
      order = "desc",
    } = req.query || {};

    const where = [];
    const params = [];

    const add = (sqlFrag, ...vals) => {
      // Ex.: add("actor_id = $?", actor_id)
      // Substitui cada $? pelo próximo índice de param.
      let frag = sqlFrag;
      vals.forEach((v) => {
        params.push(v);
        frag = frag.replace("$?", `$${params.length}`);
      });
      where.push(frag);
    };

    if (q) {
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
      where.push(
        `(action ILIKE $${params.length - 4} ` +
          `OR path ILIKE $${params.length - 3} ` +
          `OR actor_user ILIKE $${params.length - 2} ` +
          `OR resource_type ILIKE $${params.length - 1} ` +
          `OR resource_id ILIKE $${params.length})`
      );
    }

    if (actor_id) add(`actor_id = $?`, actor_id);
    const actorLike = author || actor_user;
    if (actorLike) add(`actor_user ILIKE $?`, `%${actorLike}%`);
    if (action) add(`action ILIKE $?`, `%${action}%`);
    if (method) add(`method = $?`, String(method).toUpperCase());
    if (resource_type) add(`resource_type = $?`, resource_type);
    if (resource_id) add(`resource_id = $?`, resource_id);
    if (ip) add(`ip = $?`, ip);
    if (from) add(`ts >= $?`, new Date(from));
    if (to) add(`ts <= $?`, new Date(to));

    // -------- STATUS FLEXÍVEL --------
    // suporta: 200 | 2xx | success | fail | csv (ex.: "2xx,404,success")
    const parseStatusTokens = (raw) => {
      if (!raw) return [];
      const tokens = String(raw)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      return tokens;
    };

    const statusTokens = parseStatusTokens(status);
    if (statusTokens.length) {
      const orClauses = [];

      statusTokens.forEach((tok) => {
        if (/^\d{3}$/.test(tok)) {
          // exato: 200
          params.push(Number(tok));
          orClauses.push(`status_code = $${params.length}`);
          return;
        }

        if (/^[1-5]xx$/.test(tok)) {
          // classe HTTP: 2xx, 4xx…
          const cls = Number(tok[0]);
          const min = cls * 100;
          const max = min + 99;
          params.push(min, max);
          orClauses.push(`(status_code BETWEEN $${params.length - 1} AND $${params.length})`);
          return;
        }

        if (["success", "ok", "sucesso"].includes(tok)) {
          // sucesso: 2xx e 3xx
          params.push(200, 399);
          orClauses.push(`(status_code BETWEEN $${params.length - 1} AND $${params.length})`);
          return;
        }

        if (["fail", "falha", "error", "erro"].includes(tok)) {
          // falha: <200 ou >=400
          params.push(200, 400);
          orClauses.push(`(status_code < $${params.length - 1} OR status_code >= $${params.length})`);
          return;
        }
        // token desconhecido => ignora
      });

      if (orClauses.length) {
        where.push(`(${orClauses.join(" OR ")})`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const ord = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

    try {
      const countQ = await req.db.query(
        `SELECT count(*)::int AS total FROM hmg.audit_logs ${whereSql}`,
        params
      );
      const total = countQ.rows[0]?.total ?? 0;

      const dataQ = await req.db.query(
        `
        SELECT
          id, ts, actor_id, actor_user, method, path, status_code,
          ip::text AS ip, user_agent, action, resource_type, resource_id
        FROM hmg.audit_logs
        ${whereSql}
        ORDER BY ts ${ord}, id ${ord}
        LIMIT ${lim} OFFSET ${off}
        `,
        params
      );

      return reply.send({
        items: dataQ.rows,
        total,
        limit: lim,
        offset: off,
        next_offset: off + lim < total ? off + lim : null,
      });
    } catch (err) {
      req.log.error(err, "Erro ao listar audit logs");
      return reply
        .code(500)
        .send({ error: "Erro ao listar logs", detail: err.message });
    }
  });

  /**
   * GET /audit/logs/:id
   * Retorna o registro completo (inclui JSONs pesados)
   */
  fastify.get("/logs/:id", async (req, reply) => {
    const { id } = req.params;
    try {
      const { rows } = await req.db.query(
        `
        SELECT
          id, ts, actor_id, actor_user, method, path, status_code,
          ip::text AS ip, user_agent, action, resource_type, resource_id,
          request_body, response_body, before_data, after_data, extra
        FROM hmg.audit_logs
        WHERE id = $1
        `,
        [id]
      );
      if (!rows.length) return reply.code(404).send({ error: "Log não encontrado" });

      return reply.send(rows[0]);
    } catch (err) {
      req.log.error(err, "Erro ao buscar audit log");
      return reply
        .code(500)
        .send({ error: "Erro ao buscar log", detail: err.message });
    }
  });
}
