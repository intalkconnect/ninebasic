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

import { requireTenantBearerDb } from '../plugins/tenantBearerDb.js';

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

  fastify.register(messageRoutes,     { prefix: '/api/v1/messages', preHandler: requireTenantBearerDb() });
  fastify.register(chatsRoutes,       { prefix: '/api/v1/chats', preHandler: requireTenantBearerDb() });
  fastify.register(flowRoutes,        { prefix: '/api/v1/flow', preHandler: requireTenantBearerDb() });
  fastify.register(uploadRoutes,      { prefix: '/api/v1/bucket', preHandler: requireTenantBearerDb() });
  fastify.register(clientesRoutes,    { prefix: '/api/v1/clientes', preHandler: requireTenantBearerDb() });
  fastify.register(settingsRoutes,    { prefix: '/api/v1/settings', preHandler: requireTenantBearerDb() });
  fastify.register(ticketsRoutes,     { prefix: '/api/v1/tickets', preHandler: requireTenantBearerDb() });
  fastify.register(filaRoutes,        { prefix: '/api/v1/filas', preHandler: requireTenantBearerDb() });
  fastify.register(atendentesRoutes,  { prefix: '/api/v1/atendentes', preHandler: requireTenantBearerDb() });
  fastify.register(quickRepliesRoutes,{ prefix: '/api/v1/quickReplies', preHandler: requireTenantBearerDb() });
  fastify.register(analyticsRoutes,   { prefix: '/api/v1/analytics', preHandler: requireTenantBearerDb() });
  fastify.register(pausasRoutes,      { prefix: '/api/v1/pausas', preHandler: requireTenantBearerDb() });
  fastify.register(queueHoursRoutes,      { prefix: '/api/v1/queueHours', preHandler: requireTenantBearerDb() });
  fastify.register(templatesRoutes,      { prefix: '/api/v1/templates', preHandler: requireTenantBearerDb() });
  fastify.register(usersRoutes,      { prefix: '/api/v1/users', preHandler: requireTenantBearerDb() });
  fastify.register(campaignsRoutes,      { prefix: '/api/v1/campaigns', preHandler: requireTenantBearerDb() });
  fastify.register(billingRoutes,      { prefix: '/api/v1/billing', preHandler: requireTenantBearerDb() });
  

  // 👉 NOVO: Embedded Signup (prefixo próprio)
  fastify.register(waProfileRoutes, { prefix: '/api/v1/waProfile', preHandler: requireTenantBearerDb() });
  fastify.register(waEmbeddedRoutes,  { prefix: '/api/v1/wa', preHandler: requireTenantBearerDb() });
  fastify.register(telegramRoutes,  { prefix: '/api/v1/tg', preHandler: requireTenantBearerDb() });

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












