/**
 * homebridge-openclaw v2.2.0
 *
 * Exposes a simplified REST API so that an OpenClaw agent can list and
 * control HomeKit devices managed by Homebridge.
 *
 * Security:
 *   - Authenticates with Config UI X internally via JWT (no plaintext
 *     passwords in config.json). Reads .uix-secrets + auth.json directly.
 *   - API token resolved from: env var → file → config → auto-generated.
 *   - Rate-limited. Bind address configurable.
 *
 * Requirements:
 *   - homebridge-config-ui-x (comes with the official Docker image)
 *   - Homebridge started with -I flag (insecure mode)
 */

'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { createHmac } = require('crypto');
const { resolve } = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// ─── Constants ──────────────────────────────────────────────────────────────
const PLUGIN_NAME = 'homebridge-openclaw';
const ACCESSORY_NAME = 'OpenClawAPI';
const VERSION = '2.2.0';
const DEFAULT_PORT = 8899;
const DEFAULT_BIND = '0.0.0.0';
const DEFAULT_RATE_LIMIT = 100; // requests per minute
const DEFAULT_UI_URL = 'http://localhost:8581';
const TOKEN_FILE_NAME = '.openclaw-token';
const TOKEN_ENV_VAR = 'OPENCLAW_HB_TOKEN';

// ─── Helpers: storage path detection ────────────────────────────────────────

function detectStoragePath() {
  if (process.env.UIX_STORAGE_PATH) return process.env.UIX_STORAGE_PATH;
  const candidates = [
    '/var/lib/homebridge',
    resolve(require('os').homedir(), '.homebridge'),
  ];
  for (const p of candidates) {
    if (existsSync(resolve(p, '.uix-secrets'))) return p;
  }
  return candidates[0];
}

// ─── Helpers: API token resolution (4 layers) ───────────────────────────────

function resolveApiToken(config, storagePath, log) {
  // Layer 1: environment variable
  if (process.env[TOKEN_ENV_VAR]) {
    log.info(`[${PLUGIN_NAME}] API token loaded from environment variable ${TOKEN_ENV_VAR}.`);
    return { token: process.env[TOKEN_ENV_VAR], source: 'env' };
  }

  // Layer 2: token file
  const tokenFilePath = resolve(storagePath, TOKEN_FILE_NAME);
  if (existsSync(tokenFilePath)) {
    try {
      const fileToken = readFileSync(tokenFilePath, 'utf8').trim();
      if (fileToken.length >= 16) {
        log.info(`[${PLUGIN_NAME}] API token loaded from ${tokenFilePath}.`);
        return { token: fileToken, source: 'file' };
      }
    } catch (_) { /* fall through */ }
  }

  // Layer 3: config.json field
  if (config.token && config.token.length >= 8) {
    log.info(`[${PLUGIN_NAME}] API token loaded from config.json.`);
    return { token: config.token, source: 'config' };
  }

  // Layer 4: auto-generate from secretKey
  let secretKey = 'openclaw-default-seed';
  try {
    const secrets = JSON.parse(readFileSync(resolve(storagePath, '.uix-secrets'), 'utf8'));
    if (secrets.secretKey) secretKey = secrets.secretKey;
  } catch (_) { /* use default seed */ }

  const generated = createHmac('sha256', secretKey).update('openclaw-hb-api-token').digest('hex').slice(0, 48);

  // Persist to file so OpenClaw can read it
  try {
    writeFileSync(tokenFilePath, generated + '\n', { mode: 0o600 });
    log.info(`[${PLUGIN_NAME}] API token auto-generated and saved to ${tokenFilePath}.`);
  } catch (err) {
    log.warn(`[${PLUGIN_NAME}] Could not write token file: ${err.message}. Token only in logs.`);
  }

  log.info(`[${PLUGIN_NAME}] ────────────────────────────────────────`);
  log.info(`[${PLUGIN_NAME}] API Token: ${generated}`);
  log.info(`[${PLUGIN_NAME}] Configure this token in your OpenClaw agent.`);
  log.info(`[${PLUGIN_NAME}] ────────────────────────────────────────`);

  return { token: generated, source: 'auto' };
}

// ─── UiClient: talks to Config UI X API ─────────────────────────────────────

