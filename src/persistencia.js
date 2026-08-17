'use strict';

const fs = require('fs').promises;
const path = require('path');
const state = require('./state');

const ESTADO_PATH = path.join(__dirname, '..', 'estado.json');
const TIEMPO_PODA_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROCESADOS = 2000;
const MAX_HUMAN_HANDLED = 1000;
const MAX_PUBLICACIONES = 500;

/**
 * Poda las estructuras de estado: elimina entradas más antiguas que
 * TIEMPO_PODA_MS y limita el tamaño total para que estado.json no crezca indefinidamente.
 */
function podarEstado() {
  const ahora = Date.now();

  for (const [nombre, valor] of state.processed) {
    const ts = typeof valor === 'object' && valor ? valor.ts : 0;
    if (ts && ahora - ts > TIEMPO_PODA_MS) {
      state.processed.delete(nombre);
    }
  }

  for (const [nombre, ts] of state.humanHandled) {
    if (ts && ahora - ts > TIEMPO_PODA_MS) {
      state.humanHandled.delete(nombre);
    }
  }

  for (const [nombre, valor] of state.publicaciones) {
    const ts = valor && valor.ts ? valor.ts : 0;
    if (ts && ahora - ts > TIEMPO_PODA_MS) {
      state.publicaciones.delete(nombre);
    }
  }

  if (state.publicaciones.size > MAX_PUBLICACIONES) {
    const ordenado = Array.from(state.publicaciones.entries())
      .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    state.publicaciones = new Map(ordenado.slice(0, MAX_PUBLICACIONES));
  }

  if (state.processed.size > MAX_PROCESADOS) {
    const ordenado = Array.from(state.processed.entries())
      .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    state.processed = new Map(ordenado.slice(0, MAX_PROCESADOS));
  }

  if (state.humanHandled.size > MAX_HUMAN_HANDLED) {
    const ordenado = Array.from(state.humanHandled.entries())
      .sort((a, b) => (b[1] || 0) - (a[1] || 0));
    state.humanHandled = new Map(ordenado.slice(0, MAX_HUMAN_HANDLED));
  }
}

/**
 * Guarda el estado actual del bot (processed, historial, humanHandled, bootstrapDone)
 * a estado.json para sobrevivir reinicios.
 */
async function guardarEstado() {
  try {
    podarEstado();
    const data = {
      processed: Array.from(state.processed.entries()),
      historial: Array.from(state.historial.entries()),
      humanHandled: Array.from(state.humanHandled.entries()),
      publicaciones: Array.from(state.publicaciones.entries()),
      bootstrapDone: state.bootstrapDone,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(ESTADO_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠ Error guardando estado: ${err.message}`);
  }
}

/**
 * Carga el estado previamente guardado desde estado.json.
 * Si el archivo no existe, retorna false sin error (primera ejecución).
 * Migra el formato viejo (processed como nombre→hash, humanHandled como array)
 * al formato con timestamps.
 *
 * @returns {Promise<boolean>} true si se cargó exitosamente.
 */
async function cargarEstado() {
  try {
    const raw = await fs.readFile(ESTADO_PATH, 'utf8');
    const data = JSON.parse(raw);

    if (data.processed) {
      state.processed = new Map(data.processed.map(([nombre, valor]) => {
        if (typeof valor === 'object' && valor !== null && valor.hash) {
          return [nombre, { hash: valor.hash, ts: valor.ts || Date.now() }];
        }
        // Formato viejo: nombre → hash (string)
        return [nombre, { hash: String(valor), ts: Date.now() }];
      }));
    }
    if (data.historial) {
      state.historial = new Map(data.historial);
    }
    if (data.bootstrapDone !== undefined) {
      state.bootstrapDone = data.bootstrapDone;
    }
    if (data.humanHandled) {
      state.humanHandled = new Map(data.humanHandled.map((item) => {
        if (Array.isArray(item)) {
          const [nombre, ts] = item;
          return [nombre, typeof ts === 'number' ? ts : Date.now()];
        }
        // Formato viejo: humanHandled como array de strings
        return [item, Date.now()];
      }));
    }
    if (data.publicaciones) {
      state.publicaciones = new Map(data.publicaciones.map(([nombre, valor]) => {
        if (valor && typeof valor === 'object') {
          return [nombre, {
            titulo: String(valor.titulo || ''),
            precio: String(valor.precio || ''),
            ts: valor.ts || Date.now(),
          }];
        }
        return [nombre, { titulo: '', precio: String(valor || ''), ts: Date.now() }];
      }));
    }

    podarEstado();
    console.log(`📦 Estado cargado: ${state.processed.size} procesados, ${state.historial.size} historiales, ${state.humanHandled.size} con respuesta humana, ${state.publicaciones.size} publicaciones`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('📦 Sin estado previo, comenzando desde cero');
    } else {
      console.warn(`⚠ Error cargando estado: ${err.message}`);
    }
    return false;
  }
}

module.exports = { guardarEstado, cargarEstado };
