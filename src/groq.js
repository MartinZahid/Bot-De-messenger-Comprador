'use strict';

const Groq = require('groq-sdk');
const state = require('./state');
const {
  GROQ_KEY, GROQ_MODEL, MAX_HISTORIAL, SYSTEM_PROMPT,
  GROQ_BACKOFF_BASE_MS, GROQ_BACKOFF_MAX_MS, GROQ_MAX_RETRIES,
  sleep,
} = require('./config');

if (!GROQ_KEY) {
  console.error('❌ GROQ_API_KEY no está configurada.');
  console.error('   Obtén tu API Key gratis en https://console.groq.com');
  process.exit(1);
}

if (GROQ_KEY.includes('gsk_') && GROQ_KEY.length > 20) {
  console.warn('⚠ GROQ_API_KEY configurada. Asegúrate de rotarla si está expuesta en el repositorio.');
}

const groq = new Groq({ apiKey: GROQ_KEY });

/**
 * Reglas de detección de preguntas directas del comprador.
 * Cada regla tiene un test regex, una respuesta predefinida,
 * y un flag `requiresContext` que indica si necesita contexto adicional
 * para evitar falsos positivos.
 * @type {Array<{test: RegExp, msg: string, requiresContext?: boolean}>}
 */
const REGLAS_PREGUNTAS = [
  {
    test: /\b(precio|cuanto|cuesta|cuánto|valor|costó|caro|barato|cuestan)\b/i,
    msg: 'El precio es el que está en la publicación. ¿Te interesa?',
  },
  {
    test: /\b(disponible|tienes|vendes|publicad|anuncio|hay|todavía)\b/i,
    msg: 'Sí, aún está disponible. ¿Te interesa?',
  },
  {
    test: /\b(ubicación|dirección|donde|dónde|zona|colonia|estás)\b/i,
    msg: 'Estoy al sur de la ciudad, pero hago envíos. ¿De dónde eres?',
    requiresContext: true,
  },
  {
    test: /\b(foto|fotos|imagen|imágenes|ver|muestra|enseña|mostrar)\b/i,
    msg: 'Las fotos están en la publicación. ¿Tienes alguna duda en específico?',
  },
  {
    test: /\b(envío|envias|domicilio|enviaste|mandas|mandar|envío|envías)\b/i,
    msg: 'Sí, hago envíos a domicilio según la zona. ¿De dónde eres?',
  },
  {
    test: /\b(funciona|sirve|como funciona|características|especificaciones|modelo|marca|estado|usado|nuevo)\b/i,
    msg: 'Funciona bien. Si tienes alguna duda específica, dime y te respondo.',
  },
  {
    test: /\b(medidas|tamaño|peso|dimensiones|grande|chico|color)\b/i,
    msg: 'Las especificaciones están en la publicación. ¿Alguna duda en particular?',
  },
];

/**
 * Detecta si el último mensaje del vendedor en el historial indica
 * que ya se compartió ubicación o se cerró la conversación.
 * @param {string} historialRaw - Texto completo del historial scrapeado.
 * @returns {boolean} true si el vendedor ya respondió con ubicación o despedida.
 */
function vendedorYaRespondio(historialRaw) {
  const lineas = historialRaw.split('\n');
  const ultimasLineas = lineas.slice(-6);
  const patronesCierre = [
    /gracias/i, /perfecto/i, /sale/i, /va\b/i, /ok\b/i,
    /nos vemos/i, /hasta luego/i, /bye/i,
  ];
  const patronUbicacion = /sur de la ciudad|dirección|ubicación|te paso|envíos/i;

  for (const linea of ultimasLineas) {
    if (!linea.startsWith('Vendedor:')) continue;
    const contenido = linea.replace(/^Vendedor:\s*/, '');
    if (patronUbicacion.test(contenido)) return true;
    if (patronesCierre.some(p => p.test(contenido))) return true;
  }
  return false;
}

/**
 * Detecta preguntas directas del comprador y genera una respuesta
 * predefinida. Incluye validación de contexto para evitar falsos positivos:
 * - No responde si el vendedor ya compartió ubicación.
 * - No responde si la conversación parece cerrada.
 * - Para la regla de "ubicación", verifica que sea una pregunta real
 *   (no solo mención casual de zonas).
 *
 * @param {string} texto - Último mensaje del comprador.
 * @param {string} historialRaw - Historial completo de la conversación.
 * @returns {string|null} Respuesta predefinida o null si no aplica override.
 */
