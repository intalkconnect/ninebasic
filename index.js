// endpoints.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';

// plugin que resolve o tenant pelo Host e expõe req.db/query/tx
import tenantPlugin from './plugins/tenant.js';

// rotas
import messageRoutes from './routes/messages.js';
import flowRoutes from './routes/flow.js';
import uploadRoutes from './routes/uploadRoutes.js';
import clientesRoutes from './routes/clientes.js';
import settingsRoutes from './routes/settings.js';
import ticketsRoutes from './routes/tickets.js';
import chatsRoutes from './routes/chats.js';
import filaRoutes from './routes/filas.js';
import atendentesRoutes from './routes/atendentes.js';
import quickRepliesRoutes from './routes/quickReplies.js';
import analyticsRoutes from './routes/analytics.js';

dotenv.config();

async function buildServer() {
  const fastify = Fastify({
    logger: true,
  });

  // CORS (ajuste origin conforme seu front)
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // suporte a multipart/form-data (uploads)
  await fastify.register(multipart);

  // healthcheck (não passa pelo tenant plugin)
  fastify.get('/healthz', async () => ({ ok: true }));

  // plugin multi-tenant: precisa vir ANTES das rotas
  await fastify.register(tenantPlugin);

  // rotas versionadas
  fastify.register(messageRoutes,  { prefix: '/api/v1/messages' });
  fastify.register(chatsRoutes,    { prefix: '/api/v1/chats' });
  fastify.register(flowRoutes,     { prefix: '/api/v1/flow' });
  fastify.register(uploadRoutes,   { prefix: '/api/v1/bucket' });
  fastify.register(clientesRoutes, { prefix: '/api/v1/clientes' });
  fastify.register(settingsRoutes, { prefix: '/api/v1/settings' });
  fastify.register(ticketsRoutes,  { prefix: '/api/v1/tickets' });
  fastify.register(filaRoutes,     { prefix: '/api/v1/filas' });
  fastify.register(atendentesRoutes, { prefix: '/api/v1/atendentes' });
  fastify.register(quickRepliesRoutes, { prefix: '/api/v1/quickReplies' });
  fastify.register(analyticsRoutes, { prefix: '/api/v1/analytics' });

  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const PORT = Number(process.env.PORT || 3000);

  try {
    fastify.log.info(`[start] Iniciando servidor na porta ${PORT}...`);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`);
  } catch (err) {
    fastify.log.error(err, '[start] Erro ao iniciar servidor');
    process.exit(1);
  }
}

start();


