'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fssync = require('fs');
const state = require('./state');
const { COOKIES_PATH, SEL, sleep } = require('./config');

const COOKIES_SAVE_INTERVAL_MS = 5 * 60 * 1000;
let ultimaGrabacionCookies = 0;

/**
 * Lanza Chromium headless, carga cookies de messenger.com y navega
 * a la bandeja de entrada. Marca state.ready = true al completar.
 *
 * @throws {Error} Si no hay Chromium disponible.
 */
async function iniciarBrowser() {
  if (state.browser) {
    try { await state.browser.close(); } catch (e) {
      console.warn(`⚠ Error cerrando browser anterior: ${e.message}`);
    }
  }

  console.log('🚀 Iniciando Chromium...');

  let executablePath;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else if (fssync.existsSync('/usr/bin/chromium-browser')) {
    executablePath = '/usr/bin/chromium-browser';
  } else {
    try {
      executablePath = await puppeteer.executablePath();
    } catch (e) {
      console.warn(`⚠ No se encontró Chromium: ${e.message}`);
      throw new Error('Chromium no disponible. Descárgalo con: npx puppeteer browsers install chrome');
    }
  }

  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1280,800',
  ];
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--no-zygote', '--single-process');
  }

  state.browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args,
  });

  state.page = await state.browser.newPage();
  await state.page.setViewport({ width: 1280, height: 800 });
  await state.page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const { cookies, faltan } = await cargarCookies();
  await state.page.setCookie(...cookies);
  console.log(`🍪 ${cookies.length} cookies cargadas correctamente`);
  if (faltan) {
    console.warn('⚠ cookies.json está vacío o incompleto. La sesión requerirá inicio de sesión manual.');
  }

  await state.page.goto('https://www.messenger.com', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  console.log(`🌐 Página cargada: ${state.page.url()}`);

  if (await detectarSesionExpirada()) {
    throw new Error('Sesión de Messenger expirada');
  }

  const linkCargados = await esperarConversaciones();
  if (!linkCargados) {
    throw new Error('Timeout esperando conversaciones de Messenger');
  }

  await cerrarDialogos();
  await configurarMutationObserver();

  console.log('📬 Bandeja de entrada lista');
  state.ready = true;
}

/**
 * Lee y normaliza cookies.json. Si el archivo no existe o está vacío,
 * retorna cookies [] sin lanzar error (el bot reintentará en el ciclo).
 *
 * @returns {Promise<{cookies: Array, faltan: boolean}>}
 */
async function cargarCookies() {
  try {
    const raw = await fs.readFile(COOKIES_PATH, 'utf8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { cookies: [], faltan: true };
    }
    const normalizadas = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.messenger.com',
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure !== false,
      sameSite: c.sameSite || 'Lax',
      expires: c.expirationDate || c.expires || undefined,
    }));
    return { cookies: normalizadas, faltan: false };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('⚠ No existe cookies.json. Exporta las cookies de messenger.com a la raíz del proyecto.');
      return { cookies: [], faltan: true };
    }
    console.warn(`⚠ No se pudo cargar cookies.json: ${err.message}`);
    return { cookies: [], faltan: true };
  }
}

/**
 * Espera a que aparezcan enlaces de conversación, reintentando la
 * navegación hasta 3 veces antes de fallar.
 *
 * @returns {Promise<boolean>} true si los enlaces cargaron.
 */
async function esperarConversaciones() {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      await state.page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length > 0,
        { timeout: 30000 },
        SEL.CONV_LINK
      );
      return true;
    } catch (e) {
      console.warn(`⚠ Timeout esperando conversaciones (intento ${intento}/3): ${e.message}`);
      if (intento < 3) {
        await state.page.goto('https://www.messenger.com/marketplace/', {
          waitUntil: 'networkidle2',
          timeout: 20000,
        }).catch(() => {});
        await sleep(3000);
      }
    }
  }
  return false;
}

