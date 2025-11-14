// routes/oauthCallbacks.js
// Callbacks de OAuth para FB/IG/WA + rota de DEBUG do redirect_uri

export default async function oauthCallbacks(fastify) {
  // --------- CONFIG FIXA (altere aqui, se necessário) ---------
  // Se quiser fixar também o APP_ID, preencha APP_ID_FIXED (string).
  const CONFIG_ID_FIXED = "1556698225756152"; // <-- seu novo config_id
  const APP_ID_FIXED = null;                  // ex.: "684947304155673" | null = usa o app_id vindo da query

  // Util: calcula o redirect_uri levando em conta proxy/reverse-proxy
  function computeRedirectURI(req, path = "/oauth/wa") {
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto = xfProto || req.protocol || "https";
    const xfHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host = xfHost || req.headers.host;
    return `${proto}://${host}${path}`;
  }

  // ---------- DEBUG ----------
  // GET /oauth/wa/debug  → mostra qual redirect_uri o servidor está calculando
  fastify.get("/wa/debug", async (req, reply) => {
    const redirect_uri = computeRedirectURI(req, "/oauth/wa");
    const info = {
      ok: true,
      redirect_uri,
      note: "Use este valor EXACTO em 'Valid OAuth Redirect URIs' no app da Meta.",
      forwarded: {
        "x-forwarded-proto": req.headers["x-forwarded-proto"] || null,
        "x-forwarded-host": req.headers["x-forwarded-host"] || null,
      },
      host: req.headers.host || null,
      protocol_seen: req.protocol || null,
    };

    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WA OAuth Debug</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:20px;">
  <h2>WhatsApp OAuth Debug</h2>
  <p><b>redirect_uri calculado</b>:</p>
  <pre style="padding:8px;background:#f5f5f5;border-radius:6px;">${redirect_uri}</pre>
  <p>Cadastre exatamente esta URL em: <i>Facebook Login → Configurações → URIs de redirecionamento do OAuth válidos</i>.</p>
  <hr/>
  <h3>Headers relevantes</h3>
  <pre style="padding:8px;background:#f5f5f5;border-radius:6px;">${JSON.stringify(info, null, 2)}</pre>
</body></html>`;
    reply.type("text/html").send(html);
  });

  // ---------- FACEBOOK ----------
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

  // ---------- INSTAGRAM ----------
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

  // ---------- WHATSAPP (Embedded Signup, 1 popup) ----------
  fastify.get("/wa", async (req, reply) => {
    const q = req.query || {};
    const {
      start,
      code = "",
      state = "",
      app_id = "",
      // config_id = "",  // ignorado propositalmente; usamos CONFIG_ID_FIXED
      error = "",
      error_description = "",
    } = q;

    const redirect_uri = computeRedirectURI(req, "/oauth/wa");
    const appIdToUse = (APP_ID_FIXED || String(app_id || "")).trim();
    const configIdToUse = CONFIG_ID_FIXED;

    // 1) Primeira etapa → redireciona para o OAuth oficial da Meta
    if (start) {
      fastify.log.info({
        route: "GET /oauth/wa",
        action: "start",
        app_id_sent: app_id,
        app_id_used: appIdToUse,
        config_id_used: configIdToUse,
        state_present: !!state,
        redirect_uri
      });
      const url =
        `https://www.facebook.com/v24.0/dialog/oauth` +
        `?client_id=${encodeURIComponent(appIdToUse)}` +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
        `&response_type=code` +
        `&config_id=${encodeURIComponent(configIdToUse)}` +
        `&state=${encodeURIComponent(String(state || ""))}`;
      reply.redirect(url);
      return;
    }

    // 2) Retorno com erro (não fecha automaticamente para o usuário ver)
    if (error || !code) {
      fastify.log.warn({
        route: "GET /oauth/wa",
        action: "callback_error",
        error,
        error_description,
        has_code: !!code,
        state_present: !!state,
      });
      const msg = error ? `${error}: ${error_description || "Falha ao autenticar"}` : "Code ausente no retorno do OAuth.";
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Erro</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:20px;">
  <h3>Não foi possível concluir a conexão do WhatsApp</h3>
  <p><strong>Detalhes:</strong> ${msg.replace(/</g, "&lt;")}</p>
  <p>Confirme o <code>redirect_uri</code> cadastrado no app da Meta:</p>
  <pre style="padding:8px;background:#f5f5f5;border-radius:6px;">${redirect_uri}</pre>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) Sucesso → postMessage para a aba mãe e fechar
    fastify.log.info({
      route: "GET /oauth/wa",
      action: "callback_ok",
      state_present: !!state
    });

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
