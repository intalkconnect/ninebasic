// server/routes/oauth-callbacks.js
export default async function oauthCallbacks(fastify) {
  // GET /oauth/fb
  fastify.get("/fb", async (req, reply) => {
    const { code = "", state = "" } = req.query || {};
    const html = `<!doctype html>
<html><body><script>
(function(){
  try {
    var payload = { type: "fb:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch(e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

  // GET /oauth/ig
  fastify.get("/ig", async (req, reply) => {
    const { code = "", state = "" } = req.query || {};
    const html = `<!doctype html>
<html><body><script>
(function(){
  try {
    var payload = { type: "ig:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch(e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });

  // GET /oauth/wa
  fastify.get("/wa", async (req, reply) => {
    const { code = "", state = "" } = req.query || {};
    const html = `<!doctype html>
<html><body><script>
(function(){
  try {
    var payload = { type: "wa:oauth", code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} };
    if (window.opener) window.opener.postMessage(payload, "*");
  } catch(e) {}
  window.close();
})();
</script>Feche esta janela.</body></html>`;
    reply.type("text/html").send(html);
  });
}
