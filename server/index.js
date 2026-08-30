import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());
app.use(express.static(publicDir));

const SOS_BASE_URL = process.env.SOS_BASE_URL || 'https://api.sos-contador.com';
const SOS_TARGET_CUIT = String(process.env.SOS_TARGET_CUIT || '20260964233').replace(/\D/g, '');
const SOS_RECEIVABLES_PATH = process.env.SOS_RECEIVABLES_PATH || '';

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} falló (${response.status}): ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} devolvió una respuesta no JSON.`); }
}

async function sosLogin() {
  if (!process.env.SOS_USER || !process.env.SOS_PASSWORD) {
    throw new Error('Faltan SOS_USER o SOS_PASSWORD en variables de entorno.');
  }
  const response = await fetch(`${SOS_BASE_URL}/api-comunidad/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: process.env.SOS_USER, password: process.env.SOS_PASSWORD })
  });
  return readJson(response, 'SOS login');
}

function extractUserJwt(data) {
  return data?.jwt || data?.token || data?.data?.jwt || data?.data?.token;
}

function getCuitNumber(item) {
  const candidates = [item?.cuit, item?.numeroCuit, item?.cuitNumero, item?.numero, item?.taxId, item?.identificacion];
  for (const value of candidates) {
    const normalized = String(value ?? '').replace(/\D/g, '');
    if (normalized.length >= 10) return normalized;
  }
  return '';
}

function findTargetCuit(cuits, target) {
  if (!Array.isArray(cuits)) return null;
  return cuits.find(c => getCuitNumber(c) === target) || null;
}

async function getCuitToken(userJwt, cuitId) {
  const response = await fetch(`${SOS_BASE_URL}/api-comunidad/cuit/credentials/${encodeURIComponent(cuitId)}`, {
    headers: bearer(userJwt)
  });
  const data = await readJson(response, 'Credenciales de CUIT SOS');
  const token = data?.jwt || data?.token || data?.data?.jwt || data?.data?.token;
  if (!token) throw new Error('SOS no devolvió Token de CUIT en un campo reconocido.');
  return { token, raw: data };
}

async function getSosSession() {
  const login = await sosLogin();
  const userJwt = extractUserJwt(login);
  if (!userJwt) throw new Error('SOS no devolvió JWT de usuario.');
  const cuits = login?.cuits || login?.data?.cuits || [];
  const selected = findTargetCuit(cuits, SOS_TARGET_CUIT);
  if (!selected) {
    const available = cuits.map(getCuitNumber).filter(Boolean);
    throw new Error(`El CUIT ${SOS_TARGET_CUIT} no aparece entre las CUIT habilitadas para este usuario.${available.length ? ` Disponibles: ${available.join(', ')}` : ''}`);
  }
  const cuitId = selected?.id ?? selected?._id ?? selected?.cuitId;
  if (cuitId == null) throw new Error('Encontré el CUIT objetivo pero SOS no devolvió su id.');
  const { token } = await getCuitToken(userJwt, cuitId);
  return { cuitToken: token, cuit: SOS_TARGET_CUIT, cuitId };
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return null;
  let s = String(value).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes('.') && s.includes(',')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  s = s.replace(/[^0-9.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clientName(row) {
  return row?.razonSocial || row?.nombre || row?.denominacion || row?.cliente || row?.nombreFantasia || row?.apellidoNombre || row?.descripcion || `Cliente ${row?.id ?? ''}`.trim();
}

const BALANCE_KEYS = [
  'saldo', 'saldoCuentaCorriente', 'saldoCtaCte', 'saldoCliente', 'saldoPendiente', 'pendiente',
  'deuda', 'debe', 'importePendiente', 'saldoDeudor', 'montoPendiente', 'totalPendiente'
];

function extractBalance(row) {
  for (const key of BALANCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row || {}, key)) {
      const n = toNumber(row[key]);
      if (n != null) return { value: n, field: key };
    }
  }
  const nested = [row?.cuentaCorriente, row?.ctaCte, row?.saldos, row?.resumen];
  for (const obj of nested) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of BALANCE_KEYS) {
      const n = toNumber(obj[key]);
      if (n != null) return { value: n, field: key };
    }
  }
  return null;
}


const SOS_DISCOVERY_PATHS = [
  '/api-comunidad/cuenta-corriente/listado',
  '/api-comunidad/cuentacorriente/listado',
  '/api-comunidad/cuentaCorriente/listado',
  '/api-comunidad/cliente/cuenta-corriente',
  '/api-comunidad/cliente/cuentacorriente',
  '/api-comunidad/cliente/saldos',
  '/api-comunidad/cliente/saldo',
  '/api-comunidad/cuentas-corrientes',
  '/api-comunidad/cuentas-corrientes/listado',
  '/api-comunidad/quien-me-debe',
  '/api-comunidad/quienmedebe',
  '/api-comunidad/deudores',
  '/api-comunidad/deudores/listado',
  '/api-comunidad/cobranzas/saldos',
  '/api-comunidad/cobros/saldos'
];

function looksLikeReceivablesPayload(payload) {
  const rows = rowsFromPayload(payload);
  if (!rows.length) return false;
  return rows.some(row => extractBalance(row) || Object.keys(row || {}).some(k => /saldo|deuda|pend|debe|cobrar|importe/i.test(k)));
}

