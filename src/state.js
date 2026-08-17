'use strict';

/**
 * Estado compartido en memoria del bot.
 * Singleton exportado como objeto literal — todos los módulos importan la misma referencia.
 *
 * @type {{
 *   browser: import('puppeteer').Browser|null,
 *   page: import('puppeteer').Page|null,
 *   ready: boolean,
 *   busy: boolean,
 *   idle: boolean,
 *   bootstrapDone: boolean,
 *   processed: Map<string, {hash: string, ts: number}>,
 *   historial: Map<string, Array<{role: string, content: string}>>,
 *   humanHandled: Map<string, number>,
 * }}
 */
module.exports = {
  browser: null,
  page: null,
  ready: false,
  busy: false,
  idle: false,
  bootstrapDone: false,
  /** @type {Map<string, {hash: string, ts: number}>} nombre → hash del último mensaje + timestamp */
  processed: new Map(),
  /** @type {Map<string, Array<{role: string, content: string}>>} nombre → historial de chat con Groq */
  historial: new Map(),
  /** @type {Map<string, number>} nombres de conversaciones donde un humano ya respondió → timestamp */
  humanHandled: new Map(),
};
