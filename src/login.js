'use strict';

/**
 * Login remoto: permite iniciar sesión en Messenger desde el celular o la PC
 * viendo y controlando el navegador del servidor desde una página web.
 * Así no hace falta exportar ni subir cookies.json a mano.
 *
 * Protegido con HTTP Basic Auth usando LOGIN_PASSWORD (.env).
 * Si LOGIN_PASSWORD no está configurada, las rutas /login quedan desactivadas.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const express = require('express');
const state = require('./state');
const { COOKIES_PATH, sleep } = require('./config');
const { lanzarNavegador, reiniciarBrowser } = require('./browser');

const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';
const TECLAS_PERMITIDAS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown']);

function igualSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Middleware de autenticación Basic (usuario: cualquiera, contraseña: LOGIN_PASSWORD). */
function auth(req, res, next) {
  if (!LOGIN_PASSWORD) {
    return res.status(404).send('Ruta desactivada. Configura LOGIN_PASSWORD en .env');
  }
  const header = req.headers.authorization || '';
  const [tipo, valor] = header.split(' ');
  if (tipo === 'Basic' && valor) {
    const decod = Buffer.from(valor, 'base64').toString('utf8');
    const clave = decod.slice(decod.indexOf(':') + 1);
    if (igualSeguro(clave, LOGIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Bot Messenger"');
  return res.status(401).send('Contraseña requerida');
}

function pagina() {
  const { page } = state;
  if (!page || page.isClosed()) throw new Error('Navegador no disponible. Pulsa "Iniciar login".');
  return page;
}

const router = express.Router();
router.use(auth);
router.use(express.json());

router.get('/', (_req, res) => {
  res.type('html').send(HTML);
});

router.get('/estado', (_req, res) => {
  const page = state.page && !state.page.isClosed() ? state.page : null;
  res.json({ loginMode: state.loginMode, ready: state.ready, url: page ? page.url() : null });
});

router.get('/ss', async (_req, res) => {
  try {
    const img = await pagina().screenshot({ type: 'jpeg', quality: 60 });
    res.set('Cache-Control', 'no-store').type('jpeg').send(img);
  } catch (err) {
    res.status(503).send(err.message);
  }
});

/** Pausa el bot y abre la pantalla de login de Messenger en el navegador del servidor. */
router.post('/start', async (_req, res) => {
  try {
    state.loginMode = true;
    state.ready = false;
    // Espera a que termine un ciclo en curso para no pelear por la página.
    for (let i = 0; i < 60 && (state.busy || state.iniciando); i++) await sleep(1000);

    if (!state.browser || !state.browser.connected || !state.page || state.page.isClosed()) {
      await lanzarNavegador();
    }
    await state.page.goto('https://www.messenger.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    console.log('🔐 Login remoto iniciado');
    res.json({ ok: true, url: state.page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/click', async (req, res) => {
  try {
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x/y inválidos' });
    await pagina().mouse.click(x, y);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/type', async (req, res) => {
  try {
    const texto = String(req.body.texto || '').slice(0, 500);
    await pagina().keyboard.type(texto, { delay: 40 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/key', async (req, res) => {
  try {
    const tecla = String(req.body.tecla || '');
    if (!TECLAS_PERMITIDAS.has(tecla)) return res.status(400).json({ error: 'Tecla no permitida' });
    await pagina().keyboard.press(tecla);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Guarda la sesión (todas las cookies) en cookies.json y reanuda el bot. */
router.post('/done', async (_req, res) => {
  try {
    const page = pagina();
    const cdp = await page.createCDPSession();
    const { cookies } = await cdp.send('Network.getAllCookies');
    await cdp.detach().catch(() => {});

    if (!cookies.some(c => c.name === 'c_user')) {
      return res.status(400).json({ error: 'Todavía no hay sesión iniciada (falta la cookie c_user). Termina de iniciar sesión.' });
    }

    await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf8');
    console.log(`🍪 Login remoto: ${cookies.length} cookies guardadas en cookies.json`);

    state.loginMode = false;
    res.json({ ok: true, cookies: cookies.length });

    // Si el bot ya había arrancado, reinicia el navegador con la sesión nueva.
    // Si no, el bucle de arranque en bot.js lo hará solo.
    if (state.arrancado) await reiniciarBrowser();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancel', (_req, res) => {
  state.loginMode = false;
  res.json({ ok: true });
  if (state.arrancado) reiniciarBrowser();
});

const HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login del bot</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:12px;background:#f4f4f5;color:#111}
  h1{font-size:18px;margin:0 0 8px}
  .barra{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  button{padding:8px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:14px}
  button.gris{background:#52525b} button.verde{background:#16a34a}
  input{flex:1;min-width:160px;padding:8px;font-size:16px;border:1px solid #ccc;border-radius:6px}
  #ss{width:100%;max-width:1280px;border:1px solid #ccc;cursor:crosshair;display:block;background:#fff}
  #estado{font-size:13px;color:#555}
</style></head><body>
<h1>Iniciar sesión de Messenger en el servidor</h1>
<div id="estado">Cargando…</div>
<div class="barra">
  <button onclick="post('start')">1. Iniciar login</button>
  <button class="verde" onclick="terminar()">2. Ya inicié sesión: guardar</button>
  <button class="gris" onclick="post('cancel')">Cancelar</button>
</div>
<div class="barra">
  <input id="texto" placeholder="Escribe aquí y pulsa Enviar (toca antes el campo en la imagen)" autocomplete="off">
  <button onclick="escribir()">Enviar texto</button>
</div>
<div class="barra">
  <button class="gris" onclick="tecla('Enter')">Enter</button>
  <button class="gris" onclick="tecla('Tab')">Tab</button>
  <button class="gris" onclick="tecla('Backspace')">Borrar</button>
  <button class="gris" onclick="tecla('Escape')">Esc</button>
</div>
<img id="ss" alt="Pantalla del servidor (pulsa Iniciar login)">
<script>
const img = document.getElementById('ss');
async function post(ruta, cuerpo) {
  const r = await fetch('/login/' + ruta, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(cuerpo||{})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) alert(j.error || 'Error');
  return j;
}
async function terminar() {
  const j = await post('done');
  if (j.ok) alert('Sesión guardada (' + j.cookies + ' cookies). El bot se reinicia solo.');
}
function escribir() {
  const el = document.getElementById('texto');
  post('type', {texto: el.value}); el.value = '';
}
function tecla(t) { post('key', {tecla: t}); }
img.addEventListener('click', e => {
  const r = img.getBoundingClientRect();
  const x = (e.clientX - r.left) * img.naturalWidth / r.width;
  const y = (e.clientY - r.top) * img.naturalHeight / r.height;
  post('click', {x, y});
});
async function refrescar() {
  try {
    const e = await (await fetch('/login/estado')).json();
    document.getElementById('estado').textContent =
      (e.loginMode ? '🔐 Modo login activo' : (e.ready ? '✅ Bot funcionando' : '⏳ Bot sin sesión / arrancando')) +
      (e.url ? ' — ' + e.url : '');
    const nueva = new Image();
    nueva.onload = () => { img.src = nueva.src; };
    nueva.src = '/login/ss?t=' + Date.now();
  } catch {}
  setTimeout(refrescar, 1200);
}
refrescar();
</script>
</body></html>`;

module.exports = { router, auth };