function detectarPreguntaDirecta(texto, historialRaw) {
  if (vendedorYaRespondio(historialRaw)) {
    return null;
  }

  const esPregunta = /\?|¿/.test(texto);

  for (const r of REGLAS_PREGUNTAS) {
    if (!r.test.test(texto)) continue;

    if (r.requiresContext && !esPregunta) {
      continue;
    }

    if (r.requiresContext) {
      const mencionaZona = /\b(sur|norte|centro|este|oeste|zona|colonia)\b/i.test(texto);
      const esPreguntaReal = /\b(donde|dónde|qué zona|en que zona|de dónde|cómo llego|queda cerca)\b/i.test(texto);
      if (mencionaZona && !esPreguntaReal) continue;
    }

    return r.msg;
  }

  if (esPregunta) {
    return '¡Claro! ¿Qué necesitas saber?';
  }

  return null;
}

/**
 * Consulta a Groq con backoff exponencial en caso de error.
 *
 * @param {string} nombre - Nombre del comprador/conversación.
 * @param {string} nuevoMensaje - Texto scrapeado del chat (historial completo).
 * @returns {Promise<{action: string, message: string, isBuyer: boolean, error?: boolean}>}
 */
async function consultarGroq(nombre, nuevoMensaje) {
  const historialConv = state.historial.get(nombre) || [];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historialConv.slice(-MAX_HISTORIAL),
    { role: 'user', content: nuevoMensaje },
  ];

  console.log(`🤖 Consultando Groq (${GROQ_MODEL}) para ${nombre}...`);

  let lastError = null;

  for (let intento = 0; intento <= GROQ_MAX_RETRIES; intento++) {
    try {
      const completion = await groq.chat.completions.create({
        messages,
        model: GROQ_MODEL,
        temperature: 0.3,
        max_tokens: 350,
      });

      const raw = completion.choices[0]?.message?.content || '';
      console.log(`📩 Respuesta de Groq: ${raw.slice(0, 120)}...`);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw new Error('No se encontró JSON en la respuesta');
        }
      }

      if (!parsed.action || !['reply', 'ignore'].includes(parsed.action)) {
        throw new Error(`action inválido: ${parsed.action}`);
      }

      if (parsed.action === 'ignore') {
        const ultimaLineaComprador = nuevoMensaje.split('\n').reverse().find(l => l.startsWith('Comprador:')) || '';
        const respuestaForzada = detectarPreguntaDirecta(ultimaLineaComprador, nuevoMensaje);
        if (respuestaForzada) {
          console.log(`⚠ Groq ignoró, pero se detectó pregunta directa. Forzando reply.`);
          parsed.action = 'reply';
          parsed.message = respuestaForzada;
        }
      }

      historialConv.push({ role: 'user', content: nuevoMensaje });
      if (parsed.action === 'reply' && parsed.message) {
        historialConv.push({ role: 'assistant', content: parsed.message });
      }
      if (historialConv.length > MAX_HISTORIAL * 2) {
        state.historial.set(nombre, historialConv.slice(-MAX_HISTORIAL));
      } else {
        state.historial.set(nombre, historialConv);
      }

      return {
        action: parsed.action || 'ignore',
        message: parsed.message || '',
        isBuyer: parsed.is_buyer === true,
      };
    } catch (err) {
      lastError = err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
      const isServerError = err.message?.includes('500') || err.message?.includes('503');

      if (intento < GROQ_MAX_RETRIES && (isRateLimit || isServerError)) {
        const backoff = Math.min(
          GROQ_BACKOFF_BASE_MS * Math.pow(2, intento),
          GROQ_BACKOFF_MAX_MS,
        );
        console.warn(`⚠ Groq error (intento ${intento + 1}/${GROQ_MAX_RETRIES}): ${err.message}. Reintentando en ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      break;
    }
  }

  console.error(`❌ Error al consultar Groq tras ${GROQ_MAX_RETRIES} reintentos: ${lastError?.message}`);

  historialConv.push({ role: 'user', content: nuevoMensaje });
  state.historial.set(nombre, historialConv);

  return { action: 'ignore', message: '', isBuyer: false, error: true };
}

module.exports = { consultarGroq };