class UiClient {
  constructor({ storagePath, uiUrl, uiUser, uiPass, log }) {
    this.storagePath = storagePath;
    this.baseUrl = (uiUrl || DEFAULT_UI_URL).replace(/\/+$/, '');
    this.uiUser = uiUser || null;
    this.uiPass = uiPass || null;
    this.log = log;
    this.jwt = null;
    this.jwtExpires = 0;
    this.secretKey = null;
    this.adminUser = null;
    this.instanceId = null;
    this.authMode = 'none'; // 'jwt-direct' | 'login' | 'none'

    this._detectAuthMode();
  }

  /** Detect the best auth strategy available. */
  _detectAuthMode() {
    // Try reading .uix-secrets
    try {
      const secretsPath = resolve(this.storagePath, '.uix-secrets');
      const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
      if (secrets.secretKey) {
        this.secretKey = secrets.secretKey;
        this.instanceId = require('crypto').createHash('sha256').update(secrets.secretKey).digest('hex');
      }
    } catch (_) { /* not available */ }

    // Try reading auth.json for admin username
    try {
      const authPath = resolve(this.storagePath, 'auth.json');
      const users = JSON.parse(readFileSync(authPath, 'utf8'));
      const admin = Array.isArray(users) ? users.find(u => u.admin) : null;
      if (admin) this.adminUser = admin.username;
    } catch (_) { /* not available */ }

    if (this.secretKey && this.adminUser) {
      this.authMode = 'jwt-direct';
      this.log.info(`[${PLUGIN_NAME}] Auth mode: JWT direct (no password needed).`);
    } else if (this.uiUser && this.uiPass) {
      this.authMode = 'login';
      this.log.info(`[${PLUGIN_NAME}] Auth mode: login (credentials from config).`);
    } else {
      this.log.error(`[${PLUGIN_NAME}] Auth mode: none — cannot authenticate with Config UI X!`);
      this.log.error(`[${PLUGIN_NAME}] Ensure .uix-secrets exists or provide homebridgeUiUser/homebridgeUiPass.`);
    }
  }

  /** Sign a JWT using the same format Config UI X expects. */
  _signJwt() {
    const payload = {
      username: this.adminUser,
      name: this.adminUser,
      admin: true,
      instanceId: this.instanceId,
    };
    return jwt.sign(payload, this.secretKey, { expiresIn: '8h' });
  }

  /** Get a valid token (refresh if needed). */
  async token() {
    if (this.authMode === 'jwt-direct') {
      if (!this.jwt || Date.now() >= this.jwtExpires) {
        this.jwt = this._signJwt();
        this.jwtExpires = Date.now() + 7 * 3600 * 1000; // refresh in 7h
      }
      return this.jwt;
    }

    if (this.authMode === 'login') {
      if (!this.jwt || Date.now() >= this.jwtExpires) {
        await this._loginAuth();
      }
      return this.jwt;
    }

    throw new Error('No authentication method available for Config UI X.');
  }

  /** Authenticate via HTTP login (fallback). */
  async _loginAuth() {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.uiUser, password: this.uiPass, otp: '' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Config UI login failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.jwt = data.access_token;
    this.jwtExpires = Date.now() + ((data.expires_in || 28800) - 60) * 1000;
  }

