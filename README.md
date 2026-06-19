# Messenger Marketplace Bot

Bot automatizado para Facebook Messenger que filtra compradores en la bandeja de entrada de Marketplace usando inteligencia artificial (Groq / LLaMA 3) y notifica por Telegram cuando detecta una venta potencial.

## Cómo funciona

1. **Inicia sesión** en messenger.com con cookies exportadas desde el navegador (`cookies.json`)
2. **Escanea cada ~20s** la bandeja de entrada de Marketplace buscando mensajes nuevos de compradores
3. **Lee el contexto completo** de cada conversación (historial de mensajes)
4. **Consulta a Groq** (LLaMA 3) para analizar el mensaje y decidir si responder o ignorar
5. **Responde automáticamente** con lenguaje natural, imitando el estilo del vendedor
6. **Notifica por Telegram** solo cuando detecta un comprador con intención real de compra
7. **Entra en modo reposo** (5 min) si no hay mensajes nuevos

## Stack

| Componente | Tecnología |
|------------|------------|
| Runtime | Node.js |
| Navegador headless | Puppeteer / Chromium |
| API de IA | Groq SDK (llama-3.3-70b-versatile) |
| Servidor HTTP | Express |
| Notificaciones | Telegram Bot API |
| Persistencia | JSON (estado.json) |

## Estructura

```
messenger-bot/
├── index.js                  # Punto de entrada
├── .env                      # Variables de entorno
├── cookies.json              # Cookies de messenger.com
├── estado.json               # Estado persistido (se genera solo)
├── src/
│   ├── config.js             # Constantes, selectores CSS, SYSTEM_PROMPT
│   ├── state.js              # Estado compartido en memoria
│   ├── browser.js            # Puppeteer: login, cookies, diálogos
│   ├── messenger.js          # Messenger: conversaciones, mensajes, envío
│   ├── groq.js               # Groq: consultas, historial, override de preguntas
│   ├── telegram.js           # Telegram: notificaciones
│   ├── server.js             # Express: endpoints de debug
│   ├── persistencia.js       # Guardar/cargar estado en disco
│   └── bot.js                # Orquestador: ciclo principal
└── package.json
```

## Configuración

Variables de entorno (`.env`):

| Variable | Obligatorio | Descripción |
|----------|-------------|-------------|
| `GROQ_API_KEY` | Sí | API Key de console.groq.com |
| `TELEGRAM_TOKEN` | No | Token de BotFather para notificaciones |
| `TELEGRAM_CHAT_ID` | No | ID numérico del chat de Telegram |
| `GROQ_MODEL` | No | Modelo Groq (default: llama-3.3-70b-versatile) |
| `POLL_INTERVAL` | No | Intervalo entre ciclos en ms (default: 20000, min: 10000) |
| `PORT` | No | Puerto HTTP (default: 10000) |

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
- **Contexto completo**: scrapea todo el historial del chat antes de consultar a Groq
- **Identificación de remitente**: diferencia mensajes del vendedor y del comprador por la alineación en el DOM
- **Detección de reacciones**: ignora "reaccionó a tu mensaje" para no reprocesar sin motivo
- **Override de preguntas directas**: si Groq ignora pero el mensaje contiene "precio", "disponible", "ubicación", etc., fuerza una respuesta
- **Envío robusto**: tres estrategias en cascada (botón enviar → evaluate → Enter key)
- **Persistencia**: guarda estado en disco para sobrevivir reinicios
- **Recuperación automática**: detecta sesión expirada y reinicia el navegador
- **MutationObserver**: elimina diálogos de PIN/restaurar mensajes automáticamente
- **Modo idle**: reduce el polling a 5 min cuando no hay actividad
