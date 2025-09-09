// endpoints.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import tenantPlugin from './plugins/tenant.js';

// rotas existentes...
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
import pausasRoutes from './routes/pause.js';
import queueHoursRoutes from './routes/queueHoursRoutes.js';
import templatesRoutes from './routes/templates.js';
import usersRoutes from './routes/users.js';
import campaignsRoutes from './routes/campaigns.js';
import billingRoutes from './routes/billing.js';

// 👉 NOVO
import waProfileRoutes from './routes/waProfile.js';
import waEmbeddedRoutes from './routes/waEmbedded.js';
import telegramRoutes from './routes/telegram.js';

dotenv.config();

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  await fastify.register(multipart);

  fastify.get('/healthz', async () => ({ ok: true }));

  await fastify.register(tenantPlugin);

  fastify.register(messageRoutes,     { prefix: '/api/v1/messages' });
  fastify.register(chatsRoutes,       { prefix: '/api/v1/chats' });
  fastify.register(flowRoutes,        { prefix: '/api/v1/flow' });
  fastify.register(uploadRoutes,      { prefix: '/api/v1/bucket' });
  fastify.register(clientesRoutes,    { prefix: '/api/v1/clientes' });
  fastify.register(settingsRoutes,    { prefix: '/api/v1/settings' });
  fastify.register(ticketsRoutes,     { prefix: '/api/v1/tickets' });
  fastify.register(filaRoutes,        { prefix: '/api/v1/filas' });
  fastify.register(atendentesRoutes,  { prefix: '/api/v1/atendentes' });
  fastify.register(quickRepliesRoutes,{ prefix: '/api/v1/quickReplies' });
  fastify.register(analyticsRoutes,   { prefix: '/api/v1/analytics' });
  fastify.register(pausasRoutes,      { prefix: '/api/v1/pausas' });
  fastify.register(queueHoursRoutes,      { prefix: '/api/v1/queueHours' });
  fastify.register(templatesRoutes,      { prefix: '/api/v1/templates' });
  fastify.register(usersRoutes,      { prefix: '/api/v1/users' });
  fastify.register(campaignsRoutes,      { prefix: '/api/v1/campaigns' });
  fastify.register(billingRoutes,      { prefix: '/api/v1/billing' });
  

  // 👉 NOVO: Embedded Signup (prefixo próprio)
  fastify.register(waProfileRoutes, { prefix: '/api/v1/wa/profile' });
  fastify.register(waEmbeddedRoutes,  { prefix: '/api/v1/wa' });
  fastify.register(telegramRoutes,  { prefix: '/api/v1/tg' });

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










