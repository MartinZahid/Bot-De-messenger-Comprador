'use strict';

const Groq = require('groq-sdk');
const state = require('./state');
const { GROQ_KEY, GROQ_MODEL, MAX_HISTORIAL, SYSTEM_PROMPT } = require('./config');

if (!GROQ_KEY) {
  console.error('❌ GROQ_API_KEY no está configurada.');
  console.error('   Obtén tu API Key gratis en https://console.groq.com');
  process.exit(1);
}

if (GROQ_KEY.includes('gsk_') && GROQ_KEY.length > 20) {
  console.warn('⚠ GROQ_API_KEY configurada. Asegúrate de rotarla si está expuesta en el repositorio.');
}

const groq = new Groq({ apiKey: GROQ_KEY });

function detectarPreguntaDirecta(texto) {
  const reglas = [
    { test: /\b(precio|cuanto|cuesta|cuánto|valor|costó|caro|barato|cuestan)\b/i, msg: 'El precio es el que está en la publicación. ¿Te interesa?' },
    { test: /\b(disponible|tienes|vendes|vendes|publicad|anuncio|hay|todavía)\b/i, msg: 'Sí, aún está disponible. ¿Te interesa?' },
    { test: /\b(ubicación|dirección|donde|dónde|zona|colonia|sur|norte|centro|estás)\b/i, msg: 'Estoy al sur de la ciudad, pero hago envíos. ¿De dónde eres?' },
    { test: /\b(foto|fotos|imagen|imágenes|ver|muestra|enseña|mostrar)\b/i, msg: 'Las fotos están en la publicación. ¿Tienes alguna duda en específico?' },
    { test: /\b(envío|envias|domicilio|enviaste|mandas|mandar|envío|envías)\b/i, msg: 'Sí, hago envíos a domicilio según la zona. ¿De dónde eres?' },
    { test: /\b(funciona|sirve|como funciona|características|especificaciones|modelo|marca|estado|usado|nuevo)\b/i, msg: 'Funciona bien. Si tienes alguna duda específica, dime y te respondo.' },
    { test: /\b(medidas|tamaño|peso|dimensiones|grande|chico|color)\b/i, msg: 'Las especificaciones están en la publicación. ¿Alguna duda en particular?' },
  ];

  for (const r of reglas) {
    if (r.test.test(texto)) return r.msg;
  }

  if (texto.includes('\u00BF') || texto.includes('?')) {
    return '\u00a1Claro! \u00bfQu\u00e9 necesitas saber?';
  }

  return null;
}

function obtenerPromptSegunEtapa(nombre) {
  const historialConv = state.historial.get(nombre) || [];
  if (historialConv.length === 0) {
    return SYSTEM_PROMPT;
  }
  return SYSTEM_PROMPT;
}

async function consultarGroq(nombre, nuevoMensaje) {
  const prompt = obtenerPromptSegunEtapa(nombre);
  const historialConv = state.historial.get(nombre) || [];

  const messages = [
    { role: 'system', content: prompt },
    ...historialConv.slice(-MAX_HISTORIAL),
    { role: 'user', content: nuevoMensaje },
  ];

  console.log(`🤖 Consultando Groq (${GROQ_MODEL}) para ${nombre}...`);

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

    // Override: si Groq ignora pero hay pregunta directa, forzar reply
    if (parsed.action === 'ignore') {
      const respuestaForzada = detectarPreguntaDirecta(nuevoMensaje);
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
    console.error('❌ Error al consultar Groq:', err.message);

    const h = state.historial.get(nombre) || [];
    h.push({ role: 'user', content: nuevoMensaje });
    state.historial.set(nombre, h);

    return { action: 'ignore', message: '', isBuyer: false, error: true };
  }
}

module.exports = { consultarGroq };
