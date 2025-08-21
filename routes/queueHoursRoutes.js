// src/routes/queueHoursRoutes.js
import {
  withTenant,
  extractSubdomain,
  lookupSchemaBySubdomain,
} from '../services/db.js';

/* helpers locais */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') throw new Error('Horário inválido');
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('Formato deve ser HH:MM');
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error('Hora/minuto inválidos');
  return hh * 60 + mm;
}
function fromMinutes(min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}`;
}
function normalizeWeekly(weekly = []) {
  // Espera: [{ weekday:1..7, windows:[{start:"HH:MM", end:"HH:MM"}] }]
  const out = [];
  for (const d of weekly) {
    if (!d || typeof d.weekday !== 'number') continue;
    const weekday = d.weekday | 0;
    if (weekday < 1 || weekday > 7) throw new Error('weekday deve ser 1..7 (ISO: 1=Seg ... 7=Dom)');
    const wins = Array.isArray(d.windows) ? d.windows : [];
    for (const w of wins) {
      const start_minute = toMinutes(w.start);
      const end_minute = toMinutes(w.end);
      if (!(end_minute > start_minute)) throw new Error('end deve ser > start');
      out.push({ weekday, start_minute, end_minute });
    }
  }
  return out;
}

/* resolve schema do tenant a partir do Host; fallback hmg */
async function resolveSchemaFromReq(req) {
  try {
    // se sua infra já decorou req.tenantSchema, respeita
    if (req.tenantSchema) return req.tenantSchema;

    const sub = extractSubdomain(req.headers.host, process.env.BASE_DOMAIN);
    if (!sub) return 'hmg';
    const schema = await lookupSchemaBySubdomain(sub);
    return schema || 'hmg';
  } catch {
    return 'hmg';
  }
}

/* compacta para o formato do front (weekly/holidays) */
async function loadConfig(client, queueName) {
  const cfg = await client.query(
    `SELECT queue_name, tz, enabled, pre_service_message, offhours_message, updated_at
       FROM queue_hours WHERE queue_name = $1`,
    [queueName]
  );

  if (cfg.rowCount === 0) {
    return {
      queue_name: queueName,
      tz: 'America/Sao_Paulo',
      enabled: false,
      pre_service_message: '',
      offhours_message: '',
      weekly: [],
      holidays: [],
    };
    }

  const row = cfg.rows[0];

  const rules = await client.query(
    `SELECT weekday, start_minute, end_minute
       FROM queue_hours_rules
      WHERE queue_name = $1
      ORDER BY weekday, start_minute`,
    [queueName]
  );

  const hols = await client.query(
    `SELECT holiday_date AS date, COALESCE(name,'') AS name
       FROM queue_holidays
      WHERE queue_name = $1
      ORDER BY holiday_date`,
    [queueName]
  );

  // agrupa por dia
  const weeklyMap = new Map();
  for (const r of rules.rows) {
    const arr = weeklyMap.get(r.weekday) || [];
    arr.push({ start: fromMinutes(r.start_minute), end: fromMinutes(r.end_minute) });
    weeklyMap.set(r.weekday, arr);
  }
  const weekly = [...weeklyMap.entries()].map(([weekday, windows]) => ({ weekday, windows }));

  return {
    queue_name: row.queue_name,
    tz: row.tz,
    enabled: row.enabled,
    pre_service_message: row.pre_service_message || '',
    offhours_message: row.offhours_message || '',
    weekly,
    holidays: hols.rows,
  };
}

/* calcula status agora (ou numa data) e próxima abertura */
async function testNow(client, queueName, tsOverride /* ISO opcional */) {
  // carrega cfg
  const cfg = await loadConfig(client, queueName);
  if (!cfg.enabled) {
    return {
      offhours: true,
      reason: 'closed',
      local_ts: null,
      local_tz: cfg.tz,
      next_open_local: null,
    };
  }

  // hora local na TZ da fila
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

  // feriado hoje?
  const fer = await client.query(
    `SELECT 1 FROM queue_holidays WHERE queue_name=$1 AND holiday_date=$2::date`,
    [queueName, localDate]
  );
  if (fer.rowCount > 0) {
    return {
      offhours: true,
      reason: 'holiday',
      local_ts: localTs,
      local_tz: cfg.tz,
      next_open_local: await findNextOpenLocal(client, queueName, cfg.tz, dow, minutes),
    };
  }

  // regra do dia
  const dayRules = await client.query(
    `SELECT start_minute, end_minute
       FROM queue_hours_rules
      WHERE queue_name=$1 AND weekday=$2
      ORDER BY start_minute`,
    [queueName, dow]
  );

  let openNow = false;
  for (const r of dayRules.rows) {
    if (minutes >= r.start_minute && minutes < r.end_minute) {
      openNow = true; break;
    }
  }

  if (openNow) {
    return {
      offhours: false,
      reason: 'open',
      local_ts: localTs,
      local_tz: cfg.tz,
      next_open_local: null,
    };
  }

  // fechado (fora do horário)
  return {
    offhours: true,
    reason: 'closed',
    local_ts: localTs,
    local_tz: cfg.tz,
    next_open_local: await findNextOpenLocal(client, queueName, cfg.tz, dow, minutes),
  };
}

async function findNextOpenLocal(client, queueName, tz, dow, minutes) {
  // tenta hoje (próxima janela no mesmo dia)
  const today = await client.query(
    `SELECT start_minute
       FROM queue_hours_rules
      WHERE queue_name=$1 AND weekday=$2 AND start_minute > $3
      ORDER BY start_minute
      LIMIT 1`,
    [queueName, dow, minutes]
  );
  if (today.rowCount > 0) {
    const start = fromMinutes(today.rows[0].start_minute);
    const d = await client.query(
      `SELECT TO_CHAR((now() AT TIME ZONE $1), 'YYYY-MM-DD') AS d`,
      [tz]
    );
    return `${d.rows[0].d} ${start}`;
  }

  // próximos dias (até +6)
  for (let i = 1; i <= 6; i++) {
    const nextDow = ((dow - 1 + i) % 7) + 1; // 1..7
    const hol = await client.query(
      `SELECT 1
         FROM queue_holidays
        WHERE queue_name=$1
          AND holiday_date = ( (now() AT TIME ZONE $2)::date + $3::int )`,
      [queueName, tz, i]
    );
    if (hol.rowCount > 0) continue;

    const r = await client.query(
      `SELECT start_minute
         FROM queue_hours_rules
        WHERE queue_name=$1 AND weekday=$2
        ORDER BY start_minute
        LIMIT 1`,
      [queueName, nextDow]
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
  // GET /queues/:queue/hours  → carrega config
  fastify.get('/:queue/hours', async (req, reply) => {
    const queueName = req.params.queue;
    try {
      const schema = await resolveSchemaFromReq(req);

      const data = await withTenant(schema, async (client) => {
        return await loadConfig(client, queueName);
      });

      return reply.send(data);
    } catch (error) {
      fastify.log.error('Erro ao buscar horários da fila:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar horários da fila',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  // POST /queues/:queue/hours  → cria/atualiza config completa (upsert)
  fastify.post('/:queue/hours', async (req, reply) => {
    const queueName = req.params.queue;
    const {
      tz = 'America/Sao_Paulo',
      enabled = true,
      pre_service_message = '',
      offhours_message = '',
      weekly = [],
      holidays = [],
    } = req.body || {};

    try {
      const schema = await resolveSchemaFromReq(req);
      const flatRules = normalizeWeekly(weekly);

      const data = await withTenant(schema, async (client) => {
        // upsert queue_hours
        await client.query(
          `INSERT INTO queue_hours (queue_name, tz, enabled, pre_service_message, offhours_message)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (queue_name) DO UPDATE
             SET tz=$2, enabled=$3, pre_service_message=$4, offhours_message=$5, updated_at=now()`,
          [queueName, tz, enabled, pre_service_message, offhours_message]
        );

        // replace rules
        await client.query(`DELETE FROM queue_hours_rules WHERE queue_name=$1`, [queueName]);
        for (const r of flatRules) {
          await client.query(
            `INSERT INTO queue_hours_rules (queue_name, weekday, start_minute, end_minute)
             VALUES ($1,$2,$3,$4)`,
            [queueName, r.weekday, r.start_minute, r.end_minute]
          );
        }

        // replace holidays (simples)
        await client.query(`DELETE FROM queue_holidays WHERE queue_name=$1`, [queueName]);
        for (const h of holidays || []) {
          if (!h?.date) continue;
          await client.query(
            `INSERT INTO queue_holidays (queue_name, holiday_date, name)
             VALUES ($1,$2,$3)
             ON CONFLICT (queue_name, holiday_date) DO UPDATE SET name=EXCLUDED.name`,
            [queueName, h.date, h.name || '']
          );
        }

        return await loadConfig(client, queueName);
      });

      return reply.code(201).send(data);
    } catch (error) {
      fastify.log.error('Erro ao salvar horários da fila:', error);
      return reply.code(400).send({
        error: 'Payload inválido ao salvar horários da fila',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  // POST /queues/:queue/hours/test  → { offhours, reason, local_ts, local_tz, next_open_local }
  fastify.post('/:queue/hours/test', async (req, reply) => {
    const queueName = req.params.queue;
    const ts = req.body?.ts || req.query?.ts || null;
    try {
      const schema = await resolveSchemaFromReq(req);

      const out = await withTenant(schema, async (client) => {
        return await testNow(client, queueName, ts);
      });

      return reply.send(out);
    } catch (error) {
      fastify.log.error('Erro ao testar horários da fila:', error);
      return reply.code(500).send({
        error: 'Erro interno ao testar horários da fila',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });
}

export default queueHoursRoutes;
