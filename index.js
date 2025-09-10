// endpoints.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import dotenv from 'dotenv';

import tenantPlugin from './plugins/tenant.js';
import { requireTenantBearerDb } from './plugins/tenantBearerDb.js';
import authCookieToBearer from './plugins/authCookieToBearer.js';

// rotas...
import messagesRoutes      from './routes/messages.js';
import flowsRoutes         from './routes/flows.js';
import storageRoutes       from './routes/storage.js';
import customersRoutes     from './routes/customers.js';
import settingsRoutes      from './routes/settings.js';
import ticketsRoutes       from './routes/tickets.js';
import conversationsRoutes from './routes/conversations.js';
import queuesRoutes        from './routes/queues.js';
import agentsRoutes        from './routes/agents.js';
import quickRepliesRoutes  from './routes/quickReplies.js';
import analyticsRoutes     from './routes/analytics.js';
import breaksRoutes        from './routes/breaks.js';
import queueHoursRoutes    from './routes/queueHoursRoutes.js';
import templatesRoutes     from './routes/templates.js';
import usersRoutes         from './routes/users.js';
import campaignsRoutes     from './routes/campaigns.js';
import billingRoutes       from './routes/billing.js';

// novos
import waProfileRoutes     from './routes/waProfile.js';
import waEmbeddedRoutes    from './routes/waEmbedded.js';
import telegramRoutes      from './routes/telegram.js';

dotenv.config();

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: []
  });

  await fastify.register(multipart);

  // 1. Primeiro registra o cookie plugin
  await fastify.register(cookie, { 
    secret: false, // não precisamos assinar cookies
    hook: 'onRequest' 
  });

  // 2. Depois registra o tenant plugin (resolve subdomain)
  await fastify.register(tenantPlugin);

  // 3. Por último, o authCookieToBearer (depende do cookie estar processado)
  await fastify.register(authCookieToBearer);

  // rotas públicas
  fastify.get('/healthz', async () => ({ ok: true }));
  
  // Debug route melhorada
  fastify.get('/api/debug/auth', async (req) => ({
    host: req.headers.host,
    authorization: req.headers.authorization || null,
    cookies: req.cookies || {},
    cookieNames: Object.keys(req.cookies || {}),
    tenant: req.tenant || null,
    rawCookieHeader: req.headers.cookie || null
  }));

  // 🔒 escopo protegido /api/v1/*
  await fastify.register(async (api) => {
    api.addHook('preHandler', requireTenantBearerDb());

    api.register(messagesRoutes,      { prefix: '/api/v1/messages' });
    api.register(conversationsRoutes, { prefix: '/api/v1/conversations' });
    api.register(flowsRoutes,         { prefix: '/api/v1/flows' });
    api.register(storageRoutes,       { prefix: '/api/v1/storage' });
    api.register(customersRoutes,     { prefix: '/api/v1/customers' });
    api.register(settingsRoutes,      { prefix: '/api/v1/settings' });
    api.register(ticketsRoutes,       { prefix: '/api/v1/tickets' });
    api.register(queuesRoutes,        { prefix: '/api/v1/queues' });
    api.register(agentsRoutes,        { prefix: '/api/v1/agents' });
    api.register(quickRepliesRoutes,  { prefix: '/api/v1/quick-replies' });
    api.register(analyticsRoutes,     { prefix: '/api/v1/analytics' });
    api.register(breaksRoutes,        { prefix: '/api/v1/breaks' });
    api.register(queueHoursRoutes,    { prefix: '/api/v1/queue-hours' });
    api.register(templatesRoutes,     { prefix: '/api/v1/templates' });
    api.register(usersRoutes,         { prefix: '/api/v1/users' });
    api.register(campaignsRoutes,     { prefix: '/api/v1/campaigns' });
    api.register(billingRoutes,       { prefix: '/api/v1/billing' });

    // novos
    api.register(waProfileRoutes, { prefix: '/api/v1/whatsapp/profile' });
    api.register(waEmbeddedRoutes,{ prefix: '/api/v1/whatsapp/embedded' });
    api.register(telegramRoutes,  { prefix: '/api/v1/telegram' });
  });

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

