// services/metaGraph.js
// Helper minimalista para Graph API (GET/POST) com tratamento de erro padronizado.
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';

function buildUrl(path, qs = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}${path}`);
  Object.entries(qs).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  return url.toString();
}

async function gget(path, { token, qs } = {}) {
  const url = buildUrl(path, qs);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `GET ${path} ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json?.error;
    throw err;
  }
  return json;
}

async function gpost(path, { token, form, json } = {}) {
  const url = buildUrl(path);
  const headers = {};
  let body;

  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form || {}).toString();
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method: 'POST', headers, body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = out?.error?.message || `POST ${path} ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = out?.error;
    throw err;
  }
  return out;
}

export { gget, gpost };
export default { gget, gpost };
