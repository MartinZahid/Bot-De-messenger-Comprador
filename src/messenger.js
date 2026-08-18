'use strict';

const path = require('path');
const state = require('./state');
const { SEL, SISTEMA, SISTEMA_AVISOS, sleep, rnd } = require('./config');

/**
 * @typedef {Object} Conversacion
 * @property {string} nombre - Nombre del contact/usuario.
 * @property {string} preview - Preview del último mensaje visible en el sidebar.
 * @property {string} ultimo - Último mensaje relevante (sin timestamps ni reacciones).
 * @property {number} indice - Índice del enlace en el DOM.
 * @property {boolean} esPropio - true si el último mensaje es nuestro (Tú:/You:).
 * @property {boolean} esHumano - true si hay algún mensaje "Tú:" o "You:" en la conversación.
 * @property {boolean} esSistema - true si el último mensaje es del sistema de Marketplace.
 * @property {boolean} esSticker - true si el último mensaje es un sticker/emoji.
 */

/**
 * Normaliza el nombre de una conversación para usarlo como clave estable en
 * los Map de estado (processed, filtros, historial, publicaciones).
 *
 * Convierte a minúsculas y colapsa espacios/saltos de línea. NO toca el
 * identificador de la publicación: dos publicaciones distintas (p. ej.
 * "Esperanza · Cortinas Blackout Para ventana 280x220cm" vs
 * "Esperanza · Cortinas blackout") siguen siendo claves separadas, pero una
 * misma conversación cuyo título varíe en mayúsculas o en saltos de línea
 * mantiene la misma clave.
 *
 * @param {string} nombre - Nombre crudo extraído del sidebar.
 * @returns {string} Clave normalizada.
 */
