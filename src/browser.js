'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const state = require('./state');
const { COOKIES_PATH, SEL, sleep } = require('./config');

async function iniciarBrowser() {
  if (state.browser) {
    try { await state.browser.close(); } catch { /* ok */ }
  }

  console.log('🚀 Iniciando Chromium...');
  state.browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-background-networking',
      '--disable-extensions',
      '--window-size=1280,800',
    ],
  });

  state.page = await state.browser.newPage();
  await state.page.setViewport({ width: 1280, height: 800 });
  await state.page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    const raw = await fs.readFile(COOKIES_PATH, 'utf8');
    const cookies = JSON.parse(raw);
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
    await state.page.setCookie(...normalizadas);
    console.log(`🍪 ${cookies.length} cookies cargadas correctamente`);
  } catch (err) {
    console.error('❌ No se pudo cargar cookies.json:', err.message);
    console.error('   Asegúrate de exportar las cookies de messenger.com');
    console.error('   y colocarlas en cookies.json en la raíz del proyecto.');
    process.exit(1);
  }

  await state.page.goto('https://www.messenger.com', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  console.log(`🌐 Página cargada: ${state.page.url()}`);

  if (state.page.url().includes('login')) {
    console.error('❌ Sesión expirada. Renueva cookies.json con cookies nuevas.');
    process.exit(1);
  }

  await state.page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    { timeout: 30000 },
    SEL.CONV_LINK
  );

  await cerrarDialogos();
  await configurarMutationObserver();

  console.log('📬 Bandeja de entrada lista');
  state.ready = true;
}

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

async function reiniciarBrowser() {
  console.log('🔄 Reiniciando navegador...');
  state.ready = false;
  try {
    await iniciarBrowser();
  } catch (e) {
    console.error('Reintento falló:', e.message);
  }
}

async function detectarSesionExpirada() {
  const { page } = state;
  if (!page || page.isClosed()) return false;
  try {
    const url = await page.evaluate(() => window.location.href);
    if (url.includes('login') || url.includes('checkpoint')) {
      console.error('❌ Sesión expirada detectada en URL:', url);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

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
    console.log('⚠ No se pudo configurar MutationObserver:', err.message);
  }
}

module.exports = { iniciarBrowser, cerrarDialogos, reiniciarBrowser, detectarSesionExpirada, configurarMutationObserver };
