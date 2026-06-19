'use strict';

const express = require('express');
const path = require('path');
const state = require('./state');
const { PORT, GROQ_MODEL, hash } = require('./config');
const { obtenerConversaciones } = require('./messenger');

const app = express();

app.get('/', (_req, res) => {
  res.json({
    estado: state.ready ? 'online' : 'starting',
    modelo_groq: GROQ_MODEL,
    conversaciones_rastreadas: state.processed.size,
    historiales_activos: state.historial.size,
    ultimo_ciclo: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.status(state.ready ? 200 : 503).send(state.ready ? 'OK' : 'NOT_READY');
});

app.get('/chats', async (_req, res) => {
  if (!state.ready) return res.status(503).json({ error: 'Bot no listo' });
  try {
    const chats = await obtenerConversaciones();
    res.json({
      total: chats.length,
      chats: chats.map(c => ({
        nombre: c.nombre,
        preview: c.preview.slice(0, 100),
        procesado: state.processed.get(c.nombre) === hash(`${c.nombre}|${c.ultimo}`),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ss', async (_req, res) => {
  if (!state.ready || !state.page) return res.status(503).json({ error: 'Bot no listo' });
  try {
    const img = await state.page.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ url: state.page.url(), screenshot: `data:image/png;base64,${img}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug-input', async (_req, res) => {
  if (!state.ready || !state.page) return res.status(503).json({ error: 'Bot no listo' });
  try {
    const url = state.page.url();
    const dump = await state.page.evaluate(() => {
      const els = document.querySelectorAll(
        '[contenteditable], [role="textbox"], textarea, input:not([type="hidden"]), div[contenteditable]'
      );
      return Array.from(els).map(el => ({
        tag: el.tagName,
        id: el.id,
        clase: el.className.slice(0, 100),
        tipo: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        editable: el.getAttribute('contenteditable') || '',
        visible: el.offsetParent !== null,
        texto: (el.textContent || '').trim().slice(0, 60) || '(vacio)',
        placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
      }));
    });

    let ss = null;
    try {
      ss = await state.page.screenshot({ encoding: 'base64' });
    } catch {}

    res.json({
      url,
      total: dump.length,
      elementos: dump,
      screenshot: ss ? ss.slice(0, 500) + '...' : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function iniciarServidor() {
  app.listen(PORT, () => {
    console.log(`🌐 Servidor Express en puerto ${PORT}`);
  });
}

module.exports = { app, iniciarServidor };
