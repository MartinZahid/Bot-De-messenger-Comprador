'use strict';

const state = require('./state');
const {
  POLL_MS, IDLE_MS, GROQ_MODEL, BATCH_SIZE,
  SEL, sleep, rnd, hash,
} = require('./config');
const { iniciarBrowser, cerrarDialogos, reiniciarBrowser, detectarSesionExpirada, guardarCookies } = require('./browser');
const { obtenerConversaciones, scrapearMensajes, enviarMensaje, clickMarketplaceTab } = require('./messenger');
const { consultarGroq } = require('./groq');
const { sendTelegram, autoDetectarChatId, enviarAlerta } = require('./telegram');
const { iniciarServidor } = require('./server');
const { guardarEstado, cargarEstado } = require('./persistencia');

let idleTimeout = null;

/**
 * Ejecuta page.evaluate de forma segura, reintenta una vez si detecta
 * frame detachado (error común en Puppeteer con SPAs).
 *
 * @param {import('puppeteer').Page} page - Página de Puppeteer.
 * @param {Function} fn - Función a evaluar en el navegador.
 * @param {...any} args - Argumentos para la función.
 * @returns {Promise<any>} Resultado de page.evaluate.
 */
async function safeEvaluate(page, fn, ...args) {
  if (!page || page.isClosed()) throw new Error('Page is closed');
  try {
    return await page.evaluate(fn, ...args);
  } catch (err) {
    if (err.message.includes('detached from frame') || err.message.includes('Target closed')) {
      console.log('⚠ Detached frame detectado, reintentando una vez...');
      await sleep(1000);
      if (!page.isClosed()) {
        return await page.evaluate(fn, ...args);
      }
    }
    throw err;
  }
}

/**
 * Navega a la vista de Marketplace dentro de Messenger.
 * Cierra diálogos persistentes y verifica que los enlaces de conversación carguen.
 */
