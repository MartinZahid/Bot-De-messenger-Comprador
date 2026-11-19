# Messenger Marketplace Bot

Bot automatizado para Facebook Messenger que filtra compradores en la bandeja de entrada de Marketplace usando inteligencia artificial (Groq / LLaMA 3) y notifica por WhatsApp cuando detecta una venta potencial.

## Cómo funciona

1. **Inicia sesión** en messenger.com: desde la página `/login` del bot (login remoto) o con cookies exportadas (`cookies.json`)
2. **Lee la tarjetita de la publicación** (título + precio) de cada conversación de Marketplace para dar contexto al AI
3. **Escanea cada ~20s** la bandeja de entrada de Marketplace buscando mensajes nuevos de compradores
4. **Lee el contexto completo** de cada conversación (historial de mensajes)
5. **Consulta a Groq** (LLaMA 3) para analizar el mensaje y decidir si responder o ignorar
6. **Responde automáticamente** con lenguaje natural, imitando el estilo del vendedor
7. **Notifica por WhatsApp** solo cuando detecta un comprador con intención real de compra
8. **Entra en modo reposo** (5 min) si no hay mensajes nuevos

## Stack

| Componente | Tecnología |
|------------|------------|
| Runtime | Node.js |
| Navegador headless | Puppeteer / Chromium |
| API de IA | Groq SDK (llama-3.3-70b-versatile) |
| Servidor HTTP | Express |
| Notificaciones | WhatsApp (Baileys) |
| Persistencia | JSON (estado.json) |

## Estructura

```
messenger-bot/
├── index.js                  # Punto de entrada
├── .env                      # Variables de entorno
├── cookies.json              # Cookies de messenger.com
├── estado.json               # Estado persistido (se genera solo)
├── wa_session/               # Sesión de WhatsApp vinculada (Baileys)
├── test-whatsapp.js          # Verificación de notificaciones WhatsApp
├── src/
│   ├── config.js             # Constantes, selectores CSS, SYSTEM_PROMPT
│   ├── state.js              # Estado compartido en memoria
│   ├── browser.js            # Puppeteer: login, cookies, diálogos
│   ├── messenger.js          # Messenger: conversaciones, tarjetita, envío
│   ├── groq.js               # Groq: consultas, historial, override de preguntas
│   ├── whatsapp.js           # WhatsApp: notificaciones
│   ├── persistencia.js       # Guardar/cargar estado en disco
│   └── bot.js                # Orquestador: ciclo principal
└── package.json
```

## Configuración

Variables de entorno (`.env`):

| Variable | Obligatorio | Descripción |
|----------|-------------|-------------|
| `GROQ_API_KEY` | Sí | API Key de console.groq.com |
| `WHATSAPP_TO` | No | Tu número personal (donde recibes avisos). Formato E.164 con prefijo `521` para celulares MX (ej. `5216371005468`) |
| `WHATSAPP_NUMBER` | No | Número dedicado que actúa como remitente (se vincula 1 vez, ej. `5216623857440`) |
| `CONTACTO_NUMERO` | No | Número que el bot comparte con los compradores |
| `GROQ_MODEL` | No | Modelo Groq (default: llama-3.3-70b-versatile) |
| `POLL_INTERVAL` | No | Intervalo entre ciclos en ms (default: 20000, min: 10000) |
| `PORT` | No | Puerto HTTP (default: 10000) |
| `HOST` | No | Interfaz donde escucha el servidor HTTP (default: `0.0.0.0`). Usa `127.0.0.1` con Cloudflare Tunnel |
| `LOGIN_PASSWORD` | No | Contraseña de la página `/login` (login remoto). Si no se define, `/login` queda desactivado |

> **Nota sobre números MX**: WhatsApp usa el prefijo `521` (52 + "1" de celular) en los JID. Configurar `WHATSAPP_TO` sin el `1` hará que el mensaje se "envíe" pero nunca llegue.

## Iniciar sesión de Messenger sin cookies (login remoto)

En lugar de exportar y subir `cookies.json`, puedes iniciar sesión directamente en el navegador del servidor:

1. En `.env` pon `LOGIN_PASSWORD=una-contraseña-larga` y reinicia el bot.
2. Abre `http://IP_DEL_SERVIDOR:PUERTO/login` desde el celular o la PC (usuario: cualquiera, contraseña: `LOGIN_PASSWORD`).
3. Pulsa **Iniciar login**. Verás la pantalla del navegador del servidor:
   - Toca un campo en la imagen, escribe en la caja de texto y pulsa **Enviar texto**.
   - Usa los botones Enter / Tab / Borrar cuando haga falta (también sirve para el código de verificación en dos pasos).
4. Cuando ya veas tus chats, pulsa **Ya inicié sesión: guardar**. La sesión se guarda en `cookies.json` y el bot se reinicia solo.

