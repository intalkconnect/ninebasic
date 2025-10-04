// routes/stacks.js — produção (TLS estrito), auto-detect Swarm/Compose, sem httpErrors
import 'dotenv/config';
import fs from 'fs/promises';
import https from 'https';
import axios from 'axios';

const PORTAINER_URL       = process.env.PORTAINER_URL;           // ex.: http://portainer:9000  ou  https://portainer.seu-dominio.com
const PORTAINER_TOKEN     = process.env.PORTAINER_TOKEN;         // X-API-Key
const DEFAULT_ENDPOINT_ID = String(process.env.DEFAULT_ENDPOINT_ID || '3'); // no seu caso, 3
const STACK_FILE          = process.env.STACK_FILE || 'stack.yml';

// HTTPS estrito (apenas quando usamos HTTPS)
function strictHttpsAgent() {
  return new https.Agent({ rejectUnauthorized: true });
}

// aceita hostnames internos (ex.: "portainer") e redes privadas como "http://10.x..."
function isPrivateHost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);

    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    // single-label (service name em overlay / compose) => interno
    if (!hostname.includes('.')) return true;

    if (
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.docker') ||
      hostname.endsWith('.localdomain')
    ) return true;

    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;

    return false;
  } catch {
    return false;
  }
}

// valida config (sem fastify.httpErrors)
function ensureConfigOrThrow() {
  if (!PORTAINER_URL || !PORTAINER_TOKEN) {
    throw new Error('Faltam PORTAINER_URL e/ou PORTAINER_TOKEN.');
  }
  const isHttps = /^https:\/\//i.test(PORTAINER_URL);
  const isHttp  =  /^http:\/\//i.test(PORTAINER_URL);

  if (isHttp) {
    const allowHttpInternal = process.env.ALLOW_HTTP_INTERNAL === '1';
    if (!allowHttpInternal || !isPrivateHost(PORTAINER_URL)) {
      throw new Error('PORTAINER_URL HTTP só é permitido para host privado e com ALLOW_HTTP_INTERNAL=1.');
    }
  } else if (!isHttps) {
    throw new Error('PORTAINER_URL deve ser http(s).');
  }
}

