// routes/campaigns.js
import { v4 as uuidv4 } from "uuid";
import { parse as csvParser } from "csv-parse";
import fs from "fs";
import os from "os";
import path from "path";

const UPLOAD_DIR =
  process.env.CAMPAIGN_UPLOAD_DIR || path.join(os.tmpdir(), "campaign_csv");

export default async function campaignsRoutes(fastify) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // =============================================================================
  // GET /api/v1/campaigns
  // Filtros:
  //   - status: '', queued, scheduled, finished, failed
  //   - q: busca por nome (ILIKE)
  //   - limit/offset (opcional; default 100/0)
  // Retorna também agregados de campaign_items para progresso.
  // =============================================================================

  // GET /api/v1/campaigns?tab=(all|active|finished|failed)&q=texto
  fastify.get("/", async (req) => {
    const { tab = "all", q = "" } = req.query || {};
    const where = [];
    const params = [];
    let i = 1;

    if (tab === "active") where.push(`c.status IN ('queued','scheduled')`);
    else if (tab === "finished") where.push(`c.status = 'finished'`);
    else if (tab === "failed") where.push(`c.status = 'failed'`);

    if (q && String(q).trim()) {
      where.push(`(c.name ILIKE $${i} OR c.template_name ILIKE $${i})`);
      params.push(`%${String(q).trim()}%`);
      i++;
    }
    const AND = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        c.id,
        c.name,
        c.template_name,
        c.language_code,
        c.components,
        c.status,
        c.start_at,
        c.updated_at,
        -- NOVOS:
        c.default_reply_action,
        c.default_reply_payload,

        CASE WHEN c.start_at IS NULL THEN 'immediate' ELSE 'scheduled' END AS mode,

        COUNT(ci.*)::int AS total_items,
        COUNT(*) FILTER (WHERE ci.last_status = 'sent')::int      AS sent_count,
        COUNT(*) FILTER (WHERE ci.last_status = 'delivered')::int AS delivered_count,
        COUNT(*) FILTER (WHERE ci.last_status = 'read')::int      AS read_count,
        COUNT(*) FILTER (WHERE ci.last_status = 'failed')::int    AS failed_count,
        COUNT(*) FILTER (WHERE ci.message_id IS NOT NULL OR ci.last_status = 'failed')::int AS processed_count
      FROM campaigns c
      LEFT JOIN campaign_items ci ON ci.campaign_id = c.id
      ${AND}
      GROUP BY c.id
      ORDER BY c.updated_at DESC NULLS LAST, c.name ASC
      LIMIT 200
    `;

    const { rows } = await req.db.query(sql, params);
    return rows.map((r) => ({
      ...r,
      remaining: Math.max(0, Number(r.total_items) - Number(r.processed_count)),
    }));
  });

  // GET /api/v1/campaigns/:id
  fastify.get("/:id", async (req, reply) => {
    const { id } = req.params;
    const { rows } = await req.db.query(
      `
      WITH agg AS (
        SELECT
          campaign_id,
          COUNT(*)::int                                               AS total_items,
          COUNT(*) FILTER (WHERE COALESCE(delivery_status,'') <> '')::int AS processed_count,
          COUNT(*) FILTER (WHERE delivery_status = 'sent')::int       AS sent_count,
          COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int  AS delivered_count,
          COUNT(*) FILTER (WHERE delivery_status = 'read')::int       AS read_count,
          COUNT(*) FILTER (WHERE delivery_status = 'failed')::int     AS failed_count
        FROM campaign_items
        WHERE campaign_id = $1
        GROUP BY campaign_id
      )
      SELECT
        c.*,
        -- já traz também:
        c.default_reply_action,
        c.default_reply_payload,

        COALESCE(a.total_items, 0)       AS total_items,
        COALESCE(a.processed_count, 0)   AS processed_count,
        COALESCE(a.sent_count, 0)        AS sent_count,
        COALESCE(a.delivered_count, 0)   AS delivered_count,
        COALESCE(a.read_count, 0)        AS read_count,
        COALESCE(a.failed_count, 0)      AS failed_count
      FROM campaigns c
      LEFT JOIN agg a ON a.campaign_id = c.id
      WHERE c.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (!rows.length)
      return reply.code(404).send({ error: "Campaign not found" });
    return rows[0];
  });

  // POST /api/v1/campaigns
  fastify.post("/", async (req, reply) => {
    try {
      const parts = req.parts();
      let tempPath, tempName;
      let metaStr = null;
      const flat = {
        name: null,
        template_name: null,
        language_code: null,
        components: null,
        start_at: null,
        // NOVOS (campanha inteira):
        reply_action: null,
        reply_payload: null,
      };

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "file") {
          tempName = `${uuidv4()}.csv`;
          tempPath = path.join(UPLOAD_DIR, tempName);
          await new Promise((res, rej) => {
            const ws = fs.createWriteStream(tempPath);
            part.file.pipe(ws);
            ws.on("finish", res);
            ws.on("error", rej);
          });
        } else if (part.type === "field") {
          if (part.fieldname === "meta") {
            metaStr = String(part.value || "");
          } else if (
            Object.prototype.hasOwnProperty.call(flat, part.fieldname)
          ) {
            flat[part.fieldname] = String(part.value || "");
          }
        }
      }

      if (!tempPath) {
        const resp = { error: "CSV (campo file) é obrigatório" };
        await fastify.audit(req, {
          action: "campaigns.create.bad_request",
          resourceType: "campaign",
          statusCode: 400,
          requestBody: { meta: metaStr || flat, fileUploaded: !!tempPath },
          responseBody: resp,
        });
        return reply.code(400).send(resp);
      }

      let meta = {};
      if (metaStr) {
        try {
          meta = JSON.parse(metaStr);
        } catch {}
      } else if (flat.name) {
        let comps = null,
          payload = null;
        if (flat.components) {
          try {
            comps = JSON.parse(flat.components);
          } catch {}
        }
        if (flat.reply_payload) {
          try {
            payload = JSON.parse(flat.reply_payload);
          } catch {}
        }

        if (!flat.template_name || !flat.language_code) {
          const resp = {
            error:
              "template_name e language_code são obrigatórios quando não usar meta",
          };
          await fastify.audit(req, {
            action: "campaigns.create.bad_request",
            resourceType: "campaign",
            statusCode: 400,
            requestBody: { meta: flat, fileName: tempName },
            responseBody: resp,
          });
          return reply.code(400).send(resp);
        }
        meta = {
          name: flat.name,
          start_at: flat.start_at || null,
          template: {
            name: flat.template_name,
            language: { code: flat.language_code },
            ...(comps ? { components: comps } : {}),
          },
          ...(flat.reply_action ? { reply_action: flat.reply_action } : {}),
          ...(payload ? { reply_payload: payload } : {}),
        };
      }

      const { name, template, start_at, reply_action, reply_payload } =
        meta || {};
      if (!name) {
        const resp = { error: "name é obrigatório" };
        await fastify.audit(req, {
          action: "campaigns.create.bad_request",
          resourceType: "campaign",
          statusCode: 400,
          requestBody: { meta, fileName: tempName },
          responseBody: resp,
        });
        return reply.code(400).send(resp);
      }
      if (!template?.name || !template?.language?.code) {
        const resp = { error: "template{name, language.code} é obrigatório" };
        await fastify.audit(req, {
          action: "campaigns.create.bad_request",
          resourceType: "campaign",
          statusCode: 400,
          requestBody: { meta, fileName: tempName },
          responseBody: resp,
        });
        return reply.code(400).send(resp);
      }
      if (
        reply_action &&
        !["flow_goto", "open_ticket"].includes(
          String(reply_action).toLowerCase()
        )
      ) {
        const resp = {
          error: "reply_action deve ser 'flow_goto' ou 'open_ticket'",
        };
        await fastify.audit(req, {
          action: "campaigns.create.bad_request",
          resourceType: "campaign",
          statusCode: 400,
          requestBody: { meta, fileName: tempName },
          responseBody: resp,
        });
        return reply.code(400).send(resp);
      }
      if (reply_payload && typeof reply_payload !== "object") {
        const resp = { error: "reply_payload deve ser um objeto JSON" };
        await fastify.audit(req, {
          action: "campaigns.create.bad_request",
          resourceType: "campaign",
          statusCode: 400,
          requestBody: { meta, fileName: tempName },
          responseBody: resp,
        });
        return reply.code(400).send(resp);
      }

      const campaignId = uuidv4();
      const now = new Date();
      const isScheduled = !!start_at && new Date(start_at) > now;
      const startAtVal = isScheduled ? new Date(start_at) : null;
      const statusVal = isScheduled ? "scheduled" : "queued";

      const { rows } = await req.db.query(
        `INSERT INTO campaigns
         (id, name, template_name, language_code, components, start_at, status,
          default_reply_action, default_reply_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
        [
          campaignId,
          name,
          template.name,
          template.language.code,
          template.components || null,
          startAtVal,
          statusVal,
          reply_action || null,
          reply_payload ? JSON.stringify(reply_payload) : null,
        ]
      );

      // ingestão CSV (como você já tem)...
      // supondo que você define estas variáveis no seu bloco de ingestão:
      const inserted = typeof inserted !== "undefined" ? inserted : 0;
      const skipped = typeof skipped !== "undefined" ? skipped : 0;

      const resp = {
        ok: true,
        campaign: rows[0],
        inserted,
        skipped,
        mode: isScheduled ? "scheduled" : "immediate",
        scheduled_for: startAtVal,
        message: isScheduled
          ? "Campanha agendada (scheduler vai disparar no horário)."
          : "Campanha marcada como imediata (scheduler vai disparar agora).",
      };

      // 📝 AUDITORIA (sucesso)
      await fastify.audit(req, {
        action: "campaigns.create",
        resourceType: "campaign",
        resourceId: campaignId,
        requestBody: {
          meta, // o plugin já faz redaction do que for sensível
          fileName: tempName,
        },
        afterData: rows[0],
        responseBody: resp,
        statusCode: 201,
      });

      return reply.code(201).send(resp);
    } catch (err) {
      req.log.error(err, "[campaigns] create");
      const resp = { error: "Erro ao criar campanha" };

      // 📝 AUDITORIA (erro inesperado)
      await fastify.audit(req, {
        action: "campaigns.create.error",
        resourceType: "campaign",
        statusCode: 500,
        responseBody: resp,
        extra: { dbMessage: err.message },
      });

      return reply.code(500).send(resp);
    }
  });
}
