// endpoints.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import tenantPlugin from './plugins/tenant.js';
import { requireTenantBearerDb } from './plugins/tenantBearerDb.js';

// rotas...
import messageRoutes     from './routes/messages.js';
import flowRoutes        from './routes/flow.js';
import uploadRoutes      from './routes/uploadRoutes.js';
import clientesRoutes    from './routes/clientes.js';
import settingsRoutes    from './routes/settings.js';
import ticketsRoutes     from './routes/tickets.js';
import chatsRoutes       from './routes/chats.js';
import filaRoutes        from './routes/filas.js';
import atendentesRoutes  from './routes/atendentes.js';
import quickRepliesRoutes from './routes/quickReplies.js';
import analyticsRoutes   from './routes/analytics.js';
import pausasRoutes      from './routes/pause.js';
import queueHoursRoutes  from './routes/queueHoursRoutes.js';
import templatesRoutes   from './routes/templates.js';
import usersRoutes       from './routes/users.js';
import campaignsRoutes   from './routes/campaigns.js';
import billingRoutes     from './routes/billing.js';

// novos
import waProfileRoutes   from './routes/waProfile.js';
import waEmbeddedRoutes  from './routes/waEmbedded.js';
import telegramRoutes    from './routes/telegram.js';

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

  // 🔒 Cria um escopo “/api/v1/*” com o guard aplicado
  await fastify.register(async (api) => {
    // hook aplicado a TUDO que for registrado neste escopo
    api.addHook('preHandler', requireTenantBearerDb());

    // registre TODAS as rotas que precisam de token DENTRO deste escopo:
    api.register(messageRoutes,     { prefix: '/api/v1/messages' });
    api.register(chatsRoutes,       { prefix: '/api/v1/conversations' });
    api.register(flowRoutes,        { prefix: '/api/v1/flows' });
    api.register(uploadRoutes,      { prefix: '/api/v1/storage' });
    api.register(clientesRoutes,    { prefix: '/api/v1/customers' });
    api.register(settingsRoutes,    { prefix: '/api/v1/settings' });
    api.register(ticketsRoutes,     { prefix: '/api/v1/tickets' });
    api.register(filaRoutes,        { prefix: '/api/v1/queues' });
    api.register(atendentesRoutes,  { prefix: '/api/v1/agents' });
    api.register(quickRepliesRoutes,{ prefix: '/api/v1/quick-replies' });
    api.register(analyticsRoutes,   { prefix: '/api/v1/analytics' });
    api.register(pausasRoutes,      { prefix: '/api/v1/breaks' });
    api.register(queueHoursRoutes,  { prefix: '/api/v1/queue-hours' });
    api.register(templatesRoutes,   { prefix: '/api/v1/templates' });
    api.register(usersRoutes,       { prefix: '/api/v1/users' });
    api.register(campaignsRoutes,   { prefix: '/api/v1/campaigns' });
    api.register(billingRoutes,     { prefix: '/api/v1/billing' });

    // novos, também protegidos:
    api.register(waProfileRoutes, { prefix: '/api/v1/whatsapp/profile' });
    api.register(waEmbeddedRoutes,{ prefix: '/api/v1/whatsapp/embedded' });
    api.register(telegramRoutes,  { prefix: '/api/v1/telegram' });
  });

  // se tiver rotas públicas além de /healthz, registre FORA do escopo acima
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

