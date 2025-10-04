// routes/stacks.js  (produção: TLS estrito e Swarm por padrão)
import 'dotenv/config';
import fs from 'fs/promises';
import https from 'https';
import axios from 'axios';

// ---- Config obrigatória (produção) ----
const PORTAINER_URL       = process.env.PORTAINER_URL;          // ex.: https://portainer.seu-dominio.com
const PORTAINER_TOKEN     = process.env.PORTAINER_TOKEN;        // Access Token (X-API-Key)
const DEFAULT_ENDPOINT_ID = String(process.env.DEFAULT_ENDPOINT_ID || '2');
const STACK_FILE          = process.env.STACK_FILE || 'stack.yml';

// 🔒 Produção: nunca aceite TLS relaxado
if (process.env.TLS_REJECT_UNAUTHORIZED === '0' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error(
    'TLS relaxado detectado (TLS_REJECT_UNAUTHORIZED/NODE_TLS_REJECT_UNAUTHORIZED=0). ' +
    'Em produção, use PORTAINER_URL com certificado válido (Let's Encrypt/NPM) ou adicione a CA em NODE_EXTRA_CA_CERTS.'
  );
}

// HTTPS agent estrito (verificação de certificado habilitada)
function strictHttpsAgent() {
  return new https.Agent({ rejectUnauthorized: true });
}

// Carrega stack.yml de caminho local OU URL HTTPS confiável
async function loadStackYaml() {
  const isUrl = /^https?:\/\//i.test(STACK_FILE);
  if (isUrl) {
    if (!/^https:\/\//i.test(STACK_FILE)) {
      throw new Error('STACK_FILE por URL deve ser HTTPS em produção.');
    }
    const { data } = await axios.get(STACK_FILE, {
      httpsAgent: strictHttpsAgent(),
      responseType: 'text',
      transformResponse: x => x,
      timeout: 20000
    });
    return data;
  }
  return await fs.readFile(STACK_FILE, 'utf8');
}

// Cache simples do YAML
let STACK_YAML = null;
async function ensureYamlLoaded() {
  if (!STACK_YAML) STACK_YAML = await loadStackYaml();
  return STACK_YAML;
}

function ensureConfig(fastify) {
  if (!PORTAINER_URL || !PORTAINER_TOKEN) {
    throw fastify.httpErrors.internalServerError(
      'Faltam variáveis: PORTAINER_URL e/ou PORTAINER_TOKEN.'
    );
  }
  if (!/^https:\/\//i.test(PORTAINER_URL)) {
    throw fastify.httpErrors.internalServerError(
      'PORTAINER_URL deve ser HTTPS com certificado válido em produção.'
    );
  }
}

function axiosOpts(extra = {}) {
  return {
    httpsAgent: strictHttpsAgent(),
    timeout: 30000,
    headers: {
      'X-API-Key': PORTAINER_TOKEN,
      'Content-Type': 'application/json'
    },
    ...extra
  };
}

export default async function stacksRoutes(fastify) {
  // Reload do YAML (útil pra GitOps puller externo)
  fastify.post('/ops/stacks/reload-yaml', async (_req, reply) => {
    STACK_YAML = await loadStackYaml();
    reply.send({ ok: true, bytes: STACK_YAML.length });
  });

  // CREATE (Swarm por padrão: type=1)
  fastify.post('/ops/stacks/create', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'tenant'],
        properties: {
          name:       { type: 'string', minLength: 1 },
          tenant:     { type: 'string', minLength: 1 },
          endpointId: { type: 'string' },
          // opcional: forçar compose (NÃO recomendado em prod)
          stackType:  { type: 'string', enum: ['swarm','compose'] }
        }
      }
    },
    handler: async (req, reply) => {
      ensureConfig(fastify);

      const { name, tenant, endpointId, stackType } = req.body;
      const eid  = String(endpointId || DEFAULT_ENDPOINT_ID);
      const type = (stackType === 'compose') ? 2 : 1; // produção => swarm (1)

      const yaml = await ensureYamlLoaded();
      const payload = {
        name,
        stackFileContent: yaml,
        env: [{ name: 'TENANT', value: String(tenant) }]
      };

      try {
        const { status, data } = await axios.post(
          `${PORTAINER_URL}/api/stacks`,
          payload,
          axiosOpts({ params: { type, method: 'string', endpointId: eid } })
        );
        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data   = err.response?.data || { error: String(err) };
        reply.code(status).send(data);
      }
    }
  });

  // UPDATE (redeploy com prune)
  fastify.post('/ops/stacks/update', {
    schema: {
      body: {
        type: 'object',
        required: ['stackId', 'tenant'],
        properties: {
          stackId:    { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          tenant:     { type: 'string', minLength: 1 },
          endpointId: { type: 'string' }
        }
      }
    },
    handler: async (req, reply) => {
      ensureConfig(fastify);

      const { stackId, tenant, endpointId } = req.body;
      const eid  = String(endpointId || DEFAULT_ENDPOINT_ID);

      const yaml = await ensureYamlLoaded();
      const payload = {
        prune: true,
        stackFileContent: yaml,
        env: [{ name: 'TENANT', value: String(tenant) }]
      };

      try {
        const { status, data } = await axios.put(
          `${PORTAINER_URL}/api/stacks/${encodeURIComponent(stackId)}`,
          payload,
          axiosOpts({ params: { endpointId: eid } })
        );
        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data   = err.response?.data || { error: String(err) };
        reply.code(status).send(data);
      }
    }
  });
}
