// routes/portainerStacks.js
import fs from "fs/promises";
import https from "https";
import { Agent as UndiciAgent } from "undici";

const STACK_FILE = process.env.STACK_FILE || "stack.yml"; // local path OU URL http(s)
const PORTAINER_URL = process.env.PORTAINER_URL;
const PORTAINER_TOKEN = process.env.PORTAINER_TOKEN;
const DEFAULT_ENDPOINT_ID = process.env.DEFAULT_ENDPOINT_ID || "2";

 const TLS_STRICT = process.env.TLS_REJECT_UNAUTHORIZED !== "0";
 // dispatcher do Undici (usado pelo fetch nativo do Node)
 const UNDICI_DISPATCHER = TLS_STRICT
   ? undefined
   : new UndiciAgent({ connect: { rejectUnauthorized: false } });

// carrega stack.yml de arquivo local OU URL
async function loadStackYaml() {
  const isUrl = /^https?:\/\//i.test(STACK_FILE);
  if (isUrl) {
    const r = await fetch(STACK_FILE, { agent: AGENT });
    if (!r.ok) throw new Error(`Falha ao buscar STACK_FILE URL (${r.status})`);
    return await r.text();
  } else {
    return await fs.readFile(STACK_FILE, "utf8");
  }
}

// cache simples em memória
let STACK_YAML = null;
async function ensureYamlLoaded() {
  if (!STACK_YAML) STACK_YAML = await loadStackYaml();
  return STACK_YAML;
}

export default async function stacksRoutes(fastify) {
  function ensureConfig() {
    if (!PORTAINER_URL || !PORTAINER_TOKEN) {
      throw fastify.httpErrors.internalServerError(
        "PORTAINER_URL/PORTAINER_TOKEN não configurados"
      );
    }
  }

  // opcional: recarregar YAML sem reiniciar
  fastify.post("/ops/stacks/reload-yaml", async (_req, reply) => {
    STACK_YAML = await loadStackYaml();
    reply.send({ ok: true, bytes: STACK_YAML.length });
  });

  // criar stack
  fastify.post("/ops/stacks/create", {
    schema: {
      body: {
        type: "object",
        required: ["name", "tenant"],
        properties: {
          name: { type: "string", minLength: 1 },
          tenant: { type: "string", minLength: 1 },
          endpointId: { type: "string" }
          // se quiser, acrescente replicas extras: WORKER_*_REPLICAS etc.
        },
      },
    },
    handler: async (req, reply) => {
      ensureConfig();
      const { name, tenant, endpointId } = req.body;
      const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

      const yaml = await ensureYamlLoaded();

      const payload = {
        name,
        stackFileContent: yaml,
        env: [{ name: "TENANT", value: String(tenant) }],
      };

      const url = `${PORTAINER_URL}/api/stacks?type=2&method=string&endpointId=${encodeURIComponent(eid)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "X-API-Key": PORTAINER_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        dispatcher: UNDICI_DISPATCHER,
      });

      const text = await r.text();
      reply.code(r.status).type("application/json").send(text);
    },
  });

  // atualizar stack
  fastify.post("/ops/stacks/update", {
    schema: {
      body: {
        type: "object",
        required: ["stackId", "tenant"],
        properties: {
          stackId: { type: "integer" },
          tenant: { type: "string", minLength: 1 },
          endpointId: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      ensureConfig();
      const { stackId, tenant, endpointId } = req.body;
      const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

      const yaml = await ensureYamlLoaded();

      const payload = {
        prune: true,
        stackFileContent: yaml,
        env: [{ name: "TENANT", value: String(tenant) }],
      };

      const url = `${PORTAINER_URL}/api/stacks/${encodeURIComponent(stackId)}?endpointId=${encodeURIComponent(eid)}`;
      const r = await fetch(url, {
        method: "PUT",
        headers: {
          "X-API-Key": PORTAINER_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        dispatcher: UNDICI_DISPATCHER,
      });

      const text = await r.text();
      reply.code(r.status).type("application/json").send(text);
    },
  });
}
