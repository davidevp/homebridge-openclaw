# homebridge-openclaw

**EN** — Homebridge plugin that exposes a simplified REST API so an [OpenClaw](https://docs.openclaw.ai) agent can list and control HomeKit devices.

**ES** — Plugin para Homebridge que expone una API REST simplificada para que un agente de [OpenClaw](https://docs.openclaw.ai) pueda listar y controlar dispositivos HomeKit.

---

- [English](#english)
- [Español](#español)

---

## English

### Requirements

- **homebridge-config-ui-x** installed (included in the official Docker image).
- Homebridge started with the **`-I`** (insecure) flag so the UI can read/write characteristics.

### Installation

```bash
npm install homebridge-openclaw
```

Or via **Homebridge Config UI X**: Plugins → search “openclaw” → Install.

### Minimum configuration

Add to your Homebridge `config.json` under **`platforms`**:

```json
{
  "platform": "OpenClawAPI",
  "name": "OpenClaw API"
}
```

That’s it. The plugin will:

- Detect the UI credentials automatically (reads `.uix-secrets` and `auth.json` from the filesystem).
- Generate a unique API token and save it to `.openclaw-token`.
- Listen on port 8899.

### Advanced configuration

```json
{
  "platform": "OpenClawAPI",
  "name": "OpenClaw API",
  "apiPort": 8899,
  "apiBind": "0.0.0.0",
  "token": "my-custom-token",
  "rateLimit": 100,
  "homebridgeUiUrl": "http://localhost:8581",
  "homebridgeUiUser": "admin",
  "homebridgeUiPass": "admin"
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `apiPort` | number | 8899 | REST server port |
| `apiBind` | string | `0.0.0.0` | Bind address (`127.0.0.1` = local only) |
| `token` | string | auto | Bearer token for OpenClaw API calls |
| `rateLimit` | number | 100 | Max requests per minute per IP |
| `homebridgeUiUrl` | string | `http://localhost:8581` | Config UI X URL (only if not default) |
| `homebridgeUiUser` | string | auto | UI username (only if auto-detection fails) |
| `homebridgeUiPass` | string | auto | UI password (only if auto-detection fails) |

### Security

**Internal auth (plugin → Config UI X)**  
The plugin reads Homebridge internal files (`.uix-secrets` and `auth.json`) to sign valid JWTs. **No username or password is required in `config.json`.**  
Only if those files are unavailable (e.g. non-Docker setups), `homebridgeUiUser` / `homebridgeUiPass` are used as fallback.

**API token (OpenClaw → plugin)**  
Resolved in this order:

1. **Environment variable** `OPENCLAW_HB_TOKEN` — ideal for Docker Compose / Kubernetes.
2. **File** `.openclaw-token` in Homebridge storage — ideal if OpenClaw has filesystem access (same NAS, shared volume).
3. **`token`** in `config.json` — manual fallback.
4. **Auto-generated** — if none of the above exist, a unique token is generated (HMAC of Homebridge secretKey), saved to `.openclaw-token`, and printed in the logs.

**Rate limiting**  
Default: 100 requests per minute per IP. Configurable via `rateLimit`.

### Getting the token for OpenClaw

**Option A: Read the file (recommended)**  
After first start, the token is in:

```
/var/lib/homebridge/.openclaw-token
```

If using Docker with a mounted volume (e.g. `/Volumes/docker/HomeBridge`):

```bash
cat /Volumes/docker/HomeBridge/.openclaw-token
```

**Option B: Check the logs**  
On first start, the token is printed in the Homebridge logs:

```
[homebridge-openclaw] ────────────────────────────────────────
[homebridge-openclaw] API Token: abc123...
[homebridge-openclaw] Configure this token in your OpenClaw agent.
[homebridge-openclaw] ────────────────────────────────────────
```

**Option C: Environment variable**  
In Docker Compose:

```yaml
environment:
  - OPENCLAW_HB_TOKEN=my-shared-token
```

Configure the same value in OpenClaw.

### REST API

Base URL: `http://<homebridge-ip>:8899`

All requests (except `/health`) require:

```
Authorization: Bearer <token>
```

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/devices` | GET | Yes | List all devices |
| `/api/devices/type/<type>` | GET | Yes | List by type (e.g. `switch`, `lightbulb`) |
| `/api/devices/<id>` | GET | Yes | Device state |
| `/api/devices/<id>/control` | POST | Yes | Control one device |
| `/api/devices/control` | POST | Yes | Control multiple devices |

**Health (no auth)**

```
GET /health
```

**Control one device**

```
POST /api/devices/<id>/control
Content-Type: application/json

{ "action": "on", "value": true }
```

**Control multiple devices**

```
POST /api/devices/control
Content-Type: application/json

{
  "devices": [
    { "id": "xxx", "action": "on", "value": true },
    { "id": "yyy", "action": "on", "value": false }
  ]
}
```

**Supported actions**

| Action | Value | Devices |
|--------|-------|---------|
| `on` / `power` | `true` / `false` | switch, lightbulb, outlet, fan |
| `brightness` / `dim` | 0–100 | lightbulb |
| `hue` | 0–360 | RGB lightbulb |
| `saturation` | 0–100 | RGB lightbulb |
| `color` | `{ "hue": 240, "saturation": 100 }` | RGB lightbulb |
| `colorTemperature` / `ct` | mired | lightbulb |
| `targetTemperature` / `temperature` | 10–35 | thermostat |
| `thermostatMode` / `mode` | `off` / `heat` / `cool` / `auto` | thermostat |
| `lock` | `true` / `false` | lock |
| `speed` / `rotationSpeed` | 0–100 | fan |
| `position` / `targetPosition` | 0–100 | blinds |
| `tilt` / `targetTilt` | -90 to 90 | blinds |
| `garageDoor` / `garage` | `true`=open / `false`=close | garage |

### Using from OpenClaw

Example with `exec` and `curl`:

```bash
# List devices
exec('curl -s -H "Authorization: Bearer TOKEN" http://HOMEBRIDGE_IP:8899/api/devices')

# Turn on a light
exec('curl -s -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d \'{"action":"on","value":true}\' http://HOMEBRIDGE_IP:8899/api/devices/DEVICE_ID/control')
```

### License

MIT — see [LICENSE](LICENSE).

---

## Español

### Requisitos

- **homebridge-config-ui-x** instalado (viene con la imagen Docker oficial).
- Homebridge iniciado con la bandera **`-I`** (modo inseguro) para que el UI pueda leer/escribir características.

### Instalación

```bash
npm install homebridge-openclaw
```

O desde **Homebridge Config UI X**: Plugins → buscar “openclaw” → Instalar.

### Configuración mínima

Añadir al `config.json` de Homebridge en la sección **`platforms`**:

```json
{
  "platform": "OpenClawAPI",
  "name": "OpenClaw API"
}
```

Con eso basta. El plugin:

- Detecta automáticamente las credenciales del UI (lee `.uix-secrets` y `auth.json` del sistema de archivos).
- Genera un token API único y lo guarda en `.openclaw-token`.
- Escucha en el puerto 8899.

### Configuración avanzada

```json
{
  "platform": "OpenClawAPI",
  "name": "OpenClaw API",
  "apiPort": 8899,
  "apiBind": "0.0.0.0",
  "token": "mi-token-personalizado",
  "rateLimit": 100,
  "homebridgeUiUrl": "http://localhost:8581",
  "homebridgeUiUser": "admin",
  "homebridgeUiPass": "admin"
}
```

| Parámetro | Tipo | Por defecto | Descripción |
|-----------|------|-------------|-------------|
| `apiPort` | number | 8899 | Puerto del servidor REST |
| `apiBind` | string | `0.0.0.0` | Dirección de bind (`127.0.0.1` = solo local) |
| `token` | string | auto | Token Bearer para autenticar llamadas de OpenClaw |
| `rateLimit` | number | 100 | Máximo de peticiones por minuto por IP |
| `homebridgeUiUrl` | string | `http://localhost:8581` | URL del Config UI X (solo si no es la por defecto) |
| `homebridgeUiUser` | string | auto | Usuario del UI (solo si falla la auto-detección) |
| `homebridgeUiPass` | string | auto | Contraseña del UI (solo si falla la auto-detección) |

### Seguridad

**Autenticación interna (plugin → Config UI X)**  
El plugin lee los archivos internos de Homebridge (`.uix-secrets` y `auth.json`) para firmar JWTs válidos. **No necesita usuario ni contraseña en `config.json`.**  
Solo si esos archivos no están disponibles (p. ej. instalaciones no-Docker), se usan `homebridgeUiUser` / `homebridgeUiPass` como respaldo.

**Token API (OpenClaw → plugin)**  
Se resuelve en este orden:

1. **Variable de entorno** `OPENCLAW_HB_TOKEN` — ideal para Docker Compose / Kubernetes.
2. **Archivo** `.openclaw-token` en el directorio de almacenamiento de Homebridge — ideal si OpenClaw tiene acceso al sistema de archivos (mismo NAS, volumen compartido).
3. **Campo `token`** en `config.json` — respaldo manual.
4. **Auto-generado** — si no existe ninguna de las anteriores, se genera un token único (HMAC del secretKey de Homebridge), se guarda en `.openclaw-token` y se muestra en los logs.

**Rate limiting**  
Por defecto: 100 peticiones por minuto por IP. Configurable con `rateLimit`.

### Obtener el token para OpenClaw

**Opción A: Leer el archivo (recomendado)**  
Tras el primer arranque, el token está en:

```
/var/lib/homebridge/.openclaw-token
```

Si usas Docker y el volumen está montado (ej.: `/Volumes/docker/HomeBridge`):

```bash
cat /Volumes/docker/HomeBridge/.openclaw-token
```

**Opción B: Ver los logs**  
En el primer arranque, el token aparece en los logs de Homebridge:

```
[homebridge-openclaw] ────────────────────────────────────────
[homebridge-openclaw] API Token: abc123...
[homebridge-openclaw] Configure this token in your OpenClaw agent.
[homebridge-openclaw] ────────────────────────────────────────
```

**Opción C: Variable de entorno**  
En Docker Compose:

```yaml
environment:
  - OPENCLAW_HB_TOKEN=mi-token-compartido
```

Configurar el mismo valor en OpenClaw.

### API REST

URL base: `http://<ip-homebridge>:8899`

Todas las peticiones (excepto `/health`) requieren:

```
Authorization: Bearer <token>
```

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/health` | GET | No | Comprobación de estado |
| `/api/devices` | GET | Sí | Listar todos los dispositivos |
| `/api/devices/type/<tipo>` | GET | Sí | Listar por tipo (ej. `switch`, `lightbulb`) |
| `/api/devices/<id>` | GET | Sí | Estado de un dispositivo |
| `/api/devices/<id>/control` | POST | Sí | Controlar un dispositivo |
| `/api/devices/control` | POST | Sí | Controlar varios dispositivos |

**Health (sin auth)**

```
GET /health
```

**Controlar un dispositivo**

```
POST /api/devices/<id>/control
Content-Type: application/json

{ "action": "on", "value": true }
```

**Controlar varios dispositivos**

```
POST /api/devices/control
Content-Type: application/json

{
  "devices": [
    { "id": "xxx", "action": "on", "value": true },
    { "id": "yyy", "action": "on", "value": false }
  ]
}
```

**Acciones soportadas**

| Acción | Valor | Dispositivos |
|--------|-------|--------------|
| `on` / `power` | `true` / `false` | switch, lightbulb, outlet, fan |
| `brightness` / `dim` | 0–100 | lightbulb |
| `hue` | 0–360 | lightbulb RGB |
| `saturation` | 0–100 | lightbulb RGB |
| `color` | `{ "hue": 240, "saturation": 100 }` | lightbulb RGB |
| `colorTemperature` / `ct` | mired | lightbulb |
| `targetTemperature` / `temperature` | 10–35 | thermostat |
| `thermostatMode` / `mode` | `off` / `heat` / `cool` / `auto` | thermostat |
| `lock` | `true` / `false` | lock |
| `speed` / `rotationSpeed` | 0–100 | fan |
| `position` / `targetPosition` | 0–100 | blinds |
| `tilt` / `targetTilt` | -90 a 90 | blinds |
| `garageDoor` / `garage` | `true`=abrir / `false`=cerrar | garage |

### Uso desde OpenClaw

Ejemplo con `exec` y `curl`:

```bash
# Listar dispositivos
exec('curl -s -H "Authorization: Bearer TOKEN" http://IP_HOMEBRIDGE:8899/api/devices')

# Encender una luz
exec('curl -s -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d \'{"action":"on","value":true}\' http://IP_HOMEBRIDGE:8899/api/devices/DEVICE_ID/control')
```

### Licencia

MIT — ver [LICENSE](LICENSE).
