'use strict';

const fs = require('fs').promises;
const path = require('path');
const state = require('./state');

const ESTADO_PATH = path.join(__dirname, '..', 'estado.json');

/**
 * Guarda el estado actual del bot (processed, historial, humanHandled, bootstrapDone)
 * a estado.json para sobrevivir reinicios.
 */
async function guardarEstado() {
  try {
    const data = {
      processed: Array.from(state.processed.entries()),
      historial: Array.from(state.historial.entries()),
      humanHandled: Array.from(state.humanHandled),
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
 *
 * @returns {Promise<boolean>} true si se cargó exitosamente.
 */
async function cargarEstado() {
  try {
    const raw = await fs.readFile(ESTADO_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data.processed) {
      state.processed = new Map(data.processed);
    }
    if (data.historial) {
      state.historial = new Map(data.historial);
    }
    if (data.bootstrapDone !== undefined) {
      state.bootstrapDone = data.bootstrapDone;
    }
    if (data.humanHandled) {
      state.humanHandled = new Set(data.humanHandled);
    }
    console.log(`📦 Estado cargado: ${state.processed.size} procesados, ${state.historial.size} historiales, ${state.humanHandled.size} con respuesta humana`);
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
