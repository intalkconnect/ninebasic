// endpoints.js (ENDPOINTS)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import cookie from '@fastify/cookie';

import tenantPlugin from './plugins/tenant.js';
import authCookieToBearer from './plugins/authCookieToBearer.js';
import { requireTenantBearerDb } from './plugins/tenantBearerDb.js';

// rotas...
import messagesRoutes     from './routes/messages.js';
import flowsRoutes        from './routes/flows.js';
import storageRoutes      from './routes/storage.js';
import customersRoutes    from './routes/customers.js';
import settingsRoutes     from './routes/settings.js';
import ticketsRoutes      from './routes/tickets.js';
import conversationsRoutes from './routes/conversations.js';
import queuesRoutes       from './routes/queues.js';
import agentsRoutes       from './routes/agents.js';
import quickRepliesRoutes from './routes/quickReplies.js';
import analyticsRoutes    from './routes/analytics.js';
import breaksRoutes       from './routes/breaks.js';
import queueHoursRoutes   from './routes/queueHoursRoutes.js';
import templatesRoutes    from './routes/templates.js';
import usersRoutes        from './routes/users.js';
import campaignsRoutes    from './routes/campaigns.js';
import billingRoutes      from './routes/billing.js';
import waProfileRoutes    from './routes/waProfile.js';
import waEmbeddedRoutes   from './routes/waEmbedded.js';
import telegramRoutes     from './routes/telegram.js';

dotenv.config();

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  await fastify.register(multipart);

  // cookie PRIMEIRO (para req.cookies)
  await fastify.register(cookie, { secret: process.env.COOKIE_SECRET, hook: 'onRequest' });

  // promove cookie -> Authorization (se header ausente)
  await fastify.register(authCookieToBearer);

  // rotas públicas
  fastify.get('/healthz', async () => ({ ok: true }));

  // debug (ver o header e decodificar o JWT de assert)
  fastify.get('/api/debug/auth', async (req, reply) => {
    const hdr = req.headers.authorization || req.raw.headers['authorization'] || null;
    let cookieNames = [];
    try { cookieNames = Object.keys(req.cookies || {}); } catch {}
    return { host: req.headers.host, authorization: hdr, cookieNames };
  });

  // resolve tenant pelo host/subdomínio
  await fastify.register(tenantPlugin);

  // escopo protegido
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

    api.register(waProfileRoutes,     { prefix: '/api/v1/whatsapp/profile' });
    api.register(waEmbeddedRoutes,    { prefix: '/api/v1/whatsapp/embedded' });
    api.register(telegramRoutes,      { prefix: '/api/v1/telegram' });
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
