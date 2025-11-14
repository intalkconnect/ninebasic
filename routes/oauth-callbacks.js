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
      display = "popup",
    } = q;

    // redirect_uri "proxy-aware"
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto   = xfProto || req.protocol || "https";
    const xfHost  = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host    = xfHost || req.headers.host;
    const redirect_uri = `${proto}://${host}/oauth/wa`;

    // 1) PRIMEIRA ETAPA → HTML-ponte (evita segundo popup)
    if (start) {
      // mesmo "extras" do wizard oficial
      const extrasObj = { sessionInfoVersion: "3", version: "v3" };
      const extrasEnc = encodeURIComponent(JSON.stringify(extrasObj));

      const target =
        `https://business.facebook.com/messaging/whatsapp/onboard/` +
        `?app_id=${encodeURIComponent(String(app_id || ""))}` +
        `&config_id=${encodeURIComponent(String(config_id || ""))}` +
        `&extras=${extrasEnc}` +
        `&display=${encodeURIComponent(String(display || "popup"))}` +
        // o ES normalmente ignora state, mas se aceitar, enviamos
        (state ? `&state=${encodeURIComponent(String(state))}` : ``) +
        // importante: o redirect tem de estar configurado na Meta (este /oauth/wa)
        `&redirect_uri=${encodeURIComponent(redirect_uri)}`;

      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>WhatsApp Onboarding</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <script>
    (function () {
      try {
        // usar replace garante que continuamos NA MESMA janela (sem abrir outra)
        window.location.replace(${JSON.stringify(target)});
      } catch (e) {
        document.body.innerHTML =
          '<p style="padding:16px">Não foi possível iniciar o wizard. ' +
          'Abra <a href=' + ${JSON.stringify(target)} + ' target="_self" rel="opener">este link</a>.</p>';
      }
    })();
  </script>
</body></html>`;
      reply.type("text/html").send(html);
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
  <p>Confira <code>app_id</code>, <code>config_id</code> e o <code>redirect_uri</code> configurado na Meta.</p>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) SUCESSO → avisa o opener e fecha (uma pequena folga antes de fechar)
    const html = `<!doctype html>
<html><body><script>
(function () {
  try {
    var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) {}
  setTimeout(function(){ window.close(); }, 200);
})();
</script>Ok, pode fechar.</body></html>`;
    reply.type("text/html").send(html);
  });

}