function normalizarClave(nombre) {
  return String(nombre || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Obtiene la lista de conversaciones visibles en el sidebar de Marketplace.
 * Extrae nombre, preview, último mensaje relevante y clasifica cada una.
 *
 * @returns {Promise<Conversacion[]>} Lista de conversaciones filtradas.
 */
async function obtenerConversaciones() {
  const { page } = state;
  return await page.evaluate((linkSelector, spanSelector, palabrasSistema, avisos) => {
    const enlaces = document.querySelectorAll(linkSelector);
    return Array.from(enlaces).map((el, idx) => {
      const spans = el.querySelectorAll(spanSelector);
      const textos = Array.from(spans)
        .map(s => s.textContent.trim())
        .filter(Boolean);
      const esAviso = t => avisos.some(f => t.toLowerCase().includes(f));
      const preview = textos.length >= 3
        ? textos.slice(1, -1).join(' ').replace(/\s+/g, ' ')
        : (textos[1] || textos[textos.length - 1] || '');
      const ultimo = textos.slice().reverse().find(t => {
        if (!t) return false;
        if (t === textos[0]) return false;
        if (/^\d+\s*(min|h|sem|día|días|año|años|sem)$/i.test(t)) return false;
        if (/^[·\-—\s]+$/.test(t)) return false;
        if (/reaccionó a (tu|su|mi) mensaje/i.test(t)) return false;
        if (/reaccionó a/i.test(t)) return false;
        if (t.includes('consejos de seguridad') || t.includes('reunir con alguien en persona')) return false;
        if (esAviso(t)) return false;
        return true;
      });
      const esHumano = textos.some(t => t.startsWith('Tú:') || t.startsWith('You:'));
      const esPropio = ultimo
        ? ultimo.startsWith('Tú:') || ultimo.startsWith('You:')
        : false;
      const esSistema = ultimo
        ? ultimo.includes('consejos de seguridad') || ultimo.includes('reunir con alguien en persona') || esAviso(ultimo)
        : false;
      const esSticker = ultimo
        ? /^[👍❤️😊😂😍🎉🔥💯✅❌‼️❓🆗🔄⭐💪]+$/.test(ultimo) || ultimo.includes('sticker') || ultimo.includes('Sticker') || ultimo.length < 3
        : false;
      return {
        nombre: textos[0] || '',
        preview: preview,
        ultimo: ultimo || preview,
        indice: idx,
        esPropio,
        esHumano,
        esSistema,
        esSticker,
      };
    }).filter(c => {
      if (!c.nombre) return false;
      const n = c.nombre.toLowerCase();
      if (palabrasSistema.some(p => n.includes(p))) return false;
      if (!c.nombre.includes(' · ')) return false;
      return true;
    });
  }, SEL.CONV_LINK, SEL.SPANS, SISTEMA, SISTEMA_AVISOS).then(lista =>
    lista.map(c => ({ ...c, clave: normalizarClave(c.nombre) }))
  );
}

/**
 * Scrapea los mensajes visibles del chat actual.
 * Identifica al vendedor (justify-content: flex-end) vs comprador
 * y retorna un historial con prefijos "Vendedor:" / "Comprador:".
 *
 * @returns {Promise<string[]>} Lista de mensajes formateados (últimos 15).
 */
async function scrapearMensajes() {
  const { page } = state;
  await sleep(1000);
  try {
    await page.waitForFunction(() => {
      const m = document.querySelector('[role="main"], [role="region"], [role="grid"]');
      return m && m.offsetParent !== null;
    }, { timeout: 8000 });
  } catch (e) {
    console.warn(`⚠ Timeout esperando área de mensajes: ${e.message}`);
  }

  if (page.isClosed()) return [];

  return await page.evaluate((avisos) => {
    const esAviso = t => avisos.some(f => t.toLowerCase().includes(f));
    const visitados = new Set();
    const area = document.querySelector('[role="main"]') || document.querySelector('[role="region"]') || document.body;
    const mensajes = [];
    const spans = area.querySelectorAll('span');

    for (const span of spans) {
      const t = (span.textContent || '').trim();
      if (!t || t.length < 2) continue;
      if (/^\d{1,2}:\d{2}$/.test(t)) continue;
      if (/^\d+\s*(min|h|sem|día|año)/i.test(t)) continue;
      if (t.includes('consejos de seguridad') || t.includes('reunir con alguien en persona')) continue;
      if (esAviso(t)) continue;
      if (/reaccionó a (tu|su|mi) mensaje/i.test(t)) continue;
      if (t === 'Enviar' || t === 'Send') continue;
      if (visitados.has(t)) continue;
      visitados.add(t);

      let esVendedor = false;
      let el = span.parentElement;
      for (let depth = 0; depth < 10; depth++) {
        if (!el) break;
        const style = window.getComputedStyle(el);
        const jc = style.justifyContent;
        const fd = style.flexDirection;
        if (
          jc === 'flex-end' || jc === 'end' ||
          style.alignSelf === 'flex-end' ||
          fd === 'row-reverse' ||
          style.float === 'right'
        ) {
          esVendedor = true;
          break;
        }
        el = el.parentElement;
      }

      // Fallback textual: si el span comienza con "Tú:" o "You:", es del vendedor
      if (!esVendedor && /^(Tú|You):/.test(t)) {
        esVendedor = true;
      }

      mensajes.push(`${esVendedor ? 'Vendedor' : 'Comprador'}: ${t}`);
    }

    return mensajes.slice(-15);
  }, SISTEMA_AVISOS).catch(e => {
    console.warn(`⚠ Error scrapeando mensajes: ${e.message}`);
    return [];
  });
}

/**
 * Scrapea la tarjetita de la publicación de Marketplace que aparece arriba
 * de la conversación (foto + título + precio).
 *
 * La estructura exacta cambia con cada actualización de Meta, por eso se
 * usan varias estrategias en cascada:
 * 1. Selectores candidatos (enlaces/anclas de publicación).
 * 2. Fallback heurístico: buscar un bloque con imagen + texto de precio.
 *
 * NUNCA inventa un precio: retorna null si no logra detectarlo.
 *
 * @returns {Promise<{titulo: string, precio: string}|null>} Datos detectados o null.
 */
async function scrapearPublicacion() {
  const { page } = state;
  if (!page || page.isClosed()) return null;

  try {
    return await page.evaluate(() => {
      const precioPatron = /\$\s?\d{1,3}([.,]\d{3})*([.,]\d{1,2})?/;
      const area = document.querySelector('[role="main"]') || document.body;

      const candidatos = [];
      const todos = area.querySelectorAll('a, [role="link"], div');
      for (const el of todos) {
        if (el.offsetParent === null) continue;
        const texto = (el.innerText || el.textContent || '').trim();
        if (!texto) continue;
        const precio = texto.match(precioPatron);
        const img = el.querySelector('img');
        if (!img || !precio) continue;
        if (texto.length > 400) continue;
        candidatos.push({ el, texto, precio: precio[0] });
      }

      if (candidatos.length === 0) return null;

      // Elegir el candidato más corto (tarjeta compacta, no la página entera)
      candidatos.sort((a, b) => a.texto.length - b.texto.length);
      const mejor = candidatos[0];

      // El título es la primera línea antes del precio
      const lineas = mejor.texto.split('\n').map(l => l.trim()).filter(Boolean);
      const titulo = lineas.find(l => l !== mejor.precio && !l.includes(mejor.precio)) || '';

      return { titulo, precio: mejor.precio };
    }).catch(e => {
      console.warn(`⚠ Error scrapeando publicación: ${e.message}`);
      return null;
    });
  } catch (e) {
    console.warn(`⚠ No se pudo scrapear la publicación: ${e.message}`);
    return null;
  }
}

/**
 * Busca el cuadro de texto de Mensaje en el DOM usando múltiples selectores.
 * Primero intenta por selector CSS, luego por evaluate como fallback.
 *
 * @returns {Promise<import('puppeteer').ElementHandle|null>} Elemento encontrado o null.
 */
async function encontrarInput() {
  const { page } = state;

  await page.evaluate(() => {
    const pin = document.getElementById('mw-numeric-code-input-prevent-composer-focus-steal');
    if (pin) {
      pin.blur();
      pin.closest('[role="dialog"]')?.remove();
      pin.closest('[role="presentation"]')?.remove();
    }
  }).catch(e => {
    console.warn(`⚠ Error removiendo PIN overlay: ${e.message}`);
  });

  for (const sel of SEL.INPUT) {
    const el = await page.$(sel);
    if (el) return el;
  }

  return await page.evaluate(() => {
    const all = document.querySelectorAll('[contenteditable="true"]');
    for (const el of all) {
      if (el.offsetParent !== null) return el;
    }
    const allDivs = document.querySelectorAll('div[role="textbox"]');
    for (const el of allDivs) {
      if (el.offsetParent !== null) return el;
    }
    return null;
  }).then(el => el || null).catch(e => {
    console.warn(`⚠ Error en fallback encontrarInput: ${e.message}`);
    return null;
  });
}

/**
 * Envía un mensaje de texto en la conversación actual y verifica que
 * realmente apareció en el chat antes de retornar true.
 * Usa 3 estrategias en cascada:
 * 1. Click en botón "Enviar" por selector CSS
 * 2. Click por aria-label en evaluate
 * 3. Presionar Enter
 *
 * @param {string} texto - Mensaje a enviar.
 * @returns {Promise<boolean>} true si se confirmó que el mensaje se envió.
 */
async function enviarMensaje(texto) {
  const { page } = state;
  const input = await encontrarInput();
  if (!input) {
    console.error('❌ No se encontró el cuadro de texto');
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'debug.png'), fullPage: false });
    } catch (e) {
      console.warn(`⚠ No se pudo tomar screenshot de debug: ${e.message}`);
    }
    return false;
  }

  await input.focus();
  await sleep(300);
  await input.type(texto, { delay: rnd(30, 70) });
  await sleep(500 + rnd(0, 300));

  // Estrategia 1: esperar botón "Enviar" con waitForSelector
  try {
    const sendBtn = await page.waitForSelector(SEL.SEND_BUTTON, { timeout: 5000 });
    if (sendBtn) {
      const box = await sendBtn.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        console.log('📤 Click en botón Enviar');
        await sleep(1500);
        if (await mensajeAparecio(texto)) return true;
      }
    }
  } catch (e) {
    console.warn(`⚠ Estrategia 1 (send button) falló: ${e.message}`);
  }

  // Estrategia 2: buscar por aria-label en evaluate
  const clicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('div[role="button"]');
    for (const btn of btns) {
      const aria = btn.getAttribute('aria-label') || '';
      const text = (btn.innerText || '').trim();
      if ((aria === 'Enviar' || aria === 'Send' || text === 'Enviar' || text === 'Send') && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    return false;
  }).catch(e => {
    console.warn(`⚠ Estrategia 2 (evaluate) falló: ${e.message}`);
    return false;
  });

  if (clicked) {
    console.log('📤 Click en botón Enviar (fallback evaluate)');
    await sleep(1500);
    if (await mensajeAparecio(texto)) return true;
  }

  // Estrategia 3: Enter key nativo (funciona en Messenger web)
  await page.keyboard.press('Enter');
  await sleep(1200);
  if (await mensajeAparecio(texto)) {
    console.log('📤 Enter presionado y verificado');
    return true;
  }

  // Último intento: segundo Enter solo si el primero no se confirmó
  await page.keyboard.press('Enter');
  await sleep(1200);
  if (await mensajeAparecio(texto)) {
    console.log('📤 Segundo Enter verificado');
    return true;
  }

  console.error('❌ No se pudo confirmar que el mensaje se envió');
  return false;
}

