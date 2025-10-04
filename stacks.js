// routes/portainerStacks.js
import fs from "fs/promises";
import https from "https";

// Lê o stack.yml 1x ao carregar o módulo (pode usar process.env.STACK_FILE)
const STACK_FILE = process.env.STACK_FILE || "stack.yml";
const STACK_YAML = await fs.readFile(STACK_FILE, "utf8");

// Config Portainer
const PORTAINER_URL = process.env.PORTAINER_URL;       // ex.: https://SEU_IP:9443
const PORTAINER_TOKEN = process.env.PORTAINER_TOKEN;   // Access Token (X-API-Key)
const DEFAULT_ENDPOINT_ID = process.env.DEFAULT_ENDPOINT_ID || "2";

// TLS: aceite autoassinado = defina TLS_REJECT_UNAUTHORIZED=0 (apenas testes)
const AGENT = new https.Agent({
  rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== "0",
});

export default async function stacksRoutes(fastify) {
  // validação simples
  function ensureConfig() {
    if (!PORTAINER_URL || !PORTAINER_TOKEN) {
      throw fastify.httpErrors.internalServerError(
        "PORTAINER_URL/PORTAINER_TOKEN não configurados"
      );
    }
  }

  // POST /api/v1/ops/stacks/create
  fastify.post("/ops/stacks/create", {
    schema: {
      body: {
        type: "object",
        required: ["name", "tenant"],
        properties: {
          name: { type: "string", minLength: 1 },
          tenant: { type: "string", minLength: 1 },
          endpointId: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      ensureConfig();
      const { name, tenant, endpointId } = req.body;
      const eid = String(endpointId || DEFAULT_ENDPOINT_ID);

      const url = `${PORTAINER_URL}/api/stacks?type=2&method=string&endpointId=${encodeURIComponent(
        eid
      )}`;

      const payload = {
        name,
        stackFileContent: STACK_YAML,                 // YAML oculto no servidor
        env: [{ name: "TENANT", value: String(tenant) }], // só TENANT (réplicas default = 1)
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "X-API-Key": PORTAINER_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        agent: AGENT,
      });

      const text = await r.text();
      reply.code(r.status).type("application/json").send(text);
    },
  });

  // POST /api/v1/ops/stacks/update  (atualiza stack existente)
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

      const url = `${PORTAINER_URL}/api/stacks/${encodeURIComponent(
        stackId
      )}?endpointId=${encodeURIComponent(eid)}`;

      const payload = {
        prune: true,
        stackFileContent: STACK_YAML,
        env: [{ name: "TENANT", value: String(tenant) }],
      };

      const r = await fetch(url, {
        method: "PUT",
        headers: {
          "X-API-Key": PORTAINER_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        agent: AGENT,
      });

      const text = await r.text();
      reply.code(r.status).type("application/json").send(text);
    },
  });
}
