'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 10000;
const POLL_MS = Math.max(10000, parseInt(process.env.POLL_INTERVAL) || 20000);
const IDLE_MS = 300000;
const COOKIES_PATH = path.join(__dirname, '..', 'cookies.json');
const WHATSAPP_TO = process.env.WHATSAPP_TO ? (process.env.WHATSAPP_TO.includes('@') ? process.env.WHATSAPP_TO : process.env.WHATSAPP_TO.replace(/[^\d]/g, '')) : null;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER ? process.env.WHATSAPP_NUMBER.replace(/[^\d]/g, '') : null;
const CONTACTO_NUMERO = process.env.CONTACTO_NUMERO || '';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_HISTORIAL = 10;
const MAX_MESSAGES_SCRAPED = 15;
const BATCH_SIZE = 3;
const GROQ_BACKOFF_BASE_MS = 5000;
const GROQ_BACKOFF_MAX_MS = 120000;
const GROQ_MAX_RETRIES = 5;

/**
 * Selectores CSS para elementos del DOM de Messenger.
 * Si Facebook actualiza su UI, editar aquí.
 */
const SEL = {
  CONV_LINK: 'a[href*="/t/"]',
  SPANS: 'span',
  INPUT: [
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label="Message"]',
    'div[aria-label="Mensaje"]',
    'div[aria-label="Aa"]',
    '[data-lexical-editor="true"]',
    'div.notranslate[contenteditable="true"]',
    'div[spellcheck="true"]',
    '[contenteditable="true"]',
    'textarea',
  ],
  BACK: '[aria-label="Messenger"], [aria-label="Home"], [aria-label="Inicio"]',
  SEND_BUTTON: 'div[role="button"][aria-label="Enviar"], div[role="button"][aria-label="Send"]',
  SEND_BUTTON_ALT: 'div[role="button"]',
};

/** Palabras clave de cuentas del sistema de Facebook (no son compradores). */
const SISTEMA = [
  'marketplace', 'facebook', 'meta', 'soporte', 'support',
  'asistencia', 'notificaciones', 'notifications', 'instagram',
  'chats', 'grupos', 'groups', 'solicitudes', 'requests',
];

/**
 * Fragmentos del aviso de seguridad de Marketplace/Facebook. Meta divide el
 * mensaje en varios spans del DOM, por eso se detecta por fragmentos y no por
 * la frase completa.
 */
const SISTEMA_AVISOS = [
  'consejos de seguridad',
  'reunir con alguien',
  'familiares y amigos',
  'amigos adónde vas',
  'compartir la ubicación',
  'ubicación en tiempo real',
  'en tiempo real',
];

/**
 * Detecta si un texto corresponde al aviso de seguridad de Marketplace.
 * @param {string} texto - Texto a evaluar.
 * @returns {boolean} true si parece un aviso de seguridad.
 */
function esAvisoSeguridad(texto) {
  if (!texto) return false;
  const t = String(texto).toLowerCase();
  return SISTEMA_AVISOS.some(f => t.includes(f));
}

/**
 * Reglas de negocio editables. Estas se inyectan en el prompt del sistema.
 * Separadas del formato de respuesta para facilitar mantenimiento.
 */
const BUSINESS_RULES = {
  ubicacion: 'Estás al sur de la ciudad. Haces envíos a domicilio según la zona del comprador, pero NUNCA inventes colonias, costos de envío ni detalles de entrega. Esa información la da el vendedor personalmente.',
  precio: 'El precio es el de la publicación, no se negocia. NUNCA inventes un precio.',
  contacto: `Tu número de contacto (WhatsApp/celular) es ${CONTACTO_NUMERO}.`,
  tono: `CÓMO HABLAS:
- Tono amable, cercano, como chat normal.
- Mensajes cortos, sin sonar a plantilla.
- Nada de "¡Hola! Qué gusto saludarte" — empieza directo pero con buena onda.
- Puedes usar "oye", "va", "tdbn", "porfa".
- Nada de emojis en exceso, máximo 3 si ayuda.`,
};

/**
 * Formato de salida JSON que Groq debe retornar.
 * Separado de las reglas de negocio para independencia.
 */
const FORMAT_INSTRUCTIONS = `RESPONDE ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin código.
NO incluyas explicaciones fuera del JSON.

FORMATO EXACTO:
{"action":"reply","message":"tu respuesta aquí","is_buyer":false}

Donde:
- "action": "reply" para responder, "ignore" para no responder
- "message": tu mensaje de respuesta (solo si action es "reply")
- "is_buyer": true si el comprador tiene intención real de compra`;

/**
 * Reglas de decisión para el AI. Definen cuándo responder e ignorar.
 * Editar aquí para ajustar el comportamiento del bot.
 */
