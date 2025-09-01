// routes/billing.js
// Extrato GERAL (por período). NÃO há filtro por user_id.
// Pode exibir cada user_id no resultado, mas sempre traz TODOS.

async function billingRoutes(fastify, _opts) {
  // ========== UTILS ==========
  const SUPPORTED_MODES = new Set(['start', 'activity', 'overlap']);

  function parseISO(name, v) {
    if (!v) throw new Error(`Parâmetro obrigatório: ${name}`);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`Data inválida em ${name}: ${v}`);
    return d.toISOString(); // compatível com timestamptz
  }
  function parseMode(v) {
    const m = (v || 'start').toLowerCase();
    if (!SUPPORTED_MODES.has(m)) throw new Error(`mode inválido: ${v} (use start|activity|overlap)`);
    return m;
  }
  const toBigInt = (x) => (typeof x === 'bigint' ? x : BigInt(x ?? 0));
  const bigMapToString = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v.toString()]));

  // ========== EXTRATO AGREGADO (Geral por user_id+channel) ==========
  // GET /billing/statement?from=...&to=...&mode=start&channel=...
  fastify.get('/billing/statement', async (req, reply) => {
    try {
      const from    = parseISO('from', req.query.from);
      const to      = parseISO('to',   req.query.to);
      if (new Date(from) >= new Date(to)) return reply.code(400).send({ error: 'from deve ser < to' });
      const mode    = parseMode(req.query.mode);
      const channel = req.query.channel || null; // opcional

      // p_user_id = NULL (extrato GERAL)
      const { rows } = await req.db.query(
        'SELECT * FROM hmg.get_billing_statement_sum($1,$2,$3,$4,$5)',
        [from, to, null, channel, mode]
      );

      // Totais por moeda (em string para evitar BigInt no JSON)
      let totalSessions = 0n;
      let totalAmountAll = 0n;
      const totalsByCurrency = {};
      for (const r of rows) {
        totalSessions += toBigInt(r.sessions);
        const cur = r.currency || 'BRL';
        const amt = toBigInt(r.amount_cents);
        totalsByCurrency[cur] = (totalsByCurrency[cur] || 0n) + amt;
        totalAmountAll += amt;
      }

      return reply.send({
        period: { from, to, mode },
        totals: {
          sessions: totalSessions.toString(),
          amount_cents_all_currencies: totalAmountAll.toString(),
          amount_cents_by_currency: bigMapToString(totalsByCurrency)
        },
        // data exibe user_id + channel, mas SEM filtro de user_id
        data: rows
      });
    } catch (err) {
      req.log.error(err, '[billing] statement');
      return reply.code(400).send({ error: err.message || 'Erro no extrato' });
    }
  });

  // ========== EXTRATO DIÁRIO (Geral por dia+canal) ==========
  // GET /billing/statement/daily?from=...&to=...&mode=start|activity&channel=...
  fastify.get('/billing/statement/daily', async (req, reply) => {
    try {
      const from    = parseISO('from', req.query.from);
      const to      = parseISO('to',   req.query.to);
      if (new Date(from) >= new Date(to)) return reply.code(400).send({ error: 'from deve ser < to' });
      const mode    = parseMode(req.query.mode);
      const channel = req.query.channel || null; // opcional

      if (mode === 'overlap') {
        return reply.code(400).send({ error: 'mode=overlap não é suportado no agrupamento diário' });
      }

      const field = mode === 'activity' ? 'last_incoming_at' : 'start_at';
      const params = [from, to];
      let where = `${field} >= $1 AND ${field} < $2`;
      if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }

      const sql = `
        SELECT
          (${field} AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
          channel,
          COUNT(*)::bigint           AS sessions,
          SUM(amount_cents)::bigint  AS amount_cents,
          MAX(currency)              AS currency
        FROM hmg.v_billing_detail_priced
        WHERE ${where}
        GROUP BY 1,2
        ORDER BY 1,2
      `;
      const { rows } = await req.db.query(sql, params);
      return reply.send({ period: { from, to, mode, tz: 'America/Sao_Paulo' }, data: rows });
    } catch (err) {
      req.log.error(err, '[billing] daily');
      return reply.code(400).send({ error: err.message || 'Erro no extrato diário' });
    }
  });

  // ========== DETALHE (lista cada sessão com preço) ==========
  // GET /billing/statement/detail?from=...&to=...&mode=start&channel=...&limit=100&offset=0
  fastify.get('/billing/statement/detail', async (req, reply) => {
    try {
      const from    = parseISO('from', req.query.from);
      const to      = parseISO('to',   req.query.to);
      if (new Date(from) >= new Date(to)) return reply.code(400).send({ error: 'from deve ser < to' });
      const mode    = parseMode(req.query.mode);
      const channel = req.query.channel || null; // opcional
      const limit   = Math.min(Number(req.query.limit || 200), 1000);
      const offset  = Math.max(Number(req.query.offset || 0), 0);

      const params = [from, to];
      let where;

      if (mode === 'start') {
        where = `start_at >= $1 AND start_at < $2`;
      } else if (mode === 'activity') {
        where = `last_incoming_at >= $1 AND last_incoming_at < $2`;
      } else {
        where = `start_at < $2 AND window_end > $1`;
      }
      if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }

      const sql = `
        SELECT user_id, channel, start_at, window_end, last_incoming_at,
               price_cents, amount_cents, currency
        FROM hmg.v_billing_detail_priced
        WHERE ${where}
        ORDER BY start_at, user_id, channel
        LIMIT ${limit} OFFSET ${offset}
      `;
      const { rows } = await req.db.query(sql, params);
      return reply.send({
        period: { from, to, mode },
        paging: { limit, offset, returned: rows.length },
        // data exibe cada sessão (com user_id), mas SEM filtro de user_id
        data: rows
      });
    } catch (err) {
      req.log.error(err, '[billing] detail');
      return reply.code(400).send({ error: err.message || 'Erro no detalhe do extrato' });
    }
  });

  // ========== PRICING (public.billing_pricing) ==========
  // Listar preços
  fastify.get('/billing/pricing', async (_req, reply) => {
    try {
      const { rows } = await req.db.query(
        `SELECT channel, price_cents, currency
           FROM public.billing_pricing
          ORDER BY channel`
      );
      return reply.send(rows);
    } catch (err) {
      _req.log.error(err, '[billing] pricing list');
      return reply.code(500).send({ error: 'Erro ao listar preços' });
    }
  });

  // Buscar preço de um canal
  fastify.get('/billing/pricing/:channel', async (req, reply) => {
    const { channel } = req.params;
    try {
      const { rows } = await req.db.query(
        `SELECT channel, price_cents, currency
           FROM public.billing_pricing
          WHERE channel = $1`,
        [channel]
      );
      if (!rows.length) return reply.code(404).send({ error: 'Canal não encontrado' });
      return reply.send(rows[0]);
    } catch (err) {
      req.log.error(err, '[billing] pricing get one');
      return reply.code(500).send({ error: 'Erro ao buscar preço' });
    }
  });

  // UPSERT de preço (por channel)
  fastify.post('/billing/pricing', async (req, reply) => {
    const { channel, price_cents, currency = 'BRL' } = req.body || {};
    if (!channel || typeof price_cents === 'undefined') {
      return reply.code(400).send({ error: 'channel e price_cents são obrigatórios' });
    }
    try {
      const { rows } = await req.db.query(
        `INSERT INTO public.billing_pricing (channel, price_cents, currency)
         VALUES ($1,$2,$3)
         ON CONFLICT (channel) DO UPDATE
           SET price_cents = EXCLUDED.price_cents,
               currency    = EXCLUDED.currency
         RETURNING channel, price_cents, currency`,
        [channel, price_cents, currency]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      req.log.error(err, '[billing] pricing upsert');
      return reply.code(500).send({ error: 'Erro ao salvar preço' });
    }
  });

  // PUT preço
  fastify.put('/billing/pricing/:channel', async (req, reply) => {
    const { channel } = req.params;
    const { price_cents, currency = 'BRL' } = req.body || {};
    if (typeof price_cents === 'undefined') {
      return reply.code(400).send({ error: 'price_cents é obrigatório' });
    }
    try {
      const { rowCount } = await req.db.query(
        `UPDATE public.billing_pricing
            SET price_cents=$2, currency=$3
          WHERE channel=$1`,
        [channel, price_cents, currency]
      );
      if (!rowCount) return reply.code(404).send({ error: 'Canal não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[billing] pricing put');
      return reply.code(500).send({ error: 'Erro ao atualizar preço' });
    }
  });

  // PATCH preço
  fastify.patch('/billing/pricing/:channel', async (req, reply) => {
    const { channel } = req.params;
    const { price_cents, currency } = req.body || {};
    const sets = [];
    const vals = [channel];
    let idx = 2;
    if (typeof price_cents !== 'undefined') { sets.push(`price_cents=$${idx++}`); vals.push(price_cents); }
    if (typeof currency    !== 'undefined') { sets.push(`currency=$${idx++}`);    vals.push(currency); }
    if (!sets.length) return reply.code(400).send({ error: 'Nada para atualizar' });

    try {
      const { rowCount } = await req.db.query(
        `UPDATE public.billing_pricing
            SET ${sets.join(', ')}
          WHERE channel=$1`,
        vals
      );
      if (!rowCount) return reply.code(404).send({ error: 'Canal não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[billing] pricing patch');
      return reply.code(500).send({ error: 'Erro ao atualizar preço' });
    }
  });

  // DELETE preço
  fastify.delete('/billing/pricing/:channel', async (req, reply) => {
    const { channel } = req.params;
    try {
      const { rowCount } = await req.db.query(
        `DELETE FROM public.billing_pricing WHERE channel=$1`,
        [channel]
      );
      if (!rowCount) return reply.code(404).send({ error: 'Canal não encontrado' });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err, '[billing] pricing delete');
      return reply.code(500).send({ error: 'Erro ao remover preço' });
    }
  });
}

export default billingRoutes;
