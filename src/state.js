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
 *   processed: Map<string, string>,
 *   historial: Map<string, Array<{role: string, content: string}>>,
 *   humanHandled: Set<string>,
 * }}
 */
module.exports = {
  browser: null,
  page: null,
  ready: false,
  busy: false,
  idle: false,
  bootstrapDone: false,
  /** @type {Map<string, string>} nombre → hash del último mensaje */
  processed: new Map(),
  /** @type {Map<string, Array<{role: string, content: string}>>} nombre → historial de chat con Groq */
  historial: new Map(),
  /** @type {Set<string>} nombres de conversaciones donde un humano ya respondió */
  humanHandled: new Set(),
};