// carrega stack.yml (arquivo local ou URL https)
async function loadStackYaml() {
  const isUrl = /^https?:\/\//i.test(STACK_FILE);
  if (isUrl) {
    if (!/^https:\/\//i.test(STACK_FILE)) {
      throw new Error('STACK_FILE por URL deve ser HTTPS (ou use arquivo local).');
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

let STACK_YAML = null;
async function ensureYamlLoaded() {
  if (!STACK_YAML) STACK_YAML = await loadStackYaml();
  return STACK_YAML;
}

function axiosOpts(extra = {}) {
  const base = {
    timeout: 30000,
    headers: {
      'X-API-Key': PORTAINER_TOKEN,
      'Content-Type': 'application/json'
    }
  };
  if (/^https:\/\//i.test(PORTAINER_URL)) {
    base.httpsAgent = strictHttpsAgent();
  }
  return { ...base, ...extra };
}

// pergunta ao Portainer se o endpoint está com Swarm ativo
async function isSwarmActive(eid) {
  const r = await axios.get(
    `${PORTAINER_URL}/api/endpoints/${eid}/docker/info`,
    axiosOpts()
  );
  return r.data?.Swarm?.LocalNodeState === 'active';
}

export default async function stacksRoutes(fastify) {
  // reload do YAML em memória
  fastify.post('/ops/stacks/reload-yaml', async (_req, reply) => {
    try {
      STACK_YAML = await loadStackYaml();
      reply.send({ ok: true, bytes: STACK_YAML.length });
    } catch (err) {
      reply.code(500).send({ error: String(err?.message || err) });
    }
  });

  // CREATE — auto detect: swarm (1) se ativo; senão compose (2)
  fastify.post('/ops/stacks/create', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'tenant'],
        properties: {
          name:       { type: 'string', minLength: 1 },
          tenant:     { type: 'string', minLength: 1 },
          endpointId: { type: 'string' },
          stackType:  { type: 'string', enum: ['swarm','compose'] } // opcional: força modo
        }
      }
    },
    handler: async (req, reply) => {
      try {
        ensureConfigOrThrow();

        const { name, tenant, endpointId, stackType } = req.body;
        const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

        // decide o type
        let type;
        if (stackType === 'swarm') type = 1;
        else if (stackType === 'compose') type = 2;
        else type = (await isSwarmActive(eid)) ? 1 : 2;  // auto

        const yaml = await ensureYamlLoaded();
        const payload = {
          name,
          stackFileContent: yaml,
          env: [{ name: 'TENANT', value: String(tenant) }]
        };

        const { status, data } = await axios.post(
          `${PORTAINER_URL}/api/stacks`,
          payload,
          axiosOpts({ params: { type, method: 'string', endpointId: eid } })
        );

        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data   = err.response?.data || { error: String(err?.message || err) };
        reply.code(status).send(data);
      }
    }
  });

  // UPDATE — redeploy com prune
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
      try {
        ensureConfigOrThrow();

        const { stackId, tenant, endpointId } = req.body;
        const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

        const yaml = await ensureYamlLoaded();
        const payload = {
          prune: true,
          stackFileContent: yaml,
          env: [{ name: 'TENANT', value: String(tenant) }]
        };

        const { status, data } = await axios.put(
          `${PORTAINER_URL}/api/stacks/${encodeURIComponent(stackId)}`,
          payload,
          axiosOpts({ params: { endpointId: eid } })
        );
        reply.code(status).send(data);
      } catch (err) {
        const status = err.response?.status || 500;
        const data   = err.response?.data || { error: String(err?.message || err) };
        reply.code(status).send(data);
      }
    }
  });

  // ping/debug
  fastify.get('/ops/stacks/ping', async (_req, reply) => {
    try {
      ensureConfigOrThrow();
      reply.send({ ok: true, url: PORTAINER_URL, endpointId: DEFAULT_ENDPOINT_ID });
    } catch (err) {
      reply.code(500).send({ error: String(err?.message || err) });
    }
  });

  // diagnóstico (status + endpoints)
  fastify.get('/ops/stacks/diag', async (_req, reply) => {
    try {
      const s = await axios.get(`${PORTAINER_URL}/api/status`, axiosOpts());
      const e = await axios.get(`${PORTAINER_URL}/api/endpoints`, axiosOpts());
      reply.send({
        ok: true,
        portainerUrl: PORTAINER_URL,
        status: s.data,
        endpoints: e.data.map(x => ({ Id: x.Id, Name: x.Name, Type: x.Type, URL: x.URL }))
      });
    } catch (err) {
      reply.code(err.response?.status || 500).send({
        ok: false,
        portainerUrl: PORTAINER_URL,
        error: err.response?.data || String(err)
      });
    }
  });

  // ver variáveis efetivas
  fastify.get('/ops/stacks/env', async (_req, reply) => {
    reply.send({
      PORTAINER_URL: process.env.PORTAINER_URL,
      ALLOW_HTTP_INTERNAL: process.env.ALLOW_HTTP_INTERNAL,
      DEFAULT_ENDPOINT_ID: process.env.DEFAULT_ENDPOINT_ID
    });
  });

  // (extra) ver estado do swarm do endpoint
  fastify.get('/ops/stacks/swarm/:eid', async (req, reply) => {
    const eid = String(req.params.eid);
    try {
      const r = await axios.get(`${PORTAINER_URL}/api/endpoints/${eid}/docker/info`, axiosOpts());
      reply.send({
        eid,
        swarmLocalNodeState: r.data?.Swarm?.LocalNodeState,
        controlAvailable: r.data?.Swarm?.ControlAvailable,
        nodeID: r.data?.Swarm?.NodeID
      });
    } catch (err) {
      reply.code(err.response?.status || 500).send({ error: err.response?.data || String(err) });
    }
  });
}
