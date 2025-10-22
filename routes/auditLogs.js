// src/routes/auditLogsRoutes.js
export default async function auditLogsRoutes(fastify) {
  /**
   * GET /audit/logs
   * Query params:
   *  - q: texto livre (action, path, actor_user, resource_type/id)
   *  - actor_id, actor_user
   *  - action
   *  - method (GET/POST/PUT/DELETE…)
   *  - status (status_code)
   *  - resource_type, resource_id
   *  - ip
   *  - from, to (ISO date/time) — intervalo de ts
   *  - limit (default 25, max 100), offset (default 0)
   */
  fastify.get("/audit/logs", async (req, reply) => {
    const {
      q,
      actor_id,
      actor_user,
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
    const push = (sql, val) => { params.push(val); where.push(sql.replace(/\$(\d+)/g, () => `$${params.length}`)); };

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
    if (actor_id)      push(`actor_id = $1`, actor_id);
    if (actor_user)    push(`actor_user ILIKE $1`, `%${actor_user}%`);
    if (action)        push(`action ILIKE $1`, `%${action}%`);
    if (method)        push(`method = $1`, String(method).toUpperCase());
    if (status)        push(`status_code = $1`, Number(status));
    if (resource_type) push(`resource_type = $1`, resource_type);
    if (resource_id)   push(`resource_id = $1`, resource_id);
    if (ip)            push(`ip = $1`, ip);
    if (from)          push(`ts >= $1`, new Date(from));
    if (to)            push(`ts <= $1`, new Date(to));

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const ord = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

    try {
      // total
      const countQ = await req.db.query(
        `SELECT count(*)::int AS total FROM hmg.audit_logs ${whereSql}`,
        params
      );
      const total = countQ.rows[0]?.total ?? 0;

      // dados (sem os JSONs pesados por padrão)
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
      return reply.code(500).send({ error: "Erro ao listar logs", detail: err.message });
    }
  });

  /**
   * GET /audit/logs/:id
   * Retorna o registro completo (inclui JSONs)
   */
  fastify.get("/audit/logs/:id", async (req, reply) => {
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
      return reply.code(500).send({ error: "Erro ao buscar log", detail: err.message });
    }
  });
}
