'use strict';

const axios = require('axios');
const { TOKEN, CHAT_ID } = require('./config');

/** @type {string|null} Chat ID actual de Telegram (auto-detectado o del .env). */
let chatIdActual = CHAT_ID;

/**
 * Envía una notificación de comprador interesado a Telegram.
 *
 * @param {string} nombre - Nombre del comprador.
 * @param {string} preview - Preview del último mensaje.
 * @returns {Promise<boolean>} true si se envió correctamente.
 */
async function sendTelegram(nombre, preview) {
  if (!TOKEN || !chatIdActual) {
    console.warn('⚠ TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no configurados');
    return false;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatIdActual,
      text: `🛒 *Comprador interesado*\n👤 ${nombre}\n💬 ${preview}\n🕐 ${new Date().toLocaleString('es-MX')}`,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    console.log(`📲 Notificación Telegram enviada: ${nombre}`);
    return true;
  } catch (err) {
    console.error(`⚠ Error al enviar Telegram: ${err.message}`);
    return false;
  }
}

/**
 * Detecta automáticamente el chat ID de Telegram a partir de los últimos updates.
 * Útil si el usuario no configuró TELEGRAM_CHAT_ID en .env pero ya envió /start al bot.
 *
 * @returns {Promise<boolean>} true si se detectó o confirmó el chat ID.
 */
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
    console.error(`⚠ Error detectando chat ID: ${err.message}`);
    return false;
  }
}

/**
 * Envía una alerta del sistema (sesión expirada, errores, etc.) a Telegram.
 *
 * @param {string} asunto - Título de la alerta.
 * @param {string} mensaje - Cuerpo del mensaje.
 * @returns {Promise<boolean>} true si se envió correctamente.
 */
async function enviarAlerta(asunto, mensaje) {
  if (!TOKEN || !chatIdActual) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatIdActual,
      text: `⚠️ *${asunto}*\n${mensaje}\n🕐 ${new Date().toLocaleString('es-MX')}`,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    console.log(`📲 Alerta Telegram enviada: ${asunto}`);
    return true;
  } catch (err) {
    console.error(`⚠ Error al enviar alerta Telegram: ${err.message}`);
    return false;
  }
}

module.exports = { sendTelegram, autoDetectarChatId, enviarAlerta };
