// backend/routes/oauthCallbacks.js
// Callbacks de OAuth para FB/IG/WA + rota de DEBUG do redirect_uri

export default async function oauthCallbacks(fastify) {
  // --------- CONFIG FIXA ---------
  const CONFIG_ID_FIXED = process.env.META_LOGIN_CONFIG_ID || "1556698225756152";
  const APP_ID_FIXED = process.env.META_APP_ID || null;
  const META_REDIRECT_URI = process.env.META_REDIRECT_URI || null;

  function computeRedirectURI(req, path = "/oauth/wa") {
    const xfProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto = xfProto || req.protocol || "https";
    const xfHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host = xfHost || req.headers.host;
    return `${proto}://${host}${path}`;
  }

  function getRedirectURI(req) {
    return META_REDIRECT_URI || computeRedirectURI(req, "/oauth/wa");
  }

  // ---------- DEBUG ----------
  fastify.get("/wa/debug", async (req, reply) => {
    const redirect_uri = getRedirectURI(req);
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
    var payload = ${
      hasCode
        ? '{ type: "fb:oauth", code: ' + JSON.stringify(code) + ', state: ' + JSON.stringify(state) + " }"
        : '{ type: "fb:oauth:error", error: ' +
          JSON.stringify(error || "missing_code") +
          ", error_description: " +
          JSON.stringify(error_description || "Falha ao autenticar") +
          " }"
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
    var payload = ${
      hasCode
        ? '{ type: "ig:oauth", code: ' + JSON.stringify(code) + ', state: ' + JSON.stringify(state) + " }"
        : '{ type: "ig:oauth:error", error: ' +
          JSON.stringify(error || "missing_code") +
          ", error_description: " +
          JSON.stringify(error_description || "Falha ao autenticar") +
          " }"
    };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch (e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

  // ---------- WHATSAPP (Embedded Signup) ----------
  fastify.get("/wa", async (req, reply) => {
    const q = req.query || {};
    const {
      start,
      code = "",
      state = "",
      app_id = "",
      error = "",
      error_description = "",
    } = q;

    const redirect_uri = getRedirectURI(req);
    const appIdToUse = (APP_ID_FIXED || String(app_id || "")).trim();
    const configIdToUse = CONFIG_ID_FIXED;

    // 1) Etapa inicial: redireciona pro OAuth da Meta
    if (start) {
      fastify.log.info({
        route: "GET /oauth/wa",
        action: "start",
        app_id_sent: app_id,
        app_id_used: appIdToUse,
        config_id_used: configIdToUse,
        state_present: !!state,
        redirect_uri,
      });

      const url =
        "https://www.facebook.com/v24.0/dialog/oauth" +
        "?client_id=" +
        encodeURIComponent(appIdToUse) +
        "&redirect_uri=" +
        encodeURIComponent(redirect_uri) +
        "&response_type=code" +
        "&config_id=" +
        encodeURIComponent(configIdToUse) +
        "&state=" +
        encodeURIComponent(String(state || ""));

      return reply.redirect(url);
    }

    // Se Meta voltar com erro
    if (error || !code) {
      fastify.log.warn({
        route: "GET /oauth/wa",
        action: "callback_error",
        error,
        error_description,
        has_code: !!code,
        state_present: !!state,
      });

      const msg = error
        ? error + ": " + (error_description || "Falha ao autenticar")
        : "Code ausente no retorno do OAuth.";

      const htmlErr = `<!doctype html>
<html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <title>WhatsApp – Erro</title>
    <style>
      body{font:14px system-ui,sans-serif;margin:0}
      #box{padding:16px; max-width:560px; margin:0 auto}
      .err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:8px;border-radius:8px;margin-top:8px}
      pre{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px;overflow:auto}
      .btn{margin-top:10px;background:#111827;color:#fff;border:1px solid #111827;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
    </style>
  </head>
  <body>
    <div id="box">
      <div class="err">${msg.replace(/</g, "&lt;")}</div>
      <pre>${redirect_uri}</pre>
      <button class="btn" onclick="window.close()">Fechar</button>
      <script>
        try {
          var stStr = ${JSON.stringify(state || "")};
          var st = stStr ? JSON.parse(atob(stStr)) : null;
          if (window.opener && st && st.origin) {
            window.opener.postMessage(
              { type: "wa:error", error: ${JSON.stringify(msg)} },
              st.origin
            );
          }
        } catch (e) {}
      </script>
    </div>
  </body>
</html>`;
      reply.type("text/html").send(htmlErr);
      return;
    }

    // 3) Sucesso: renderiza o MESMO HTML/JS que você usava antes (inline)
    fastify.log.info({
      route: "GET /oauth/wa",
      action: "callback_ok",
      state_present: !!state,
    });

    const htmlOk = `<!doctype html>
<html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>WhatsApp – Conectar</title>
    <style>
      body{font:14px system-ui,sans-serif;margin:0}
      #box{padding:16px; max-width:560px; margin:0 auto}
      .err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:8px;border-radius:8px;margin-top:8px}
      .ok{color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;padding:8px;border-radius:8px;margin-top:8px}
      pre{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px;overflow:auto}
      .btn{margin-top:10px;background:#111827;color:#fff;border:1px solid #111827;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
      .row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;margin-top:6px}
      .muted{color:#6b7280}
    </style>
  </head>
  <body>
    <div id="box">
      <div id="status">Finalizando conexão…</div>
      <div id="view"></div>
      <div id="msg"></div>
      <pre id="log" hidden></pre>
    </div>
    <script>
      (function () {
        function $(id){ return document.getElementById(id); }
        function setStatus(t){ $("status").textContent = t; }
        function showErr(t){ $("msg").innerHTML = '<div class="err">' + t + '</div>'; }
        function showOk(t){ $("msg").innerHTML = '<div class="ok">' + t + '</div>'; }
        function setView(h){ $("view").innerHTML = h || ""; }
        function log(){ 
          try { console.log.apply(console, ["[wa-cb]"].concat([].slice.call(arguments))); } catch(e) {}
          try {
            var p = $("log");
            p.hidden = false;
            var parts = [];
            for (var i=0;i<arguments.length;i++) {
              var x = arguments[i];
              parts.push(typeof x === "string" ? x : JSON.stringify(x, null, 2));
            }
            p.textContent += parts.join(" ") + "\\n";
          } catch(e2) {}
        }

        var usp = new URLSearchParams(location.search);
        var code = usp.get("code");
        var stateStr = usp.get("state");

        if (!code) {
          showErr("Login cancelado/negado");
          try {
            var st1 = stateStr ? JSON.parse(atob(stateStr)) : null;
            if (window.opener && st1 && st1.origin) {
              window.opener.postMessage({ type: "wa:error", error: "cancelled" }, st1.origin);
            }
          } catch (e) {}
          setTimeout(function(){ window.close(); }, 1000);
          return;
        }

        (async function () {
          try {
            var st = stateStr ? JSON.parse(atob(stateStr)) : {} ;
            var tenant = st.tenant;
            var origin = st.origin;
            var API_BASE = st.api || "";

            if (!tenant || !origin) throw new Error("state inválido");

            setStatus("Conectando WABA…");
            var finalizeUrl = API_BASE + "/whatsapp/embedded/es/finalize";
            var r = await fetch(finalizeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: code, subdomain: tenant }),
              credentials: "include"
            });
            var j;
            try { j = await r.json(); } catch(e){ j = {}; }
            log("finalize", r.status, j);
            if (!r.ok) throw new Error(j && (j.error || j.message) || ("finalize " + r.status));

            var numbers = Array.isArray(j && j.numbers) ? j.numbers : [];
            if (numbers.length === 0) {
              setStatus("Conta conectada, nenhum número encontrado.");
              showOk("Conexão concluída.");
              try {
                if (window.opener && origin) {
                  window.opener.postMessage({ type: "wa:connected", payload: j }, origin);
                }
              } catch(e){}
              setTimeout(function(){ window.close(); }, 800);
              return;
            }

            setStatus("Selecione o número para ativar");
            var listHtml = "";
            numbers.forEach(function(n) {
              var label = n.display_phone_number || n.verified_name || "—";
              listHtml += '<label class="row">' +
                          '<input type="radio" name="num" value="' + String(n.id) + '">' +
                          '<div>' +
                          '<div><strong>' + label + '</strong></div>' +
                          '<div class="muted">id: ' + String(n.id) + '</div>' +
                          '</div>' +
                          '</label>';
            });

            setView(
              '<div>' + listHtml + '</div>' +
              '<button class="btn" id="confirm">Ativar número selecionado</button>'
            );

            var confirmBtn = document.getElementById("confirm");
            if (confirmBtn) {
              confirmBtn.onclick = async function () {
                try {
                  var sel = document.querySelector('input[name="num"]:checked');
                  if (!sel) { alert("Escolha um número"); return; }
                  var phone_number_id = sel.value;

                  setStatus("Ativando número…");
                  var pickUrl = API_BASE + "/whatsapp/embedded/es/pick-number";
                  var r2 = await fetch(pickUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subdomain: tenant, phone_number_id: phone_number_id }),
                    credentials: "include"
                  });
                  var j2;
                  try { j2 = await r2.json(); } catch(e){ j2 = {}; }
                  log("pick", r2.status, j2);
                  if (!r2.ok) throw new Error(j2 && (j2.error || j2.message) || ("pick-number " + r2.status));

                  showOk("Número ativado.");
                  try {
                    if (window.opener && origin) {
                      window.opener.postMessage(
                        { type: "wa:connected", payload: Object.assign({}, j, { picked: phone_number_id }) },
                        origin
                      );
                    }
                  } catch(e){}
                  setTimeout(function(){ window.close(); }, 700);
                } catch (e) {
                  showErr(String(e && e.message || e));
                }
              };
            }
          } catch (e) {
            showErr(String(e && e.message || e));
            try {
              var st2 = stateStr ? JSON.parse(atob(stateStr)) : null;
              if (window.opener && st2 && st2.origin) {
                window.opener.postMessage(
                  { type: "wa:error", error: String(e && e.message || e) },
                  st2.origin
                );
              }
            } catch (e2) {}
            setTimeout(function(){ window.close(); }, 1200);
          }
        })();
      })();
    </script>
  </body>
</html>`;

    reply.type("text/html").send(htmlOk);
  });
}
