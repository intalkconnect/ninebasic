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
    const { start, code = "", state = "", app_id = "", config_id = "", error = "", error_description = "" } = q;

    // calcula redirect_uri de modo "proxy-aware"
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto = xfProto || req.protocol || "https";
    const xfHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host = xfHost || req.headers.host;
    const redirect_uri = `${proto}://${host}/oauth/wa`;

    // 1) primeira etapa: redireciona para o OAuth (UM popup só)
    if (start) {
      const url =
        `https://www.facebook.com/v23.0/dialog/oauth` +
        `?client_id=${encodeURIComponent(String(app_id || ""))}` +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
        `&response_type=code` +
        `&config_id=${encodeURIComponent(String(config_id || ""))}` +
        `&state=${encodeURIComponent(String(state || ""))}`;
      reply.redirect(url);
      return;
    }

    // 2) retorno com erro: mantém a janela aberta p/ leitura
    if (error || !code) {
      const msg = error ? `${error}: ${error_description || "Falha ao autenticar"}` : "Code ausente no retorno do OAuth.";
      const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Erro</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:20px;">
  <h3>Não foi possível concluir a conexão do WhatsApp</h3>
  <p><strong>Detalhes:</strong> ${msg.replace(/</g, "&lt;")}</p>
  <p>Verifique se o <code>app_id</code>, <code>config_id</code> e <code>redirect_uri</code> estão corretos e cadastrados na Meta.</p>
  <p><button onclick="window.close()">Fechar</button></p>
</body></html>`;
      reply.type("text/html").send(html);
      return;
    }

    // 3) sucesso: envia postMessage e ESPERA ACK para fechar (com fallback)
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>WhatsApp – Concluindo…</title>
<style>
  body{font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:24px}
  .ok{display:flex;gap:8px;align-items:center;margin-bottom:6px}
  small{color:#666}
</style>
</head>
<body>
  <div class="ok"><strong>Conexão iniciada com sucesso.</strong></div>
  <small>Você já pode voltar para a aba anterior. Esta janela fechará automaticamente em instantes.</small>
  <script>
  (function () {
    try {
      var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
      var closed = false;
      function closeWin() {
        if (closed) return;
        closed = true;
        try { window.close(); } catch(e) {}
        // se não fechar (bloqueio do browser), mostra aviso
        setTimeout(function(){
          if (!window.closed) {
            document.body.insertAdjacentHTML('beforeend','<p style="margin-top:12px"><button onclick="window.close()">Fechar</button></p>');
          }
        }, 200);
      }

      // envia mensagem para a janela mãe
      try { if (window.opener) window.opener.postMessage(payload, "*"); } catch (e){}

      // espera ACK da janela mãe e só então fecha com um pequeno delay (1.2s) para o usuário ver
      window.addEventListener("message", function(ev){
        if (!ev || !ev.data) return;
        if (ev.data.type === "wa:ack") {
          setTimeout(closeWin, 1200);
        }
      });

      // fallback: fecha em 15s caso o ACK não chegue
      setTimeout(closeWin, 15000);
    } catch (e) {}
  })();
  </script>
</body></html>`;
    reply.type("text/html").send(html);
  });
}
}