Cuando la sesión expire, el bot te avisa por WhatsApp y solo tienes que repetir estos pasos.

> **Seguridad**: entra siempre por `https://`. Si entras por `http://IP:PUERTO`, la contraseña de Facebook viaja sin cifrar.

### Con Cloudflare Tunnel (recomendado)

Si el servidor ya usa Cloudflare Tunnel (`cloudflared`), publica el bot con un subdominio:

1. Cloudflare → Zero Trust → Networks → Tunnels → tu túnel → **Public Hostname** → *Add*:
   subdominio `bot`, tu dominio, servicio `HTTP` → `localhost:10000`.
   (Si configuras el túnel por archivo, agrega en `config.yml`: `- hostname: bot.tudominio.com` / `service: http://localhost:10000`, antes de la regla `http_status:404`.)
2. En `.env` pon `HOST=127.0.0.1` para que el puerto 10000 no quede abierto a internet; solo se entra por el túnel.
3. Reinicia el bot y entra a `https://bot.tudominio.com/login`.

## WhatsApp (notificaciones)

1. La primera vez, `test-whatsapp.js` genera un QR (guardado también como `wa-qr.png`) o un código de vinculación. Vincúlalo desde el celular: *WhatsApp → Dispositivos vinculados → Vincular dispositivo*.
2. La sesión queda persistida en `wa_session/`; en reinicios posteriores conecta solo, sin pedir QR.
3. Para probar: `node test-whatsapp.js` envía un mensaje de prueba a `WHATSAPP_TO`.

### Despliegue en un servidor

`wa_session/`, `cookies.json`, `.env` y `estado.json` están en `.gitignore` (contienen credenciales) y **no se suben por git**. Para correr el bot en un VPS Linux:

1. Clona el repo en el servidor: `git clone https://github.com/MartinZahid/Bot-De-messenger-Comprador`
2. `npm install` y `npx puppeteer browsers install chrome` (más dependencias del sistema: `libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`)
3. Sube `wa_session/`, `.env` y `cookies.json` desde tu PC por **SCP** (cifrado) y colócalos en la raíz del proyecto
4. Verifica WhatsApp: `node test-whatsapp.js` debe conectar sin pedir QR
5. Corre 24/7 con PM2: `pm2 start index.js --name messenger-bot && pm2 save && pm2 startup`

## Reglas de negocio

Edita `src/config.js` (`DECISION_RULES` y `BUSINESS_RULES`) para ajustar el comportamiento:

- Envíos a domicilio según zona del comprador
- Precio: si la tarjetita tiene precio detectado, lo dice directo; si no, "El precio es el mismo que está en la publicación". **Nunca inventa precios.**
- Medidas/dimensiones (mide, tamaño, alto, ancho, largo): **no responde automáticamente** y te envía un aviso por WhatsApp ("Pregunta de medidas") para que lo manejes tú
- Comparte `CONTACTO_NUMERO` y marca `is_buyer=true` cuando el comprador lo pide
- Si la venta ya se concretó o el comprador envió su dirección, deja de responder (siempre `ignore`)

## Endpoints de debug

| Ruta | Descripción |
|------|-------------|
| `/` | Estado del bot |
| `/health` | Health check (200/503) |
| `/chats` | Conversaciones de Marketplace visibles (requiere `LOGIN_PASSWORD`) |
| `/ss` | Captura de pantalla actual (requiere `LOGIN_PASSWORD`) |
| `/debug-input` | Diagnóstico del cuadro de texto (requiere `LOGIN_PASSWORD`) |
| `/login` | Login remoto de Messenger (requiere `LOGIN_PASSWORD`) |

## Funcionalidades clave

- **Filtro inteligente**: solo procesa conversaciones de Marketplace (ignora chats personales, grupos, notificaciones de seguridad)
- **Contexto de publicación**: scrapea la tarjetita (título + precio) de cada conversación
- **Contexto completo**: scrapea todo el historial del chat antes de consultar a Groq
- **Identificación de remitente**: diferencia mensajes del vendedor y del comprador por la alineación en el DOM
- **No repite respuestas**: detecta si TÚ ya respondiste, si ya diste precio/ubicación, o si la venta se concretó
- **Override de preguntas directas**: si Groq ignora pero el mensaje contiene "precio", "disponible", "ubicación", etc., fuerza una respuesta
- **Envío robusto**: tres estrategias en cascada (botón enviar → evaluate → Enter key)
- **Persistencia**: guarda estado en disco para sobrevivir reinicios
- **Recuperación automática**: detecta sesión expirada y reinicia el navegador
- **MutationObserver**: elimina diálogos de PIN/restaurar mensajes automáticamente
- **Modo idle**: reduce el polling a 5 min cuando no hay actividad
