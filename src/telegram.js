'use strict';

const axios = require('axios');
const { TOKEN, CHAT_ID } = require('./config');

async function sendTelegram(nombre, preview) {
  if (!TOKEN || !CHAT_ID) {
    console.warn('⚠ TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no configurados');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `🛒 *Comprador interesado*\n👤 ${nombre}\n💬 ${preview}\n🕐 ${new Date().toLocaleString('es-MX')}`,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    console.log(`📲 Notificación Telegram enviada: ${nombre}`);
  } catch (err) {
    console.error('⚠ Error al enviar Telegram:', err.message);
  }
}

module.exports = { sendTelegram };