/**
 * Verifica si el texto enviado aparece como último mensaje del chat,
 * re-scrapeando los mensajes visibles.
 *
 * @param {string} texto - Texto que se intentó enviar.
 * @returns {Promise<boolean>} true si el texto aparece en el historial reciente.
 */
async function mensajeAparecio(texto) {
  const { page } = state;
  if (!page || page.isClosed()) return false;
  try {
    const mensajes = await scrapearMensajes();
    const normalizado = texto.trim();
    return mensajes.some(m => {
      const contenido = m.replace(/^(Vendedor|Comprador):\s*/, '').trim();
      return contenido.includes(normalizado) || normalizado.includes(contenido);
    });
  } catch (e) {
    console.warn(`⚠ No se pudo verificar el envío: ${e.message}`);
    return false;
  }
}

/**
 * Hace click en la pestaña de Marketplace dentro del sidebar de Messenger.
 */
async function clickMarketplaceTab() {
  const { page } = state;
  await page.evaluate(() => {
    const enlaces = document.querySelectorAll('a');
    for (const el of enlaces) {
      const href = el.getAttribute('href') || '';
      if (href.includes('/marketplace/') && href.includes('focus_target') && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }
    return false;
  }).catch(e => {
    console.warn(`⚠ Error clickeando tab Marketplace: ${e.message}`);
  });
  await sleep(2000);
}

module.exports = {
  obtenerConversaciones,
  scrapearMensajes,
  scrapearPublicacion,
  encontrarInput,
  enviarMensaje,
  clickMarketplaceTab,
  normalizarClave,
};