/**
 * Cierra diálogos modales de Messenger (popups de bienvenida, restaurar mensajes, etc.)
 * Usa 3 estrategias: click en botón Cerrar, click en "No restaurar", y eliminación forzada del DOM.
 */
async function cerrarDialogos() {
  const { page } = state;
  if (!page) return;
  await sleep(1500);

  const cerrar = await page.$('div[aria-label="Cerrar"][role="button"]');
  if (cerrar) {
    const box = await cerrar.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(2000);
    }
  }

  const noRestaurar = await page.$('div[aria-label="No restaurar los mensajes"][role="button"]');
  if (noRestaurar) {
    const box = await noRestaurar.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(2000);
    }
  }

  const removidos = await page.evaluate(() => {
    const dialogos = document.querySelectorAll('[role="dialog"]');
    let count = 0;
    for (const d of dialogos) {
      if (d.offsetParent !== null) {
        d.remove();
        count++;
      }
    }
    return count;
  });
  if (removidos > 0) console.log(`🧹 ${removidos} dialog(s) removido(s)`);
  await sleep(500);
}

/**
 * Reinicia el navegador cerrando el actual y relanzando.
 * Marca state.ready = false durante la transición.
 */
async function reiniciarBrowser() {
  console.log('🔄 Reiniciando navegador...');
  state.ready = false;
  try {
    await iniciarBrowser();
  } catch (e) {
    console.error('❌ Reintento de browser falló:', e.message);
  }
}

/**
 * Guarda las cookies actuales de la sesión a cookies.json.
 * Limita la escritura a 1 vez cada COOKIES_SAVE_INTERVAL_MS para
 * no escribir el disco en cada ciclo de polling.
 */
async function guardarCookies() {
  const { page } = state;
  if (!page || page.isClosed()) return;

  const ahora = Date.now();
  if (ahora - ultimaGrabacionCookies < COOKIES_SAVE_INTERVAL_MS) return;
  ultimaGrabacionCookies = ahora;

  try {
    const cookies = await page.cookies();
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    const raw = JSON.stringify(cookies, null, 2);
    await fs.writeFile(COOKIES_PATH, raw, 'utf8');
  } catch (err) {
    console.warn(`⚠ Error guardando cookies: ${err.message}`);
  }
}

/**
 * Detecta si la sesión de Facebook/Messenger ha expirado o ha sido bloqueada
 * verificando la URL contra patrones de login, checkpoint o bloqueo.
 *
 * @returns {Promise<boolean>} true si la sesión expiró.
 */
async function detectarSesionExpirada() {
  const { page } = state;
  if (!page || page.isClosed()) return false;
  try {
    const url = await page.evaluate(() => window.location.href);
    if (/login|checkpoint|two_step|recover|blocked|suspended|security/i.test(url)) {
      console.error('❌ Sesión expirada o bloqueada detectada en URL:', url);
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`⚠ No se pudo verificar sesión: ${e.message}`);
    return false;
  }
}

/**
 * Configura un MutationObserver en el DOM que elimina automáticamente
 * los diálogos modales cuando aparecen (popups persistentes de Messenger).
 */
async function configurarMutationObserver() {
  const { page } = state;
  if (!page) return;
  try {
    await page.evaluate(() => {
      if (window.__dialogObserver) return;
      window.__dialogObserver = new MutationObserver(() => {
        const dialogos = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogos) {
          if (d.offsetParent !== null) {
            d.remove();
          }
        }
      });
      window.__dialogObserver.observe(document.body, { childList: true, subtree: true });
    });
    console.log('🔍 MutationObserver para diálogos activo');
  } catch (err) {
    console.warn(`⚠ No se pudo configurar MutationObserver: ${err.message}`);
  }
}

module.exports = { iniciarBrowser, cerrarDialogos, reiniciarBrowser, detectarSesionExpirada, configurarMutationObserver, guardarCookies };
