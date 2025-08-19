// ⏸️ Pausar atendimento (mantém sessão)
// PUT /api/v1/atendentes/pause/:email
// body: { reason_id?: string, reason?: string }
fastify.put('/pause/:email', async (req, reply) => {
  const { email } = req.params;
  const { reason_id, reason } = req.body || {};
  if (!email) return reply.code(400).send({ error: 'email é obrigatório' });

  try {
    // resolve motivo
    let finalReason = (reason || '').trim();
    if (!finalReason && reason_id) {
      const r = await req.db.query('SELECT nome FROM pausa_motivos WHERE id = $1 AND ativo = TRUE', [reason_id]);
      if (r.rows.length) finalReason = r.rows[0].nome;
    }
    if (!finalReason) return reply.code(400).send({ error: 'Informe um motivo de pausa (reason_id ou reason)' });

    // atualiza atendente
    const { rowCount } = await req.db.query(
      `UPDATE atendentes
          SET status = 'pausa',
              pause_reason = $2,
              pause_started_at = now()
        WHERE email = $1`,
      [email, finalReason]
    );
    if (!rowCount) return reply.code(404).send({ error: 'Atendente não encontrado' });

    // abre sessão de pausa (histórico)
    await req.db.query(
      `INSERT INTO pausa_sessoes (email, reason, started_at)
       VALUES ($1, $2, now())`,
      [email, finalReason]
    );

    return reply.send({ success: true, email, status: 'pausa', pause_reason: finalReason });
  } catch (err) {
    fastify.log.error(err, '[atendentes] erro ao pausar');
    return reply.code(500).send({ error: 'Erro ao pausar atendente' });
  }
});

// ▶️ Retomar da pausa (mantém sessão; volta a obedecer regra de presença)
// PUT /api/v1/atendentes/resume/:email
fastify.put('/resume/:email', async (req, reply) => {
  const { email } = req.params;
  if (!email) return reply.code(400).send({ error: 'email é obrigatório' });

  try {
    const { rowCount } = await req.db.query(
      `UPDATE atendentes
          SET status = 'online',
              pause_reason = NULL,
              pause_started_at = NULL
        WHERE email = $1`,
      [email]
    );
    if (!rowCount) return reply.code(404).send({ error: 'Atendente não encontrado' });

    // encerra sessão de pausa aberta
    await req.db.query(
      `UPDATE pausa_sessoes
          SET ended_at = now()
        WHERE email = $1
          AND ended_at IS NULL`,
      [email]
    );

    return reply.send({ success: true, email, status: 'online' });
  } catch (err) {
    fastify.log.error(err, '[atendentes] erro ao retomar');
    return reply.code(500).send({ error: 'Erro ao retomar atendente' });
  }
});
