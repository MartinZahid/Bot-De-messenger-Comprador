'use strict';

const axios = require('axios');
const { TOKEN, CHAT_ID } = require('./config');

let chatIdActual = CHAT_ID;

async function sendTelegram(nombre, preview) {
  if (!TOKEN || !chatIdActual) {
    console.warn('⚠ TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no configurados');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatIdActual,
      text: `🛒 *Comprador interesado*\n👤 ${nombre}\n💬 ${preview}\n🕐 ${new Date().toLocaleString('es-MX')}`,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    console.log(`📲 Notificación Telegram enviada: ${nombre}`);
  } catch (err) {
    console.error('⚠ Error al enviar Telegram:', err.message);
  }
}

async function autoDetectarChatId() {
  if (!TOKEN) return false;
  try {
    const { data } = await axios.get(`https://api.telegram.org/bot${TOKEN}/getUpdates`, { timeout: 10000 });
    if (!data.ok || !data.result || data.result.length === 0) {
      console.log('📱 No hay mensajes en Telegram. Envía /start al bot y vuelve a iniciar.');
      return false;
    }
    const chat = data.result[0].message?.chat;
    if (chat && chat.id && chat.id !== chatIdActual) {
      chatIdActual = chat.id;
      console.log(`✅ Chat ID detectado automáticamente: ${chatIdActual} (${chat.first_name || ''} ${chat.last_name || ''})`);
      await sendTelegram('Info', 'Bot conectado. Notificaciones activadas.');
      return true;
    }
    if (chat && chat.id === chatIdActual) {
      console.log(`📱 Chat ID confirmado: ${chatIdActual}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('⚠ Error detectando chat ID:', err.message);
    return false;
  }
}

module.exports = { sendTelegram, autoDetectarChatId };