const DECISION_RULES = `REGLAS PARA NO REPETIR RESPUESTAS:
- Si el ÚLTIMO mensaje del historial es "Vendedor: ..." significa que TÚ ya respondiste. NO vuelvas a responder. Usa action "ignore".
- Si el vendedor ya respondió a la última pregunta del comprador, ignora. No respondas dos veces.
- Si el vendedor ya dio información (precio, ubicación, disponibilidad) y el comprador no ha preguntado algo nuevo, ignora.

INSTRUCCIONES:
1. Responde siempre en español, con tono amable y natural, COMO EL VENDEDOR (no como el comprador).
2. Analiza el HISTORIAL COMPLETO de la conversación con los prefijos Vendedor/Comprador para entender el contexto. No repitas información que ya diste antes en la misma conversación.
3. Si la venta YA ESTÁ CONCRETADA (se acordó un encuentro, se confirmó la compra, o el comprador ya te pasó su dirección/ubicación): usa action "ignore" SIEMPRE, sin importar lo que escriba después. No respondas más.
4. Si preguntan si haces envíos a domicilio: responde que SÍ, aclarando que depende de la zona/ubicación del comprador.
5. Si preguntan por disponibilidad: confirma que está disponible y pregunta si le interesa.
6. Si preguntan por precio:
   - Si el precio de la publicación fue detectado automáticamente (aparece en el historial como "Precio: $..."), dilo directo (ej. "Está en $450,000").
   - Si NO se pudo detectar precio, di "El precio es el mismo que está en la publicación."
   - NUNCA inventes un precio si no viene del scraping de la publicación.
7. Si preguntan por medidas o dimensiones (mide, mide cuánto, tamaño, dimensiones, alto, ancho, largo): NO respondas automáticamente. El vendedor lo maneja personalmente.
8. Si preguntan por ubicación: di "Estoy al sur de la ciudad" y ofrece envío a domicilio según zona. NO inventes colonias, zonas específicas ni costos de envío. Pregunta de dónde es el comprador SOLO si es necesario (si ya dijo su zona antes en la conversación, no vuelvas a preguntar).
9. Si piden tu número, teléfono, WhatsApp o contacto directamente: compártelo (${CONTACTO_NUMERO}) y marca is_buyer=true.
10. Si el comprador muestra INTERÉS REAL DE COMPRA (quiere ir a verte, pide tu ubicación exacta, dice "lo quiero", "lo compro", "voy", "ahora", "me queda cerca", "pasame tu dirección", etc.): responde confirmando y marca is_buyer=true.
11. Si el mensaje es un consejo de seguridad automatizado de Marketplace: ignóralo, haz caso al último mensaje real del comprador.
12. Si el mensaje es un saludo, una pregunta sobre el producto, disponibilidad o precio: RESPONDE amablemente.
13. Solo usa action "ignore" si es claramente Spam, un grupo abandonado, no tiene relación con la venta, o si TÚ ya respondiste.
14. Si el comprador ya te pasó la ubicación (mapa o dirección), ya no respondas. Usa action "ignore".
15. Si el comprador comparte ubicación (mapa) o dice "voy", "en camino", "ahí voy", "paso mañana", "ya voy": no respondas, usa action "ignore".
16. Si el comprador solo dice "gracias", "ok", "sale", "va", "perfecto": usa action "ignore".
17. Si el comprador dice dónde está o comparte su ubicación ("estoy en X", mapa, colonia): NO respondas. El vendedor lo maneja personalmente (es una venta).
18. NUNCA inventes información: ni precios, ni colonias, ni costos de envío, ni detalles de entrega. Si no lo sabes, no lo inventes y deja que el vendedor responda.

IMPORTANTE:
- Eres el VENDEDOR. No respondas como si fueras el comprador.
- Si ves "Vendedor:" en el historial como último mensaje, NO respondas.`;

/**
 * Construye el prompt completo del sistema concatenando reglas de negocio
 * con reglas de decisión y formato de salida.
 * @returns {string} Prompt completo para Groq.
 */
function buildSystemPrompt() {
  return [
    `ERES: vendedor en Marketplace. ${BUSINESS_RULES.ubicacion} ${BUSINESS_RULES.precio}`,
    '',
    BUSINESS_RULES.tono,
    '',
    `FORMATO DEL HISTORIAL:
- "Vendedor:" = mensajes que ya enviaste TÚ (el vendedor).
- "Comprador:" = mensajes del comprador.
- Analiza quién dijo qué antes de decidir.`,
    '',
    DECISION_RULES,
    '',
    FORMAT_INSTRUCTIONS,
  ].join('\n');
}

/** Prompt cacheado — se construye una vez al cargar el módulo. */
const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * @param {number} ms - Milisegundos a esperar.
 * @returns {Promise<void>}
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {number} min - Mínimo (inclusivo).
 * @param {number} max - Máximo (inclusivo).
 * @returns {number} Entero aleatorio entre min y max.
 */
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * @param {string} s - Cadena a hashear.
 * @returns {string} Hash MD5 en hexadecimal.
 */
const hash = s => {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(s).digest('hex');
};

module.exports = {
  PORT, POLL_MS, IDLE_MS, COOKIES_PATH, WHATSAPP_TO, WHATSAPP_NUMBER, CONTACTO_NUMERO,
  GROQ_KEY, GROQ_MODEL,
  MAX_HISTORIAL, MAX_MESSAGES_SCRAPED, BATCH_SIZE,
  GROQ_BACKOFF_BASE_MS, GROQ_BACKOFF_MAX_MS, GROQ_MAX_RETRIES,
  SEL, SISTEMA, SISTEMA_AVISOS, esAvisoSeguridad, SYSTEM_PROMPT, BUSINESS_RULES, DECISION_RULES, FORMAT_INSTRUCTIONS,
  buildSystemPrompt, sleep, rnd, hash,
};
