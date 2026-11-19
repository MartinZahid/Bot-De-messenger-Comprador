# Messenger Marketplace Bot

Bot automatizado para Facebook Messenger que filtra compradores en la bandeja de entrada de Marketplace usando inteligencia artificial (Groq / LLaMA 3) y notifica por WhatsApp cuando detecta una venta potencial.

## Cómo funciona

1. **Inicia sesión** en messenger.com con cookies exportadas desde el navegador (`cookies.json`)
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

> **Nota sobre números MX**: WhatsApp usa el prefijo `521` (52 + "1" de celular) en los JID. Configurar `WHATSAPP_TO` sin el `1` hará que el mensaje se "envíe" pero nunca llegue.

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
| `/chats` | Conversaciones de Marketplace visibles |
| `/ss` | Captura de pantalla actual |
| `/debug-input` | Diagnóstico del cuadro de texto |

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
