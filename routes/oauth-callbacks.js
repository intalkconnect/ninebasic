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
      error = "",
      error_description = "",
    } = q;

    // redirect_uri calculado de forma proxy-aware
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto   = xfProto || req.protocol || "https";
    const xfHost  = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host    = xfHost || req.headers.host;
    const redirect_uri = `${proto}://${host}/oauth/wa`;

    // 1) Primeira etapa: aponta DIRETO para o dialog OAuth oficial (garante code)
    if (start) {
      const url =
        `https://www.facebook.com/v24.0/dialog/oauth` +
        `?client_id=${encodeURIComponent(String(app_id || ""))}` +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
        `&response_type=code` +
        `&config_id=${encodeURIComponent(String(config_id || ""))}` +
        (state ? `&state=${encodeURIComponent(String(state))}` : ``) +
        // dica: deixar display=popup ajuda a Meta a não abrir outra janela separada
        `&display=popup`;

      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Meta OAuth</title></head>
<body style="margin:0">
  <script>
    console.log("[/oauth/wa start] navigating to FB dialog/oauth");
    window.name = "wa-es-onboard"; // reusa esta mesma janela
    location.replace(${JSON.stringify(url)});
  </script>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 2) Retorno do OAuth: se não tiver code, mostra erro na própria janela
    if (error || !code) {
      const msg = error ? (error_description || error) : "Code ausente no retorno do OAuth.";
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Erro</title></head>
<body style="font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:20px;">
  <h3>Não foi possível concluir a conexão do WhatsApp</h3>
  <p><strong>Detalhes:</strong> ${String(msg).replace(/</g,"&lt;")}</p>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) Sucesso: devolve o code para a janela mãe e fecha
    const html = `<!doctype html>
<html><body><script>
(function () {
  try {
    var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state || "")} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) { console.error("postMessage failed", e); }
  setTimeout(function(){ window.close(); }, 200);
})();
</script>Ok, pode fechar.</body></html>`;
    reply.type("text/html").send(html);
  });
}
