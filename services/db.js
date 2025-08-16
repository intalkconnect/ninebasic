// services/db.js
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não definido');
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Alias p/ código legado que ainda importa { dbPool }
export const dbPool = pool;

/**
 * Compat: inicializa a pool e testa a conexão.
 * Seu worker pode continuar fazendo: import { initDB } from './services/db.js';
 */
export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1'); // sanity check
    return pool;
  } finally {
    client.release();
  }
}

/**
 * Resolve o subdomínio a partir do Host (ex.: hmg.dkdevs.com.br -> 'hmg')
 * - Se BASE_DOMAIN for informado (ex.: dkdevs.com.br), valida esse sufixo.
 * - Sem BASE_DOMAIN, fallback: se houver >=3 labels, usa a 1ª (ignora 'www').
 */
export function extractSubdomain(
  hostHeader,
  baseDomain = process.env.BASE_DOMAIN
) {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0].toLowerCase().trim();
  if (!host) return null;

  if (isIPAddress(host) || host === 'localhost') return null;

  if (baseDomain && baseDomain.trim()) {
    const bd = baseDomain.toLowerCase().trim();
    if (host === bd) return null;
    const suffix = '.' + bd;
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, -suffix.length);
      return sub && sub !== 'www' ? sub : null;
    }
    return null;
  }

  const parts = host.split('.');
  if (parts.length >= 3) {
    const sub = parts[0];
    return sub && sub !== 'www' ? sub : null;
  }

  return null;
}

function isIPAddress(h) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (h.includes(':')) return true; // IPv6 simplificado
  return false;
}

/**
 * Busca no catálogo global o schema correspondente ao subdomínio.
 * Necessita da tabela public.tenants (bootstrap SQL).
 */
export async function lookupSchemaBySubdomain(subdomain) {
  if (!subdomain) return null;
  const q = 'SELECT schema_name FROM public.tenants WHERE subdomain = $1';
  const { rows } = await pool.query(q, [subdomain]);
  return rows[0]?.schema_name || null;
}

/**
 * Executa callback dentro de uma transação com search_path=<schema>,public.
 * Toda query via "client" já enxerga as tabelas do tenant.
 */
export async function withTenant(schema, fn) {
  if (!schema) throw new Error('schema do tenant ausente');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${pgFormatIdent(schema)}, public`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Escapa identificadores para SET search_path com segurança
 * (equivalente a format('%I', ident) do Postgres).
 */
function pgFormatIdent(ident) {
  if (/^[a-z0-9_]+$/.test(ident)) return ident;
  return `"${String(ident).replace(/"/g, '""')}"`;
}
