// services/metaGraph.js
const fetchImpl = (...a) => import('node-fetch').then(({default: f}) => f(...a));

const GV = process.env.GRAPH_VERSION || 'v23.0';
const G = (p) => `https://graph.facebook.com/${GV}${p}`;

async function gget(path, { token, qs } = {}) {
  const url = new URL(G(path));
  if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `GET ${url} ${r.status}`);
  return j;
}

async function gpost(path, { token, form, json } = {}) {
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
  const r = await fetchImpl(G(path), { method: 'POST', headers, body });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `POST ${path} ${r.status}`);
  return j;
}

module.exports = { gget, gpost };
