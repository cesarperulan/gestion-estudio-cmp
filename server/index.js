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

app.get('/api/sos/cuentas-a-cobrar', async (_req, res) => {
  try {
    const session = await getSosSession();
    const configured = await fetchReceivablesFromConfiguredEndpoint(session.cuitToken);
    const sourceRows = configured ? configured.rows : await fetchAllClients(session.cuitToken);
    const summary = summarizeRows(sourceRows);

    if (!summary.detectedField && !configured) {
      return res.status(424).json({
        ok: false,
        cuit: session.cuit,
        error: 'La conexión con SOS y el CUIT funcionaron, pero el listado de clientes no expone un campo de saldo reconocible. Falta configurar SOS_RECEIVABLES_PATH con el endpoint específico de cuentas corrientes de la documentación SOS.',
        diagnostic: { clientesLeidos: sourceRows.length, camposEjemplo: Object.keys(sourceRows[0] || {}).slice(0, 40) }
      });
    }

    const total = summary.items.reduce((acc, x) => acc + x.saldo, 0);
    res.json({
      ok: true,
      cuit: session.cuit,
      source: configured?.source || 'cliente-listado',
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