  /** GET /api/accessories */
  async getAccessories() {
    const tok = await this.token();
    const res = await fetch(`${this.baseUrl}/api/accessories`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET /api/accessories → ${res.status}`);
    return res.json();
  }

  /** PUT /api/accessories/:uniqueId */
  async setCharacteristic(uniqueId, characteristicType, value) {
    const tok = await this.token();
    const res = await fetch(`${this.baseUrl}/api/accessories/${encodeURIComponent(uniqueId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ characteristicType, value }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${characteristicType} → ${res.status}: ${text}`);
    }
    return res.json();
  }
}

// ─── Accessory data parsing ─────────────────────────────────────────────────

function parseAccessories(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const devices = [];
  for (const svc of list) {
    const name = svc.serviceName || svc.accessoryInformation?.Name || '';
    const type = svc.humanType || svc.type || 'Unknown';
    const uid = svc.uniqueId;
    if (!uid || type === 'AccessoryInformation' || type === 'ProtocolInformation') continue;
    if (name.toLowerCase() === 'openclaw api') continue;

    const chars = (svc.serviceCharacteristics || []);
    const writableChars = chars.filter(c => c.canWrite).map(c => c.type);

    devices.push({
      id: uid,
      name,
      type: mapType(type),
      humanType: type,
      state: svc.values || {},
      characteristics: writableChars,
      manufacturer: svc.accessoryInformation?.Manufacturer || '',
      model: svc.accessoryInformation?.Model || '',
    });
  }
  return devices;
}

function mapType(humanType) {
  const t = (humanType || '').toLowerCase();
  if (t.includes('light') || t.includes('bulb')) return 'lightbulb';
  if (t.includes('switch')) return 'switch';
  if (t.includes('outlet')) return 'outlet';
  if (t.includes('thermostat')) return 'thermostat';
  if (t.includes('lock')) return 'lock';
  if (t.includes('fan')) return 'fan';
  if (t.includes('window') || t.includes('blind') || t.includes('covering')) return 'blinds';
  if (t.includes('garage')) return 'garage';
  if (t.includes('motion')) return 'motion';
  if (t.includes('temperature')) return 'sensor';
  if (t.includes('humidity')) return 'sensor';
  if (t.includes('contact')) return 'sensor';
  if (t.includes('camera')) return 'camera';
  return 'other';
}

// ─── Action resolution ──────────────────────────────────────────────────────

const MODE_MAP = { off: 0, heat: 1, cool: 2, auto: 3 };

function resolveAction(action, value) {
  switch (action) {
    case 'on': case 'power':
      return { characteristicType: 'On', value: Boolean(value) };
    case 'toggle':
      return { characteristicType: 'On', value: Boolean(value) };
    case 'brightness': case 'dim':
      return { characteristicType: 'Brightness', value: clamp(value, 0, 100) };
    case 'hue':
      return { characteristicType: 'Hue', value: clamp(value, 0, 360) };
    case 'saturation':
      return { characteristicType: 'Saturation', value: clamp(value, 0, 100) };
    case 'color': {
      const ops = [];
      if (value?.hue !== undefined) ops.push({ characteristicType: 'Hue', value: Number(value.hue) });
      if (value?.saturation !== undefined) ops.push({ characteristicType: 'Saturation', value: Number(value.saturation) });
      return ops;
    }
    case 'colorTemperature': case 'ct':
      return { characteristicType: 'ColorTemperature', value: Number(value) };
    case 'targetTemperature': case 'temperature':
      return { characteristicType: 'TargetTemperature', value: Number(value) };
    case 'thermostatMode': case 'mode':
      return { characteristicType: 'TargetHeatingCoolingState', value: MODE_MAP[String(value).toLowerCase()] ?? Number(value) };
    case 'lock':
      return { characteristicType: 'LockTargetState', value: value ? 1 : 0 };
    case 'speed': case 'rotationSpeed':
      return { characteristicType: 'RotationSpeed', value: clamp(value, 0, 100) };
    case 'position': case 'targetPosition':
      return { characteristicType: 'TargetPosition', value: clamp(value, 0, 100) };
    case 'tilt': case 'targetTilt':
      return { characteristicType: 'TargetHorizontalTiltAngle', value: clamp(value, -90, 90) };
    case 'garageDoor': case 'garage':
      return { characteristicType: 'TargetDoorState', value: value ? 0 : 1 };
    default:
      return null;
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v))); }

// ─── Express routes ─────────────────────────────────────────────────────────

function setupRoutes(app, apiToken, uiClient) {
  // Auth middleware
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ') || h.substring(7) !== apiToken) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing Bearer token.' });
    }
    next();
  }

  // Health (no auth, sanitized)
  app.get('/health', async (_req, res) => {
    let deviceCount = 0;
    let connected = false;
    try {
      const raw = await uiClient.getAccessories();
      deviceCount = parseAccessories(raw).length;
      connected = true;
    } catch (_) { /* silent */ }
    res.json({
      status: connected ? 'ok' : 'degraded',
      plugin: PLUGIN_NAME,
      version: VERSION,
      timestamp: new Date().toISOString(),
      devices: deviceCount,
    });
  });

  // List devices
  app.get('/api/devices', auth, async (_req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw);
      res.json({ success: true, count: devices.length, devices });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  // List by type
  app.get('/api/devices/type/:type', auth, async (req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw).filter(d => d.type === req.params.type.toLowerCase());
      res.json({ success: true, count: devices.length, devices });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  // Get single device
  app.get('/api/devices/:id', auth, async (req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const device = parseAccessories(raw).find(d => d.id === req.params.id);
      if (!device) return res.status(404).json({ error: 'Not Found', message: `Device '${req.params.id}' not found.` });
      res.json({ success: true, device });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  // Control single device
  app.post('/api/devices/:id/control', auth, async (req, res) => {
    const { action, value } = req.body || {};
    if (!action) return res.status(400).json({ error: 'Bad Request', message: 'Missing "action".' });
    const resolved = resolveAction(action, value);
    if (!resolved) return res.status(400).json({ error: 'Bad Request', message: `Unknown action: ${action}.` });
    try {
      const ops = Array.isArray(resolved) ? resolved : [resolved];
      const results = [];
      for (const op of ops) {
        results.push(await uiClient.setCharacteristic(req.params.id, op.characteristicType, op.value));
      }
      res.json({ success: true, id: req.params.id, action, results });
    } catch (err) {
      res.status(502).json({ error: 'Control error', message: err.message });
    }
  });

  // Control multiple devices
  app.post('/api/devices/control', auth, async (req, res) => {
    const { devices } = req.body || {};
    if (!Array.isArray(devices)) return res.status(400).json({ error: 'Bad Request', message: 'Expected "devices" array.' });
    const results = [];
    for (const item of devices) {
      const resolved = resolveAction(item.action, item.value);
      if (!resolved) { results.push({ id: item.id, success: false, error: `Unknown action: ${item.action}` }); continue; }
      try {
        const ops = Array.isArray(resolved) ? resolved : [resolved];
        for (const op of ops) await uiClient.setCharacteristic(item.id, op.characteristicType, op.value);
        results.push({ id: item.id, success: true });
      } catch (err) {
        results.push({ id: item.id, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  });
}

// ─── Homebridge registration ────────────────────────────────────────────────

module.exports = function (api) {
  api.registerPlatform(PLUGIN_NAME, ACCESSORY_NAME, OpenClawPlatform);
};

class OpenClawPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.name = config.name || 'OpenClaw API';

    const storagePath = detectStoragePath();
    this.storagePath = storagePath;

    // Resolve API token (what OpenClaw sends to us)
    const { token: apiToken } = resolveApiToken(config, storagePath, log);
    this.apiToken = apiToken;

    // Create UI client (how we talk to Config UI X)
    this.uiClient = new UiClient({
      storagePath,
      uiUrl: config.homebridgeUiUrl,
      uiUser: config.homebridgeUiUser,
      uiPass: config.homebridgeUiPass,
      log,
    });

    api.on('didFinishLaunching', () => this._startServer());
  }

  async _startServer() {
    const port = this.config.apiPort || DEFAULT_PORT;
    const bind = this.config.apiBind || DEFAULT_BIND;
    const rpmLimit = this.config.rateLimit || DEFAULT_RATE_LIMIT;

    // Verify auth works
    try {
      await this.uiClient.token();
      this.log.info(`[${PLUGIN_NAME}] Connected to Config UI X (${this.uiClient.authMode}).`);
    } catch (err) {
      this.log.error(`[${PLUGIN_NAME}] Config UI X auth failed: ${err.message}`);
    }

    const app = express();
    app.use(express.json());
    app.set('trust proxy', 1);

    // Rate limiting
    app.use(rateLimit({
      windowMs: 60 * 1000,
      max: rpmLimit,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too Many Requests', message: `Rate limit: ${rpmLimit} requests per minute.` },
    }));

    setupRoutes(app, this.apiToken, this.uiClient);

    const server = app.listen(port, bind, () => {
      this.log.info(`[${PLUGIN_NAME}] REST API listening on ${bind}:${port}`);
    });
    server.on('error', err => {
      this.log.error(`[${PLUGIN_NAME}] Server error: ${err.message}`);
    });
  }

}
