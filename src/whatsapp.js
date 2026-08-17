'use strict';

const path = require('path');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { WHATSAPP_TO, WHATSAPP_NUMBER } = require('./config');
const { sleep } = require('./config');

const SESION_PATH = path.join(__dirname, '..', 'wa_session');
const ID_DESTINO = WHATSAPP_TO ? `${WHATSAPP_TO}@s.whatsapp.net` : null;
const logger = pino({ level: 'error' });

let sock = null;
let waReady = false;
let codigoPendiente = null;
const colaMensajes = [];

/**
 * Obtiene la versión de WhatsApp Web a usar. Si fetchLatestBaileysVersion
 * falla (issue conocido #1990), cae a la versión por defecto del paquete.
 * @returns {Promise<Array<number>>} Versión [major, minor, patch].
 */
async function obtenerVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version) && version.length === 3) {
      return version;
    }
  } catch (e) {
    console.warn(`⚠ No se pudo obtener la versión de WhatsApp Web: ${e.message}. Usando versión del paquete.`);
  }
  const pkg = require('@whiskeysockets/baileys/package.json');
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  return [major, minor, patch];
}

/**
 * Imprime (o devuelve) el QR en formato texto para escanear desde el celular.
 * @param {string} qr - String del QR emitido por Baileys.
 */
function mostrarQR(qr) {
  console.log('\n📱 Escanea el QR con WhatsApp del número remitente (Dispositivos vinculados):');
  qrcode.generate(qr, { small: true });
}

/**
 * Vincula el número remitente usando código de enlace (ideal para servidores
 * sin pantalla). Se llama una sola vez cuando no hay sesión guardada.
 * @param {string} number - Número en formato E.164 sin '+'.
 */
async function solicitarCodigoVinculacion(number) {
  if (!sock || codigoPendiente) return;
  codigoPendiente = true;
  try {
    const code = await sock.requestPairingCode(number);
    console.log('\n🔗 Código de vinculación para WhatsApp:');
    console.log(`   ${code}`);
    console.log('   En el celular: WhatsApp → Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono → ingresa el código.\n');
  } catch (err) {
    console.error(`⚠ No se pudo generar el código de vinculación: ${err.message}`);
  } finally {
    codigoPendiente = false;
  }
}

/**
 * Inicializa la sesión de WhatsApp con el número remitente.
 * Persiste credenciales en wa_session/ para no volver a vincular en reinicios.
 * No bloquea el arranque del bot: notificaciones llegan cuando la sesión esté lista.
 */
async function iniciarWhatsApp() {
  if (!WHATSAPP_TO) {
    console.warn('⚠ WHATSAPP_TO no configurado. Las notificaciones por WhatsApp están deshabilitadas.');
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESION_PATH);
  const version = await obtenerVersion();
  console.log(`📱 Conectando WhatsApp (versión ${version.join('.')})...`);

  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      mostrarQR(qr);
      if (WHATSAPP_NUMBER) {
        await solicitarCodigoVinculacion(WHATSAPP_NUMBER);
      }
    }

    if (connection === 'open') {
      waReady = true;
      console.log('✅ WhatsApp conectado. Notificaciones activadas.');
      await drenarCola();
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('❌ WhatsApp cerró sesión (loggedOut). Vuelve a vincular el número remitente.');
        waReady = false;
        return;
      }
      console.warn(`⚠ WhatsApp desconectado (${statusCode || 'desconocido'}). Reintentando en 10s...`);
      waReady = false;
      await sleep(10000);
      try {
        await iniciarWhatsApp();
      } catch (e) {
        console.error(`⚠ Error reconectando WhatsApp: ${e.message}`);
      }
    }
  });
}

/**
 * Normaliza un número a formato E.164 sin símbolos.
 * @param {string} numero - Número tal como viene de .env.
 * @returns {string} Número limpio.
 */
function limpiarNumero(numero) {
  return String(numero).replace(/[^\d]/g, '');
}

/**
 * Envía una notificación de comprador interesado a tu WhatsApp personal.
 * Si la sesión aún no está lista, encola el mensaje para enviarlo al conectar.
 *
 * @param {string} nombre - Nombre del comprador.
 * @param {string} preview - Preview del último mensaje.
 * @returns {Promise<boolean>} true si se envió o se encoló correctamente.
 */
async function sendWhatsApp(nombre, preview) {
  if (!WHATSAPP_TO) {
    console.warn('⚠ WHATSAPP_TO no configurado');
    return false;
  }
  const texto = `🛒 *Comprador interesado*\n👤 ${nombre}\n💬 ${preview}\n🕐 ${new Date().toLocaleString('es-MX')}`;
  return enviarTexto(texto);
}

/**
 * Envía una alerta del sistema (sesión expirada, errores, etc.) a tu WhatsApp.
 *
 * @param {string} asunto - Título de la alerta.
 * @param {string} mensaje - Cuerpo del mensaje.
 * @returns {Promise<boolean>} true si se envió o se encoló correctamente.
 */
async function enviarAlerta(asunto, mensaje) {
  if (!WHATSAPP_TO) return false;
  const texto = `⚠️ *${asunto}*\n${mensaje}\n🕐 ${new Date().toLocaleString('es-MX')}`;
  return enviarTexto(texto);
}

/**
 * Envía un texto al destino configurado, encolando si no hay sesión.
 * @param {string} texto - Mensaje a enviar.
 * @returns {Promise<boolean>} true si se envió o se encoló.
 */
async function enviarTexto(texto) {
  if (!sock || !waReady) {
    colaMensajes.push(texto);
    console.log(`📦 WhatsApp no listo, mensaje encolado (${colaMensajes.length} pendiente(s))`);
    return true;
  }
  try {
    await sock.sendMessage(ID_DESTINO, { text: texto });
    console.log('📲 Notificación WhatsApp enviada');
    return true;
  } catch (err) {
    console.error(`⚠ Error al enviar WhatsApp: ${err.message}`);
    colaMensajes.push(texto);
    return false;
  }
}

/**
 * Envía los mensajes que quedaron encolados mientras la sesión estaba desconectada.
 */
async function drenarCola() {
  while (colaMensajes.length > 0) {
    const texto = colaMensajes.shift();
    try {
      await sock.sendMessage(ID_DESTINO, { text: texto });
    } catch (err) {
      console.error(`⚠ Error enviando mensaje encolado: ${err.message}`);
      colaMensajes.unshift(texto);
      break;
    }
  }
}

module.exports = { iniciarWhatsApp, sendWhatsApp, enviarAlerta };
