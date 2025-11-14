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
      error_description = ""
    } = q;

    // redirect_uri calculado de forma proxy-aware
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto   = xfProto || req.protocol || "https";
    const xfHost  = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host    = xfHost || req.headers.host;
    const redirect_uri = `${proto}://${host}/oauth/wa`;

    // 1) Primeira etapa: HTML-ponte (evita 2º popup)
    if (start) {
      const extrasObj = { sessionInfoVersion: "3", version: "v3" };
      const extrasEnc = encodeURIComponent(JSON.stringify(extrasObj));

      // ⚠️ Sem display=popup → usamos O SEU popup; a Meta não abre outro.
      const target =
        `https://business.facebook.com/messaging/whatsapp/onboard/` +
        `?app_id=${encodeURIComponent(String(app_id || ""))}` +
        `&config_id=${encodeURIComponent(String(config_id || ""))}` +
        `&extras=${extrasEnc}` +
        (state ? `&state=${encodeURIComponent(String(state))}` : ``) +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}`;

      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>WA Onboarding</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <script>
    // debug básico
    console.log("[/oauth/wa start] bridge loaded. Replacing location to Meta wizard...");
    // garante reutilizar a MESMA janela
    window.name = "wa-es-onboard";
    try { window.location.replace(${JSON.stringify(target)}); }
    catch (e) {
      console.error("replace failed", e);
      document.body.innerHTML = '<p style="padding:16px">Abra <a href=' + ${JSON.stringify(target)} + ' target="_self">este link</a>.</p>';
    }
  </script>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 2) Retorno do wizard
    if (error || !code) {
      const msg = error ? `${error}: ${error_description || "Falha ao autenticar"}` : "Code ausente no retorno do OAuth.";
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Erro</title></head>
<body style="font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:20px;">
  <h3>Não foi possível concluir a conexão do WhatsApp</h3>
  <p><strong>Detalhes:</strong> ${String(msg).replace(/</g, "&lt;")}</p>
  <p>Confira <code>app_id</code>, <code>config_id</code> e o <code>redirect_uri</code> configurado na Meta.</p>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) Sucesso: envia postMessage para a janela mãe e fecha
    const html = `<!doctype html>
<html><body><script>
(function () {
  console.log("[/oauth/wa] success, posting message to opener...");
  try {
    var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) { console.error("postMessage failed", e); }
  setTimeout(function(){ window.close(); }, 200);
})();
</script>Ok, pode fechar.</body></html>`;
    reply.type("text/html").send(html);
  });

}
