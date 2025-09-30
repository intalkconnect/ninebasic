// routes/queueRules.js
import {
  getAllQueueRules,
  getQueueRule,
  upsertQueueRule,
  deleteQueueRule
} from '../engine/services/queueRulesStore.js';

async function queueRulesRoutes(fastify) {
  // Lista todas as regras
  fastify.get('/', async (req, reply) => {
    try {
      const rows = await getAllQueueRules();
      return reply.send({ data: rows });
    } catch (err) {
      fastify.log.error(err, 'GET /queue-rules');
      return reply.code(500).send({ error: 'Erro ao listar regras' });
    }
  });

  // Obter regra por fila
  fastify.get('/:queue_name', async (req, reply) => {
    const queue = String(req.params?.queue_name || '').trim();
    if (!queue) return reply.code(400).send({ error: 'queue_name é obrigatório' });
    try {
      const row = await getQueueRule(queue);
      if (!row) return reply.code(404).send({ error: 'Regra não encontrada' });
      return reply.send({ data: row });
    } catch (err) {
      fastify.log.error(err, 'GET /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao obter regra' });
    }
  });

  // Criar/Atualizar regra da fila (upsert)
  fastify.put('/:queue_name', async (req, reply) => {
    const queue = String(req.params?.queue_name || '').trim();
    if (!queue) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    let { enabled = true, conditions = [] } = req.body || {};
    if (!Array.isArray(conditions)) {
      return reply.code(400).send({ error: 'conditions deve ser um array' });
    }

    try {
      const row = await upsertQueueRule(queue, { enabled: !!enabled, conditions });
      return reply.send({ data: row });
    } catch (err) {
      fastify.log.error(err, 'PUT /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao salvar regra' });
    }
  });

  // Excluir regra da fila
  fastify.delete('/:queue_name', async (req, reply) => {
    const queue = String(req.params?.queue_name || '').trim();
    if (!queue) return reply.code(400).send({ error: 'queue_name é obrigatório' });

    try {
      const deleted = await deleteQueueRule(queue);
      if (!deleted) return reply.code(404).send({ error: 'Regra não encontrada' });
      return reply.send({ ok: true, queue_name: deleted });
    } catch (err) {
      fastify.log.error(err, 'DELETE /queue-rules/:queue_name');
      return reply.code(500).send({ error: 'Erro ao excluir regra' });
    }
  });
}

export default queueRulesRoutes;
