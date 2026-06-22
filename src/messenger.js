'use strict';

const path = require('path');
const state = require('./state');
const { SEL, SISTEMA, sleep, rnd } = require('./config');

async function obtenerConversaciones() {
  const { page } = state;
  return await page.evaluate((linkSelector, spanSelector, palabrasSistema) => {
    const enlaces = document.querySelectorAll(linkSelector);
    return Array.from(enlaces).map((el, idx) => {
      const spans = el.querySelectorAll(spanSelector);
      const textos = Array.from(spans)
        .map(s => s.textContent.trim())
        .filter(Boolean);
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
        return true;
      });
      const esHumano = textos.some(t => t.startsWith('Tú:') || t.startsWith('You:'));
      const esPropio = ultimo
        ? ultimo.startsWith('Tú:') || ultimo.startsWith('You:')
        : false;
      const esSistema = ultimo
        ? ultimo.includes('consejos de seguridad') || ultimo.includes('reunir con alguien en persona')
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
      if (!c.nombre.includes(' \u00B7 ')) return false;
      return true;
    });
  }, SEL.CONV_LINK, SEL.SPANS, SISTEMA);
}

async function scrapearMensajes() {
  const { page } = state;
  await sleep(1000);
  try {
    await page.waitForFunction(() => {
      const m = document.querySelector('[role="main"], [role="region"], [role="grid"]');
      return m && m.offsetParent !== null;
    }, { timeout: 8000 }).catch(() => {});
  } catch {}

  if (page.isClosed()) return [];

  return await page.evaluate(() => {
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
        if (jc === 'flex-end' || jc === 'end' || style.alignSelf === 'flex-end') {
          esVendedor = true;
          break;
        }
        el = el.parentElement;
      }

      mensajes.push(`${esVendedor ? 'Vendedor' : 'Comprador'}: ${t}`);
    }

    return mensajes.slice(-15);
  }).catch(() => []);
}

async function encontrarInput() {
  const { page } = state;

  await page.evaluate(() => {
    const pin = document.getElementById('mw-numeric-code-input-prevent-composer-focus-steal');
    if (pin) {
      pin.blur();
      pin.closest('[role="dialog"]')?.remove();
      pin.closest('[role="presentation"]')?.remove();
    }
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
  }).then(el => el || null);
}

async function enviarMensaje(texto) {
  const { page } = state;
  const input = await encontrarInput();
  if (!input) {
    console.error('❌ No se encontró el cuadro de texto');
    await page.screenshot({ path: path.join(__dirname, '..', 'debug.png'), fullPage: false });
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
        await sleep(1000);
        return true;
      }
    }
  } catch {}

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
  });

  if (clicked) {
    console.log('📤 Click en botón Enviar (fallback evaluate)');
    await sleep(1000);
    return true;
  }

  // Estrategia 3: Enter key nativo (funciona en Messenger web)
  await page.keyboard.press('Enter');
  await sleep(500);
  await page.keyboard.press('Enter');
  console.log('📤 Enter presionado');
  await sleep(1000);
  return true;
}

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
  });
  await sleep(2000);
}

module.exports = {
  obtenerConversaciones,
  scrapearMensajes,
  encontrarInput,
  enviarMensaje,
  clickMarketplaceTab,
};
