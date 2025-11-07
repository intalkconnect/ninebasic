// src/routes/queueHoursRoutes.js
import {
  withTenant,
  extractSubdomain,
  lookupSchemaBySubdomain,
} from "../services/db.js";

/* helpers locais */
function toMinutes(hhmm) {
  if (typeof hhmm !== "string") throw new Error("Horário inválido");
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error("Formato deve ser HH:MM");
  const hh = Number(m[1]),
    mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
    throw new Error("Hora/minuto inválidos");
  return hh * 60 + mm;
}
function fromMinutes(min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}`;
}
function normalizeWeekly(weekly = []) {
  // Espera: [{ weekday:1..7, windows:[{start:"HH:MM", end:"HH:MM"}] }]
  const out = [];
  for (const d of weekly) {
    if (!d || typeof d.weekday !== "number") continue;
    const weekday = d.weekday | 0;
    if (weekday < 1 || weekday > 7)
      throw new Error("weekday deve ser 1..7 (ISO: 1=Seg ... 7=Dom)");
    const wins = Array.isArray(d.windows) ? d.windows : [];
    for (const w of wins) {
      const start_minute = toMinutes(w.start);
      const end_minute = toMinutes(w.end);
      if (!(end_minute > start_minute)) throw new Error("end deve ser > start");
      out.push({ weekday, start_minute, end_minute });
    }
  }
  return out;
}

/** Converte payload {mon..sun:[{start,end}]} -> weekly[{weekday,windows}] */
function windowsToWeekly(w = {}) {
  const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  const weekly = [];
  for (const key of Object.keys(map)) {
    const arr = Array.isArray(w[key]) ? w[key] : [];
    if (arr.length === 0) continue;
    weekly.push({ weekday: map[key], windows: arr });
  }
  // ordena por weekday
  weekly.sort((a, b) => a.weekday - b.weekday);
  return weekly;
}

/* resolve schema do tenant a partir do Host; fallback hmg */
async function resolveSchemaFromReq(req) {
  try {
    if (req.tenantSchema) return req.tenantSchema;
    const sub = extractSubdomain(req.headers.host, process.env.BASE_DOMAIN);
    if (!sub) return "hmg";
    const schema = await lookupSchemaBySubdomain(sub);
    return schema || "hmg";
  } catch {
    return "hmg";
  }
}

/* compacta para o formato do front (weekly/holidays) */
async function loadConfig(client, queueName, flowId = null) {
  const cfg = await client.query(
    `SELECT queue_name, flow_id, tz, enabled, pre_service_message, offhours_message, updated_at
       FROM queue_hours
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2`,
    [queueName, flowId]
  );

  if (cfg.rowCount === 0) {
    return {
      queue_name: queueName,
      flow_id: flowId,
      tz: "America/Sao_Paulo",
      enabled: false,
      pre_service_message: "",
      offhours_message: "",
      weekly: [],
      holidays: [],
    };
  }

  const row = cfg.rows[0];

  const rules = await client.query(
    `SELECT weekday, start_minute, end_minute
       FROM queue_hours_rules
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2
      ORDER BY weekday, start_minute`,
    [queueName, flowId]
  );

  const hols = await client.query(
    `SELECT holiday_date AS date, COALESCE(name,'') AS name
       FROM queue_holidays
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2
      ORDER BY holiday_date`,
    [queueName, flowId]
  );

  const weeklyMap = new Map();
  for (const r of rules.rows) {
    const arr = weeklyMap.get(r.weekday) || [];
    arr.push({
      start: fromMinutes(r.start_minute),
      end: fromMinutes(r.end_minute),
    });
    weeklyMap.set(r.weekday, arr);
  }
  const weekly = [...weeklyMap.entries()].map(([weekday, windows]) => ({
    weekday,
    windows,
  }));

  return {
    queue_name: row.queue_name,
    flow_id: row.flow_id,
    tz: row.tz,
    enabled: row.enabled,
    pre_service_message: row.pre_service_message || "",
    offhours_message: row.offhours_message || "",
    weekly,
    holidays: hols.rows,
  };
}

/* calcula status agora (ou numa data) e próxima abertura */
async function testNow(client, queueName, tsOverride /* ISO opcional */, flowId = null) {
  const cfg = await loadConfig(client, queueName, flowId);
  if (!cfg.enabled) {
    return {
      offhours: true,
      reason: "closed",
      local_ts: null,
      local_tz: cfg.tz,
      next_open_local: null,
      flow_id: flowId,
    };
  }

  const q = await client.query(
    `SELECT
       (COALESCE($2::timestamptz, now()) AT TIME ZONE $1) AS local_ts,
       EXTRACT(ISODOW FROM (COALESCE($2::timestamptz, now()) AT TIME ZONE $1))::int AS dow,
       (
         EXTRACT(HOUR   FROM (COALESCE($2::timestamptz, now()) AT TIME ZONE $1))::int * 60
         + EXTRACT(MINUTE FROM (COALESCE($2::timestamptz, now()) AT TIME ZONE $1))::int
       ) AS minutes_local,
       TO_CHAR((COALESCE($2::timestamptz, now()) AT TIME ZONE $1), 'YYYY-MM-DD') AS local_date
     `,
    [cfg.tz, tsOverride || null]
  );

  const localTs = q.rows[0].local_ts;
  const dow = q.rows[0].dow;
  const minutes = q.rows[0].minutes_local;
  const localDate = q.rows[0].local_date;

  const fer = await client.query(
    `SELECT 1
       FROM queue_holidays
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2
        AND holiday_date = $3::date`,
    [queueName, flowId, localDate]
  );
  if (fer.rowCount > 0) {
    return {
      offhours: true,
      reason: "holiday",
      local_ts: localTs,
      local_tz: cfg.tz,
      next_open_local: await findNextOpenLocal(
        client,
        queueName,
        cfg.tz,
        dow,
        minutes,
        flowId
      ),
      flow_id: flowId,
    };
  }

  const dayRules = await client.query(
    `SELECT start_minute, end_minute
       FROM queue_hours_rules
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2
        AND weekday = $3
      ORDER BY start_minute`,
    [queueName, flowId, dow]
  );

  let openNow = false;
  for (const r of dayRules.rows) {
    if (minutes >= r.start_minute && minutes < r.end_minute) {
      openNow = true;
      break;
    }
  }

  if (openNow) {
    return {
      offhours: false,
      reason: "open",
      local_ts: localTs,
      local_tz: cfg.tz,
      next_open_local: null,
      flow_id: flowId,
    };
  }

  return {
    offhours: true,
    reason: "closed",
    local_ts: localTs,
    local_tz: cfg.tz,
    next_open_local: await findNextOpenLocal(
      client,
      queueName,
      cfg.tz,
      dow,
      minutes,
      flowId
    ),
    flow_id: flowId,
  };
}

async function findNextOpenLocal(client, queueName, tz, dow, minutes, flowId = null) {
  const today = await client.query(
    `SELECT start_minute
       FROM queue_hours_rules
      WHERE queue_name = $1
        AND flow_id IS NOT DISTINCT FROM $2
        AND weekday = $3
        AND start_minute > $4
      ORDER BY start_minute
      LIMIT 1`,
    [queueName, flowId, dow, minutes]
  );
  if (today.rowCount > 0) {
    const start = fromMinutes(today.rows[0].start_minute);
    const d = await client.query(
      `SELECT TO_CHAR((now() AT TIME ZONE $1), 'YYYY-MM-DD') AS d`,
      [tz]
    );
    return `${d.rows[0].d} ${start}`;
  }

  for (let i = 1; i <= 6; i++) {
    const nextDow = ((dow - 1 + i) % 7) + 1;
    const hol = await client.query(
      `SELECT 1
         FROM queue_holidays
        WHERE queue_name = $1
          AND flow_id IS NOT DISTINCT FROM $2
          AND holiday_date = ( (now() AT TIME ZONE $3)::date + $4::int )`,
      [queueName, flowId, tz, i]
    );
    if (hol.rowCount > 0) continue;

    const r = await client.query(
      `SELECT start_minute
         FROM queue_hours_rules
        WHERE queue_name = $1
          AND flow_id IS NOT DISTINCT FROM $2
          AND weekday = $3
        ORDER BY start_minute
        LIMIT 1`,
      [queueName, flowId, nextDow]
    );
    if (r.rowCount > 0) {
      const start = fromMinutes(r.rows[0].start_minute);
      const d = await client.query(
        `SELECT TO_CHAR(((now() AT TIME ZONE $1)::date + $2::int), 'YYYY-MM-DD') AS d`,
        [tz, i]
      );
      return `${d.rows[0].d} ${start}`;
    }
  }
  return null;
}

/* =========================
 * Plugin Fastify
 * ========================= */
async function queueHoursRoutes(fastify, options) {
  // GET /queues/:queue/hours
  // aceita ?flow_id=
  fastify.get("/:queue/hours", async (req, reply) => {
    const queueName = req.params.queue;
    const flowId = req.query?.flow_id ?? null;

    try {
      const schema = await resolveSchemaFromReq(req);
      const data = await withTenant(
        schema,
        async (client) => await loadConfig(client, queueName, flowId)
      );
      return reply.send(data);
    } catch (error) {
      fastify.log.error("Erro ao buscar horários da fila:", error);
      return reply.code(500).send({
        error: "Erro interno ao buscar horários da fila",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  });

  // POST /queues/:queue/hours  (upsert)
  // aceita flow_id no body e/ou query (?flow_id=)
  fastify.post("/:queue/hours", async (req, reply) => {
    const queueName = req.params.queue;
    const flowId = req.query?.flow_id ?? req.body?.flow_id ?? null;

    const {
      tz = "America/Sao_Paulo",
      enabled = true,
      pre_service_message = "",
      offhours_message = "",
      weekly = [],
      holidays = [],
    } = req.body || {};

    let beforeCfg = null;
    let afterCfg = null;
    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    try {
      const schema = await resolveSchemaFromReq(req);
      const flatRules = normalizeWeekly(weekly);

      // snapshot ANTES
      beforeCfg = await withTenant(schema, async (client) => {
        try {
          return await loadConfig(client, queueName, flowId);
        } catch {
          return null;
        }
      });

      // gravação + snapshot DEPOIS
      const data = await withTenant(schema, async (client) => {
        await client.query(
          `INSERT INTO queue_hours (queue_name, flow_id, tz, enabled, pre_service_message, offhours_message)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (queue_name, flow_id) DO UPDATE
             SET tz=$3, enabled=$4, pre_service_message=$5, offhours_message=$6, updated_at=now()`,
          [queueName, flowId, tz, enabled, pre_service_message, offhours_message]
        );

        await client.query(
          `DELETE FROM queue_hours_rules
            WHERE queue_name=$1
              AND flow_id IS NOT DISTINCT FROM $2`,
          [queueName, flowId]
        );
        for (const r of flatRules) {
          await client.query(
            `INSERT INTO queue_hours_rules (queue_name, flow_id, weekday, start_minute, end_minute)
             VALUES ($1,$2,$3,$4,$5)`,
            [queueName, flowId, r.weekday, r.start_minute, r.end_minute]
          );
        }

        await client.query(
          `DELETE FROM queue_holidays
            WHERE queue_name=$1
              AND flow_id IS NOT DISTINCT FROM $2`,
          [queueName, flowId]
        );
        for (const h of holidays || []) {
          if (!h?.date) continue;
          await client.query(
            `INSERT INTO queue_holidays (queue_name, flow_id, holiday_date, name)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (queue_name, flow_id, holiday_date)
             DO UPDATE SET name=EXCLUDED.name`,
            [queueName, flowId, h.date, h.name || ""]
          );
        }

        return await loadConfig(client, queueName, flowId);
      });

      afterCfg = data;

      // 🔎 AUDIT OK
      await fastify.audit(req, {
        action: "queue.hours.upsert",
        resourceType: "queue",
        resourceId,
        statusCode: 201,
        requestBody: {
          flow_id: flowId,
          tz,
          enabled,
          pre_service_message,
          offhours_message,
          weekly,
          holidays,
        },
        responseBody: afterCfg,
        beforeData: beforeCfg,
        afterData: afterCfg,
      });

      return reply.code(201).send(data);
    } catch (error) {
      fastify.log.error("Erro ao salvar horários da fila:", error);

      const resp = {
        error: "Payload inválido ao salvar horários da fila",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      };

      // 🔎 AUDIT ERRO
      await fastify.audit(req, {
        action: "queue.hours.upsert.error",
        resourceType: "queue",
        resourceId,
        statusCode: 400,
        requestBody: {
          flow_id: flowId,
          tz,
          enabled,
          pre_service_message,
          offhours_message,
          weekly,
          holidays,
        },
        responseBody: resp,
        beforeData: beforeCfg,
        afterData: afterCfg,
      });

      return reply.code(400).send(resp);
    }
  });

  // PUT /queues/:queue/hours  (upsert — aceita weekly **ou** windows)
  // aceita flow_id no body e/ou query (?flow_id=)
  fastify.put("/:queue/hours", async (req, reply) => {
    const queueName = req.params.queue;
    const flowId = req.query?.flow_id ?? req.body?.flow_id ?? null;

    // aceita os dois formatos de nomes
    const tzInput = req.body?.timezone || req.body?.tz || "America/Sao_Paulo";
    const enabled = req.body?.enabled ?? true;
    const preMsg = req.body?.pre_message ?? req.body?.pre_service_message ?? "";
    const offMsg = req.body?.off_message ?? req.body?.offhours_message ?? "";
    let weekly = Array.isArray(req.body?.weekly)
      ? req.body.weekly
      : windowsToWeekly(req.body?.windows || {});
    const holidays = Array.isArray(req.body?.holidays) ? req.body.holidays : [];

    let beforeCfg = null;
    let afterCfg = null;
    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    try {
      const schema = await resolveSchemaFromReq(req);
      const flatRules = normalizeWeekly(weekly);

      // snapshot ANTES
      beforeCfg = await withTenant(schema, async (client) => {
        try {
          return await loadConfig(client, queueName, flowId);
        } catch {
          return null;
        }
      });

      // gravação + snapshot DEPOIS
      const data = await withTenant(schema, async (client) => {
        await client.query(
          `INSERT INTO queue_hours (queue_name, flow_id, tz, enabled, pre_service_message, offhours_message)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (queue_name, flow_id) DO UPDATE
             SET tz=$3, enabled=$4, pre_service_message=$5, offhours_message=$6, updated_at=now()`,
          [queueName, flowId, tzInput, enabled, preMsg, offMsg]
        );

        await client.query(
          `DELETE FROM queue_hours_rules
            WHERE queue_name=$1
              AND flow_id IS NOT DISTINCT FROM $2`,
          [queueName, flowId]
        );
        for (const r of flatRules) {
          await client.query(
            `INSERT INTO queue_hours_rules (queue_name, flow_id, weekday, start_minute, end_minute)
             VALUES ($1,$2,$3,$4,$5)`,
            [queueName, flowId, r.weekday, r.start_minute, r.end_minute]
          );
        }

        await client.query(
          `DELETE FROM queue_holidays
            WHERE queue_name=$1
              AND flow_id IS NOT DISTINCT FROM $2`,
          [queueName, flowId]
        );
        for (const h of holidays) {
          if (!h?.date) continue;
          await client.query(
            `INSERT INTO queue_holidays (queue_name, flow_id, holiday_date, name)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (queue_name, flow_id, holiday_date)
             DO UPDATE SET name=EXCLUDED.name`,
            [queueName, flowId, h.date, h.name || ""]
          );
        }

        return await loadConfig(client, queueName, flowId);
      });

      afterCfg = data;

      // 🔎 AUDIT OK
      await fastify.audit(req, {
        action: "queue.hours.update",
        resourceType: "queue",
        resourceId,
        statusCode: 200,
        requestBody: {
          flow_id: flowId,
          tz: tzInput,
          enabled,
          pre_service_message: preMsg,
          offhours_message: offMsg,
          weekly,
          holidays,
        },
        responseBody: afterCfg,
        beforeData: beforeCfg,
        afterData: afterCfg,
      });

      return reply.send(data);
    } catch (error) {
      fastify.log.error("Erro ao atualizar horários da fila (PUT):", error);

      const resp = {
        error: "Payload inválido ao atualizar horários da fila",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      };

      // 🔎 AUDIT ERRO
      await fastify.audit(req, {
        action: "queue.hours.update.error",
        resourceType: "queue",
        resourceId,
        statusCode: 400,
        requestBody: {
          flow_id: flowId,
          tz: tzInput,
          enabled,
          pre_service_message: preMsg,
          offhours_message: offMsg,
          weekly,
          holidays,
        },
        responseBody: resp,
        beforeData: beforeCfg,
        afterData: afterCfg,
      });

      return reply.code(400).send(resp);
    }
  });

  // POST /queues/:queue/hours/test
  // aceita ?flow_id= e/ou body.flow_id
  fastify.post("/:queue/hours/test", async (req, reply) => {
    const queueName = req.params.queue;
    const ts = req.body?.ts ?? req.query?.ts ?? null;
    const flowId = req.query?.flow_id ?? req.body?.flow_id ?? null;
    const resourceId = flowId ? `${queueName}@${flowId}` : queueName;

    try {
      const schema = await resolveSchemaFromReq(req);
      const out = await withTenant(
        schema,
        async (client) => await testNow(client, queueName, ts, flowId)
      );

      // 🔎 AUDIT (sucesso)
      await fastify.audit(req, {
        action: "queue.hours.test",
        resourceType: "queue",
        resourceId,
        statusCode: 200,
        requestBody: { ts, flow_id: flowId },
        responseBody: out,
      });

      return reply.send(out);
    } catch (error) {
      fastify.log.error("Erro ao testar horários da fila:", error);

      const resp = {
        error: "Erro interno ao testar horários da fila",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      };

      // 🔎 AUDIT (erro)
      await fastify.audit(req, {
        action: "queue.hours.test.error",
        resourceType: "queue",
        resourceId,
        statusCode: 500,
        requestBody: { ts, flow_id: flowId },
        responseBody: resp,
      });

      return reply.code(500).send(resp);
    }
  });
}

export default queueHoursRoutes;