async function navegarAMarketplace() {
  const { page } = state;
  const url = page.url();
  if (url.includes('/t/') && !url.includes('/marketplace/')) {
    await page.goto('https://www.messenger.com/marketplace/', {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    await sleep(3000);
  }

  const currentUrl = await safeEvaluate(page, () => window.location.href);
  console.log(`📍 URL actual: ${currentUrl}`);

  for (let i = 0; i < 3; i++) {
    const hayDialog = await safeEvaluate(page, () => {
      const d = document.querySelector('[role="dialog"]');
      return d && d.offsetParent !== null;
    });
    if (!hayDialog) {
      if (i > 0) console.log('✅ Dialogos cerrados');
      break;
    }
    await cerrarDialogos();
    await sleep(2000);
  }

  await clickMarketplaceTab();

  const urlAfter = await safeEvaluate(page, () => window.location.href);
  if (urlAfter.includes('/t/') && !urlAfter.includes('/marketplace/')) {
    console.log('Navegando directamente a /marketplace/');
    await page.goto('https://www.messenger.com/marketplace/', {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await sleep(2000);
  }

  const totalEnlaces = await safeEvaluate(page, (sel) => document.querySelectorAll(sel).length, SEL?.CONV_LINK);
  console.log(`🔗 Enlaces de conversaciones encontrados: ${totalEnlaces}`);
}

/**
 * Procesa una única conversación: navega al chat, scrapea mensajes,
 * consulta a Groq y envía respuesta si corresponde.
 *
 * @param {{nombre: string, preview: string, indice: number}} conv - Conversación a procesar.
 * @returns {Promise<boolean>} true si se procesó un comprador real.
 */
async function procesarConversacion({ nombre, preview, indice }) {
  const { page } = state;
  console.log(`🔍 Procesando: ${nombre} — "${preview.slice(0, 80)}"`);

  const enlaces = await page.$$(SEL?.CONV_LINK);
  if (!enlaces[indice]) {
    console.error(`❌ No se encontró el enlace índice ${indice}`);
    return false;
  }
  const href = await enlaces[indice].evaluate(el => el.getAttribute('href'));
  await page.goto(`https://www.messenger.com${href}`, {
    waitUntil: 'networkidle2',
    timeout: 15000,
  });
  await sleep(2000 + rnd(0, 1000));

  await cerrarDialogos();

  let contexto = preview;
  try {
    const mensajesChat = await scrapearMensajes();
    if (mensajesChat.length > 0) {
      contexto = mensajesChat.join('\n');
      console.log(`📜 ${mensajesChat.length} mensajes scrapeados del chat`);
    }
  } catch (e) {
    console.log(`⚠ No se pudieron scrapear mensajes: ${e.message}`);
  }

  const decision = await consultarGroq(nombre, contexto);

  if (decision.action === 'reply' && decision.message) {
    console.log(`✅ Groq decide responder: "${decision.message.slice(0, 80)}..."`);
    const enviado = await enviarMensaje(decision.message);
    if (enviado) {
      console.log('📤 Respuesta enviada');
    }

    if (decision.isBuyer) {
      await sendTelegram(nombre, preview);
    }

    return decision.isBuyer;
  }

  if (decision.action === 'ignore') {
    console.log(`⏭ Groq decide ignorar (${decision.error ? 'error' : 'sin coincidencia'})`);
  }

  return false;
}

/**
 * Ciclo principal de polling. Obtiene conversaciones del sidebar,
 * filtra las que ya fueron procesadas y procesa hasta BATCH_SIZE
 * conversaciones nuevas por ciclo.
 */
async function cicloPrincipal() {
  if (state.busy || !state.ready) return;
  state.busy = true;

  try {
    if (await detectarSesionExpirada()) {
      console.log('🔄 Sesión expirada, reiniciando navegador...');
      await enviarAlerta('Sesión expirada', 'El bot se reinició automáticamente pero necesita cookies nuevas.');
      await reiniciarBrowser();
      return;
    }

    await navegarAMarketplace();

    const conversaciones = await obtenerConversaciones();
    console.log(`📋 ${conversaciones.length} conversaciones visibles`);

    if (!state.bootstrapDone) {
      for (const c of conversaciones) {
        if (c.esPropio) {
          state.processed.set(c.nombre, hash(`${c.nombre}|${c.ultimo}`));
        }
        if (c.esHumano) {
          state.humanHandled.add(c.nombre);
        }
      }
      state.bootstrapDone = true;
      console.log(`✅ Bootstrap: ${state.processed.size} propias, ${state.humanHandled.size} con respuesta humana`);
      return;
    }

    const pendientes = [];
    for (const conv of conversaciones) {
      if (conv.esPropio || conv.esSistema || conv.esSticker) continue;
      if (state.humanHandled.has(conv.nombre)) continue;
      if (conv.esHumano) { state.humanHandled.add(conv.nombre); continue; }
      const clave = hash(`${conv.nombre}|${conv.ultimo}`);
      if (state.processed.get(conv.nombre) === clave) continue;
      state.processed.set(conv.nombre, clave);
      pendientes.push(conv);
      if (pendientes.length >= BATCH_SIZE) break;
    }

    let algunCompradorDetectado = false;
    for (const conv of pendientes) {
      const esComprador = await procesarConversacion(conv);
      if (esComprador) algunCompradorDetectado = true;
    }

    if (pendientes.length > 0) {
      console.log(`📊 Procesadas ${pendientes.length} conversación(es) de ${conversaciones.length} totales`);
    }

    if (!algunCompradorDetectado && pendientes.length === 0) {
      if (!state.idle) {
        state.idle = true;
        console.log('💤 Sin mensajes nuevos. Modo reposo');
      }
    } else {
      state.idle = false;
    }

    guardarEstado();
    guardarCookies();
  } catch (err) {
    console.error('❌ Error en ciclo principal:', err.message);
    if (
      err.message.includes('detached from frame') ||
      err.message.includes('Target closed') ||
      err.message.includes('Protocol error')
    ) {
      reiniciarBrowser();
    }
  } finally {
    state.busy = false;
  }
}

/**
 * Programa el siguiente ciclo con delay adaptivo:
 * POLL_MS cuando hay actividad, IDLE_MS cuando está en reposo.
 */
function programarSiguiente() {
  const delay = state.idle ? IDLE_MS : POLL_MS;
  idleTimeout = setTimeout(async () => {
    try {
      await cicloPrincipal();
    } catch (e) {
      console.error('Error en ciclo:', e.message);
    }
    programarSiguiente();
  }, delay);
}

/**
 * Punto de entrada del bot. Carga estado persistido, detecta chat de Telegram,
 * inicia Chromium, lanza servidor Express y arranca el loop de polling.
 */
async function start() {
  process.on('unhandledRejection', err => {
    console.error('⚠ Unhandled Rejection:', err.message);
  });
  process.on('uncaughtException', err => {
    console.error('💥 Uncaught Exception:', err.message);
  });

  try {
    await cargarEstado();
    await autoDetectarChatId();
    await iniciarBrowser();
    iniciarServidor();
    setTimeout(async () => {
      await cicloPrincipal();
      programarSiguiente();
      const modo = state.idle ? `${IDLE_MS / 1000}s (reposo)` : `${POLL_MS / 1000}s (activo)`;
      console.log(`⏱ Monitor iniciado (modo: ${modo}) usando ${GROQ_MODEL || 'default'} | batch: ${BATCH_SIZE}`);
    }, 3000);
  } catch (err) {
    console.error('💥 Error fatal al iniciar:', err);
    process.exit(1);
  }
}

module.exports = { start };
