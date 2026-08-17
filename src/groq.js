'use strict';

const Groq = require('groq-sdk');
const state = require('./state');
const {
  GROQ_KEY, GROQ_MODEL, MAX_HISTORIAL, SYSTEM_PROMPT,
  GROQ_BACKOFF_BASE_MS, GROQ_BACKOFF_MAX_MS, GROQ_MAX_RETRIES,
  CONTACTO_NUMERO, sleep,
} = require('./config');

if (!GROQ_KEY) {
  console.error('❌ GROQ_API_KEY no está configurada.');
  console.error('   Obtén tu API Key gratis en https://console.groq.com');
  process.exit(1);
}

if (GROQ_KEY.includes('gsk_') && GROQ_KEY.length > 20) {
  const enmascarada = GROQ_KEY.slice(0, 6) + '****' + GROQ_KEY.slice(-4);
  console.warn(`⚠ GROQ_API_KEY configurada (${enmascarada}). Asegúrate de no exponerla en el repositorio.`);
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
    esPrecio: true,
  },
  {
    test: /\b(disponible|tienes|vendes|publicad|anuncio|hay|todavía)\b/i,
    msg: 'Sí, aún está disponible. ¿Te interesa?',
  },
  {
    test: /\b(ubicación|dirección|donde|dónde|zona|colonia|estás)\b/i,
    msg: `Estoy al sur de la ciudad, pero hago envíos dependiendo de la zona. Mi número es ${CONTACTO_NUMERO} para coordinar. ¿De dónde eres?`,
    requiresContext: true,
    zonaContext: true,
  },
  {
    test: /\b(numero|número|telefono|teléfono|whatsapp|wsp|contacto|cel|celular)\b/i,
    msg: `Claro, mi número es ${CONTACTO_NUMERO}. Escríbeme por ahí también. ¿De dónde eres?`,
    requiresContext: true,
    isBuyer: true,
  },
  {
    test: /\b(foto|fotos|imagen|imágenes|ver|muestra|enseña|mostrar)\b/i,
    msg: 'Las fotos están en la publicación. ¿Tienes alguna duda en específico?',
  },
  {
    test: /\b(envío|envias|domicilio|enviaste|mandas|mandar|envío|envías)\b/i,
    msg: 'Sí, hago envíos a domicilio, depende de tu ubicación. ¿De dónde eres?',
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
 * que ya se compartió ubicación/número o se cerró la conversación.
 * También detecta si el comprador ya envió su dirección o la venta
 * quedó concretada (en ese caso el bot no debe volver a responder).
 * @param {string} historialRaw - Texto completo del historial scrapeado.
 * @returns {boolean} true si ya no corresponde responder.
 */
function vendedorYaRespondio(historialRaw) {
  const lineas = historialRaw.split('\n');
  const ultimasLineas = lineas.slice(-8);
  const patronesCierre = [
    /gracias/i, /perfecto/i, /sale/i, /va\b/i, /ok\b/i,
    /nos vemos/i, /hasta luego/i, /bye/i,
  ];
  const patronYaCompartido = /sur de la ciudad|dirección|ubicación|te paso|envíos|mi número es/i;
  const patronVentaConcretada = /lo quiero|lo compro|ya lo compré|pasame|pásame|te mando mi dirección|mi dirección es|mi ubicación es|te comparto mi ubicación|aquí está mi dirección|ya quedó|trato hecho|te espero|paso mañana|ahí voy|ya voy|en camino/i;
  const patronDireccionEnviada = /\b(calle|avenida|av\.|col\.|colonia|número \d+|no\.\s*\d+)\b.*\b\d{2,}/i;

  for (const linea of ultimasLineas) {
    const contenido = linea.replace(/^(Vendedor|Comprador):\s*/, '');
    if (linea.startsWith('Vendedor:')) {
      if (patronYaCompartido.test(contenido)) return true;
      if (patronesCierre.some(p => p.test(contenido))) return true;
    }
    if (linea.startsWith('Comprador:')) {
      if (patronVentaConcretada.test(contenido)) return true;
      if (patronDireccionEnviada.test(contenido)) return true;
    }
  }
  return false;
}

/**
 * Detecta preguntas directas del comprador y genera una respuesta
 * predefinida. Incluye validación de contexto para evitar falsos positivos:
 * - No responde si el vendedor ya compartió ubicación/número.
 * - No responde si la conversación parece cerrada.
 * - Para la regla de "ubicación", verifica que sea una pregunta real
 *   (no solo mención casual de zonas).
 * - La regla de "precio" usa el precio detectado de la publicación si existe.
 *
 * @param {string} texto - Último mensaje del comprador.
 * @param {string} historialRaw - Historial completo de la conversación.
 * @param {string} [precioDetectado] - Precio detectado de la publicación (ej. "$450,000") o vacío.
 * @returns {{msg: string, isBuyer: boolean}|null} Respuesta predefinida o null si no aplica override.
 */
function detectarPreguntaDirecta(texto, historialRaw, precioDetectado) {
  if (vendedorYaRespondio(historialRaw)) {
    return null;
  }

  const esPregunta = /\?|¿/.test(texto);

  for (const r of REGLAS_PREGUNTAS) {
    if (!r.test.test(texto)) continue;

    if (r.requiresContext && !esPregunta) {
      continue;
    }

    if (r.zonaContext) {
      const mencionaZona = /\b(sur|norte|centro|este|oeste|zona|colonia)\b/i.test(texto);
      const esPreguntaReal = /\b(donde|dónde|qué zona|en que zona|de dónde|cómo llego|queda cerca)\b/i.test(texto);
      if (mencionaZona && !esPreguntaReal) continue;
    }

    if (r.esPrecio && precioDetectado) {
      return { msg: `Está en ${precioDetectado}. ¿Te interesa?`, isBuyer: r.isBuyer === true };
    }

    return { msg: r.msg, isBuyer: r.isBuyer === true };
  }

  if (esPregunta) {
    return { msg: '¡Claro! ¿Qué necesitas saber?', isBuyer: false };
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
  const publicacion = state.publicaciones.get(nombre) || null;
  const precioDetectado = publicacion && publicacion.precio ? publicacion.precio : '';

  const contextoPublicacion = publicacion && publicacion.titulo
    ? `Publicación: ${publicacion.titulo}\nPrecio: ${publicacion.precio || 'no detectado'}`
    : null;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historialConv.slice(-MAX_HISTORIAL),
    ...(contextoPublicacion ? [{ role: 'system', content: contextoPublicacion }] : []),
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
        const respuestaForzada = detectarPreguntaDirecta(ultimaLineaComprador, nuevoMensaje, precioDetectado);
        if (respuestaForzada) {
          console.log(`⚠ Groq ignoró, pero se detectó pregunta directa. Forzando reply.`);
          parsed.action = 'reply';
          parsed.message = respuestaForzada.msg;
          if (respuestaForzada.isBuyer) {
            parsed.is_buyer = true;
          }
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
