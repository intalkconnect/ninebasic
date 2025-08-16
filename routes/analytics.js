// routes/analytics.js
export default async function analyticsRoutes(fastify, opts) {
  fastify.get('/realtime', async (req, reply) => {
    try {
      const { rows } = await req.db.query(`
        SELECT
          c.name AS cliente,
          c.channel,
          COALESCE(a.name || ' ' || a.lastname, NULL) AS agente,
          t.fila,
          t.assigned_to,
          t.ticket_number,
          t.created_at AS inicio_conversa,
          CASE
            WHEN t.assigned_to IS NULL THEN 'aguardando'
            ELSE 'em_atendimento'
          END AS status,
          EXTRACT(EPOCH FROM (now() - t.created_at)) / 60 AS tempo_espera
        FROM tickets t
        JOIN clientes c ON c.user_id = t.user_id
        LEFT JOIN atendentes a ON a.email::text = t.assigned_to
        WHERE t.status = 'open'
        ORDER BY t.created_at;
      `);

      const mapped = rows.map((a, index) => ({
        id: index + 1,
        cliente: a.cliente,
        canal: a.channel,
        agente: a.agente,
        tempoEspera: Math.floor(a.tempo_espera),
        status: a.status,
        prioridade: 'normal', // coloque sua heurística se quiser
        fila: a.fila,
        posicaoFila: null,
        inicioConversa: a.inicio_conversa,
      }));

      return reply.send(mapped);
    } catch (err) {
      req.log.error(err, '[analytics] erro ao buscar atendimentos');
      return reply.status(500).send({ error: 'Erro ao buscar atendimentos' });
    }
  });
}
