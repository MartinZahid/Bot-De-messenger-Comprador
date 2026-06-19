'use strict';

const fs = require('fs').promises;
const path = require('path');
const state = require('./state');

const ESTADO_PATH = path.join(__dirname, '..', 'estado.json');

async function guardarEstado() {
  try {
    const data = {
      processed: Array.from(state.processed.entries()),
      historial: Array.from(state.historial.entries()),
      bootstrapDone: state.bootstrapDone,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(ESTADO_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('⚠ Error guardando estado:', err.message);
  }
}

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
    console.log(`📦 Estado cargado: ${state.processed.size} procesados, ${state.historial.size} historiales`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('⚠ Error cargando estado:', err.message);
    }
    return false;
  }
}

module.exports = { guardarEstado, cargarEstado };
