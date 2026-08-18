'use strict';

/**
 * Script de prueba: conecta WhatsApp con el número remitente y envía un
 * mensaje de prueba al número WHATSAPP_TO para verificar que las
 * notificaciones funcionan antes de usar el bot completo.
 *
 * Uso: node test-whatsapp.js
 */

const path = require('path');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
} = require('@whiskeysockets/baileys');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const WHATSAPP_TO = (process.env.WHATSAPP_TO || '').replace(/[^\d]/g, '');
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, '');
const SESION_PATH = path.join(__dirname, 'wa_session');
const DESTINO = WHATSAPP_TO ? `${WHATSAPP_TO}@s.whatsapp.net` : null;
const logger = pino({ level: 'warn' });

if (!WHATSAPP_TO) {
  console.error('❌ WHATSAPP_TO no está configurado en .env');
  process.exit(1);
}

console.log('🧪 TEST WHATSAPP');
console.log(`   Enviará un mensaje de prueba a: ${WHATSAPP_TO}`);
console.log(`   Número remitente (se vinculará si no hay sesión): ${WHATSAPP_NUMBER || '(no configurado)'}`);

async function obtenerVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version) && version.length === 3) return version;
  } catch (e) {
    console.warn(`⚠ No se pudo obtener la versión: ${e.message}. Usando del paquete.`);
  }
  const pkg = require('@whiskeysockets/baileys/package.json');
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  return [major, minor, patch];
}

let timeoutId = null;
function armarTimeout() {
  clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    console.error('⏱ Timeout: no se pudo vincular ni enviar en 10 minutos.');
    process.exit(5);
  }, 600000);
}

async function probar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESION_PATH);
  const version = await obtenerVersion();
  console.log(`📱 Conectando WhatsApp (versión ${version.join('.')})...`);

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    qrTimeout: 180000,
    logger,
  });

  let codigoPendiente = false;
  let enviado = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escanea el QR con WhatsApp del número remitente (Dispositivos vinculados):');
      qrcode.generate(qr, { small: true });
      try {
        const qrPath = path.join(__dirname, 'wa-qr.png');
        await require('qrcode').toFile(qrPath, qr, { width: 400, margin: 2 });
        console.log(`   📄 QR guardado también en: ${qrPath} — ábrelo con visor de imágenes y escanéalo con el celular.`);
      } catch (err) {
        console.warn(`⚠ No se pudo guardar el QR como imagen: ${err.message}`);
      }
      if (WHATSAPP_NUMBER && !codigoPendiente && !state.creds.registered) {
        codigoPendiente = true;
        try {
          const code = await sock.requestPairingCode(WHATSAPP_NUMBER);
          console.log('\n🔗 Código de vinculación para WhatsApp:');
          console.log(`   ${code}`);
          console.log('   En el celular: WhatsApp → Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono → ingresa el código.\n');
        } catch (err) {
          console.error(`⚠ No se pudo generar el código de vinculación: ${err.message}`);
        } finally {
          codigoPendiente = false;
        }
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado. Resolviendo LID del destino...');
      try {
        const resolved = await sock.onWhatsApp(WHATSAPP_TO);
        let destJid = resolved?.[0]?.lid || null;
        if (!destJid) {
          const fs = require('fs');
          const lidPath = path.join(SESION_PATH, `lid-mapping-${WHATSAPP_TO}.json`);
          if (fs.existsSync(lidPath)) {
            const lid = JSON.parse(fs.readFileSync(lidPath, 'utf8'));
            destJid = `${lid}@lid`;
          }
        }
        destJid = destJid || resolved?.[0]?.jid || DESTINO;
        console.log(`   Destino resuelto: ${destJid}`);
        const key = await sock.sendMessage(destJid, {
          text: `🧪 Prueba del bot: notificaciones activadas.\nFecha: ${new Date().toLocaleString('es-MX')}`,
        });
        console.log('📤 Mensaje enviado. Esperando confirmación de entrega...');
        enviado = true;
        verificarEntrega(sock, key.id);
      } catch (err) {
        console.error(`❌ Error enviando el mensaje: ${err.message}`);
        process.exit(2);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        // Puede ser rate-limit de WhatsApp por demasiados intentos.
        // Limpiamos la sesión parcial y reintentamos más tarde con calma.
        console.error('❌ Sesión cerrada (loggedOut). Limpiando sesión y reintentando en 45s...');
        try {
          require('fs').rmSync(SESION_PATH, { recursive: true, force: true });
        } catch (e) { /* ignora */ }
        setTimeout(() => probar(), 45000);
        return;
      }
      // 515 (restartRequired) es normal tras vincular: WhatsApp pide reconectar
      // con las credenciales recién guardadas. Reintentamos la conexión.
      console.warn(`🔄 Conexión cerrada (${statusCode || 'desconocido'}). Reconectando en 15s...`);
      setTimeout(() => probar(), 15000);
      return;
    }
  });

  armarTimeout();
}

function verificarEntrega(sock, messageId) {
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (key.id !== messageId) continue;
      const status = update.status;
      const nombre =
        status === proto.WebMessageInfo.Status.PENDING ? 'PENDING (enviado)' :
        status === proto.WebMessageInfo.Status.SERVER_ACK ? 'SERVER_ACK (recibido por WhatsApp)' :
        status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'DELIVERY_ACK (entregado al celular)' :
        status === proto.WebMessageInfo.Status.READ ? 'READ (leído)' : `estado ${status}`;
      console.log(`   Estado de entrega: ${nombre}`);

      if (status === proto.WebMessageInfo.Status.DELIVERY_ACK || status === proto.WebMessageInfo.Status.READ) {
        console.log('\n✅ El mensaje llegó. Las notificaciones de WhatsApp funcionan.');
        console.log('   Ahora puedes arrancar el bot con: npm start');
        process.exit(0);
      }
    }
  });
}

probar();