export default async function oauthCallbacks(fastify) {
  // GET /oauth/fb
  fastify.get("/fb", async (req, reply) => {
    const { code = "", state = "", error = "", error_description = "" } = req.query || {};
    const hasCode = !!code && !error;

    const html = `<!doctype html>
<html><body><script>
(function () {
  try {
    var payload = ${hasCode
      ? `{ type: "fb:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} }`
      : `{ type: "fb:oauth:error", error: ${JSON.stringify(error || "missing_code")}, error_description: ${JSON.stringify(error_description || "Falha ao autenticar")} }`
    };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

  // GET /oauth/ig
  fastify.get("/ig", async (req, reply) => {
    const { code = "", state = "", error = "", error_description = "" } = req.query || {};
    const hasCode = !!code && !error;

    const html = `<!doctype html>
<html><body><script>
(function () {
  try {
    var payload = ${hasCode
      ? `{ type: "ig:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} }`
      : `{ type: "ig:oauth:error", error: ${JSON.stringify(error || "missing_code")}, error_description: ${JSON.stringify(error_description || "Falha ao autenticar")} }`
    };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

  // GET /oauth/wa
  fastify.get("/wa", async (req, reply) => {
    const q = req.query || {};
    const {
      start,
      code = "",
      state = "",
      app_id = "",
      config_id = "",
      extras = "",
      display = "popup",
      error = "",
      error_description = ""
    } = q;

    // calcula redirect_uri de modo "proxy-aware"
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto   = xfProto || req.protocol || "https";
    const xfHost  = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host    = xfHost || req.headers.host;
    const redirect_uri = `${proto}://${host}/oauth/wa`;

    // 1) PRIMEIRA ETAPA → abre o wizard oficial (UM popup)
    if (start) {
      const extrasJson =
        typeof extras === "string" && extras.length
          ? extras // já vem url-encoded do front
          : encodeURIComponent(JSON.stringify({ sessionInfoVersion: "3", version: "v3" }));

      const url =
        `https://business.facebook.com/messaging/whatsapp/onboard/?` +
        `app_id=${encodeURIComponent(String(app_id || ""))}` +
        `&config_id=${encodeURIComponent(String(config_id || ""))}` +
        `&extras=${extrasJson}` +
        `&display=${encodeURIComponent(String(display || "popup"))}` +
        // a Meta pode ignorar state no ES, mas repassamos pra manter compatibilidade
        (state ? `&state=${encodeURIComponent(String(state))}` : ``) +
        // o redirect_uri é o que você cadastrou no Config (a Meta usará esse /oauth/wa)
        ``;

      reply.redirect(url);
      return;
    }

    // 2) RETORNO DO WIZARD
    if (error || !code) {
      const msg = error ? `${error}: ${error_description || "Falha ao autenticar"}` : "Code ausente no retorno do OAuth.";
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Erro</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:20px;">
  <h3>Não foi possível concluir a conexão do WhatsApp</h3>
  <p><strong>Detalhes:</strong> ${String(msg).replace(/</g, "&lt;")}</p>
  <p>Confira <code>app_id</code>, <code>config_id</code> e o <code>redirect_uri</code> configurado no Embedded Signup.</p>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) SUCESSO → envia o code pro opener e fecha
    const html = `<!doctype html>
<html><body><script>
(function () {
  try {
    var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

}