async function discoverReceivablesEndpoint(cuitToken) {
  const attempts = [];
  for (const pathName of SOS_DISCOVERY_PATHS) {
    const variants = [
      pathName,
      `${pathName}?cliente=true&registros=200&pagina=1`,
      `${pathName}?registros=200&pagina=1`
    ];
    for (const rel of variants) {
      try {
        const response = await fetch(`${SOS_BASE_URL}${rel}`, { headers: bearer(cuitToken) });
        const text = await response.text();
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        const entry = { path: rel, status: response.status, contentType: response.headers.get('content-type') || '', preview: text.slice(0, 240) };
        if (response.ok && payload && looksLikeReceivablesPayload(payload)) {
          entry.match = true;
          return { found: true, path: rel, payload, attempts: [...attempts, entry] };
        }
        attempts.push(entry);
      } catch (error) {
        attempts.push({ path: rel, status: 0, preview: error.message });
      }
    }
  }
  return { found: false, attempts };
}
function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.items, payload?.registros, payload?.clientes, payload?.data, payload?.resultados, payload?.content];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

async function fetchAllClients(cuitToken) {
  const all = [];
  const registros = 200;
  for (let pagina = 1; pagina <= 100; pagina++) {
    const url = `${SOS_BASE_URL}/api-comunidad/cliente/listado?proveedor=false&cliente=true&registros=${registros}&pagina=${pagina}`;
    const response = await fetch(url, { headers: bearer(cuitToken) });
    const payload = await readJson(response, `Listado de clientes SOS (página ${pagina})`);
    const rows = rowsFromPayload(payload);
    all.push(...rows);
    if (rows.length < registros) break;
  }
  return all;
}

function summarizeRows(rows) {
  const map = new Map();
  let detectedField = null;
  for (const row of rows) {
    const balance = extractBalance(row);
    if (!balance) continue;
    detectedField ||= balance.field;
    // Para cuentas a cobrar mostramos únicamente saldos deudores positivos.
    if (balance.value <= 0) continue;
    const name = clientName(row);
    map.set(name, (map.get(name) || 0) + balance.value);
  }
  const items = [...map.entries()].map(([cliente, saldo]) => ({ cliente, saldo })).sort((a, b) => b.saldo - a.saldo);
  return { items, detectedField };
}

async function fetchReceivablesFromConfiguredEndpoint(cuitToken) {
  if (!SOS_RECEIVABLES_PATH) return null;
  const url = SOS_RECEIVABLES_PATH.startsWith('http') ? SOS_RECEIVABLES_PATH : `${SOS_BASE_URL}${SOS_RECEIVABLES_PATH}`;
  const response = await fetch(url, { headers: bearer(cuitToken) });
  const payload = await readJson(response, 'Cuentas a cobrar SOS');
  return { payload, rows: rowsFromPayload(payload), source: 'endpoint-configurado' };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'CMP', sosConfigured: Boolean(process.env.SOS_USER && process.env.SOS_PASSWORD), targetCuit: SOS_TARGET_CUIT });
});

app.post('/api/sos/test-login', async (_req, res) => {
  try {
    const session = await getSosSession();
    res.json({ ok: true, cuit: session.cuit, cuitId: session.cuitId, message: 'Autenticación SOS y selección de CUIT correctas.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get('/api/sos/descubrir-cuentas-corrientes', async (_req, res) => {
  try {
    const session = await getSosSession();
    const result = await discoverReceivablesEndpoint(session.cuitToken);
    if (!result.found) {
      return res.status(404).json({
        ok: false,
        cuit: session.cuit,
        error: 'No se encontró automáticamente un endpoint de cuentas corrientes entre las rutas de solo lectura probadas.',
        attempts: result.attempts
      });
    }
    const rows = rowsFromPayload(result.payload);
    const summary = summarizeRows(rows);
    const total = summary.items.reduce((acc, x) => acc + x.saldo, 0);
    res.json({
      ok: true,
      cuit: session.cuit,
      discoveredPath: result.path,
      detectedBalanceField: summary.detectedField,
      items: summary.items,
      total,
      attempts: result.attempts
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
app.get('/api/sos/cuentas-a-cobrar', async (_req, res) => {
  try {
    const session = await getSosSession();
    const configured = await fetchReceivablesFromConfiguredEndpoint(session.cuitToken);
    let sourceRows;
    let source = configured?.source || null;
    let discoveredPath = null;

    if (configured) {
      sourceRows = configured.rows;
    } else {
      const discovered = await discoverReceivablesEndpoint(session.cuitToken);
      if (discovered.found) {
        sourceRows = rowsFromPayload(discovered.payload);
        source = 'endpoint-auto-descubierto';
        discoveredPath = discovered.path;
      } else {
        sourceRows = await fetchAllClients(session.cuitToken);
        source = 'cliente-listado';
      }
    }

    const summary = summarizeRows(sourceRows);

    if (!summary.detectedField) {
      return res.status(424).json({
        ok: false,
        cuit: session.cuit,
        error: 'La conexión con SOS funciona, pero todavía no se identificó un campo de saldo de cuenta corriente.',
        diagnostic: { source, discoveredPath, registrosLeidos: sourceRows.length, camposEjemplo: Object.keys(sourceRows[0] || {}).slice(0, 50) }
      });
    }

    const total = summary.items.reduce((acc, x) => acc + x.saldo, 0);
    res.json({
      ok: true,
      cuit: session.cuit,
      source,
      discoveredPath,
      detectedBalanceField: summary.detectedField,
      items: summary.items,
      total,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`CMP escuchando en http://localhost:${port}`));
