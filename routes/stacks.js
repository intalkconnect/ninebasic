// routes/stacks.js
import 'dotenv/config';              // carrega .env aqui mesmo
import fs from 'fs/promises';
import https from 'https';
import axios from 'axios';

// --- DEV ONLY: se pedir, desliga a verificação TLS GLOBALMENTE
if (process.env.TLS_REJECT_UNAUTHORIZED === '0') {
  // ⚠️ use somente em DEV! Em produção, configure FQDN+cert válido.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ---- Config (via .env) ----
const PORTAINER_URL       = process.env.PORTAINER_URL;        // ex.: https://SEU_IP:9443
const PORTAINER_TOKEN     = process.env.PORTAINER_TOKEN;      // Access Token (X-API-Key)
const DEFAULT_ENDPOINT_ID = process.env.DEFAULT_ENDPOINT_ID || '2';
const STACK_FILE          = process.env.STACK_FILE || 'stack.yml';

// httpsAgent: ainda passamos explicitamente para axios
function getHttpsAgent() {
  const strict = process.env.TLS_REJECT_UNAUTHORIZED !== '0';
  return new https.Agent({ rejectUnauthorized: strict });
}

// Carrega stack.yml de caminho local OU URL
async function loadStackYaml() {
  const isUrl = /^https?:\/\//i.test(STACK_FILE);
  if (isUrl) {
    const { data } = await axios.get(STACK_FILE, {
      httpsAgent: getHttpsAgent(),
      responseType: 'text',
      transformResponse: x => x,
    });
    return data;
  }
  return await fs.readFile(STACK_FILE, 'utf8');
}

// Cache simples
let STACK_YAML = null;
async function ensureYamlLoaded() {
  if (!STACK_YAML) STACK_YAML = await loadStackYaml();
  return STACK_YAML;
}

function ensureConfig(fastify) {
  if (!PORTAINER_URL || !PORTAINER_TOKEN) {
    throw fastify.httpErrors.internalServerError(
      'PORTAINER_URL/PORTAINER_TOKEN não configurados no .env'
    );
  }
}

export default async function stacksRoutes(fastify) {
  // Recarregar YAML sem reiniciar (opcional)
  fastify.post('/ops/stacks/reload-yaml', async (_req, reply) => {
    STACK_YAML = await loadStackYaml();
    reply.send({ ok: true, bytes: STACK_YAML.length });
  });

  // Criar stack
  fastify.post('/ops/stacks/create', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'tenant'],
        properties: {
          name: { type: 'string', minLength: 1 },
          tenant: { type: 'string', minLength: 1 },
          endpointId: { type: 'string' }
        }
      }
    },
    handler: async (req, reply) => {
      ensureConfig(fastify);
      const { name, tenant, endpointId } = req.body;
      const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

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
          {
            params: { type: 2, method: 'string', endpointId: eid },
            headers: {
              'X-API-Key': PORTAINER_TOKEN,
              'Content-Type': 'application/json',
            },
            httpsAgent: getHttpsAgent(),
            timeout: 30000,
          }
        );
        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data = err.response?.data || { error: String(err) };
        reply.code(status).send(data);
      }
    }
  });

  // Atualizar stack
  fastify.post('/ops/stacks/update', {
    schema: {
      body: {
        type: 'object',
        required: ['stackId', 'tenant'],
        properties: {
          stackId: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          tenant: { type: 'string', minLength: 1 },
          endpointId: { type: 'string' }
        }
      }
    },
    handler: async (req, reply) => {
      ensureConfig(fastify);
      const { stackId, tenant, endpointId } = req.body;
      const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

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
          {
            params: { endpointId: eid },
            headers: {
              'X-API-Key': PORTAINER_TOKEN,
              'Content-Type': 'application/json',
            },
            httpsAgent: getHttpsAgent(),
            timeout: 30000,
          }
        );
        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data = err.response?.data || { error: String(err) };
        reply.code(status).send(data);
      }
    }
  });
}
