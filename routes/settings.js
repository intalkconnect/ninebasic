async function settingsRoutes(fastify, options) {
  // Rota GET /settings - Retorna todas as configurações
  fastify.get("/", async (req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT 
           "key",
           value,
           description,
           created_at,
           updated_at
         FROM settings`
      );

      return reply.send(rows);
    } catch (error) {
      fastify.log.error("Erro ao buscar configurações:", error);
      return reply.code(500).send({
        error: "Erro interno ao buscar configurações",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  });

  // Rota POST /settings - Cria ou atualiza uma configuração
  fastify.post("/", async (req, reply) => {
    const { key, value, description } = req.body || {};

    if (!key || typeof value === "undefined") {
      const body400 = { error: "Campos key e value são obrigatórios" };
      await fastify.audit(req, {
        action: "settings.upsert.invalid",
        resourceType: "setting",
        resourceId: key || null,
        statusCode: 400,
        requestBody: req.body,
        responseBody: body400,
      });
      return reply.code(400).send(body400);
    }

    try {
      // lê o estado anterior (se existir) para auditar diff
      const prevRes = await req.db.query(
        `SELECT "key", value, description, created_at, updated_at
         FROM settings
        WHERE "key" = $1
        LIMIT 1`,
        [key]
      );
      const before = prevRes.rows?.[0] || null;

      const { rows } = await req.db.query(
        `INSERT INTO settings ("key", value, description)
         VALUES ($1, $2, $3)
       ON CONFLICT ("key")
       DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         updated_at = NOW()
       RETURNING "key", value, description, created_at, updated_at`,
        [key, value, description ?? null]
      );

      const after = rows[0];

      // auditoria de sucesso (created vs updated)
      await fastify.audit(req, {
        action: before ? "settings.update" : "settings.create",
        resourceType: "setting",
        resourceId: key,
        statusCode: 201,
        requestBody: req.body,
        responseBody: after,
        beforeData: before,
        afterData: after,
        extra: { mode: before ? "updated" : "created" },
      });

      return reply.code(201).send(after);
    } catch (error) {
      fastify.log.error("Erro ao salvar configuração:", error);
      const body500 = {
        error: "Erro interno ao salvar configuração",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      };

      await fastify.audit(req, {
        action: "settings.upsert.error",
        resourceType: "setting",
        resourceId: key,
        statusCode: 500,
        requestBody: req.body,
        responseBody: body500,
        extra: { message: String(error?.message || error) },
      });

      return reply.code(500).send(body500);
    }
  });
}

export default settingsRoutes;
