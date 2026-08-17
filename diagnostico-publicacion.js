'use strict';

/**
 * Diagnóstico de la tarjetita de Marketplace en Messenger.
 *
 * Abre el browser con las cookies, entra a la PRIMERA conversación de
 * Marketplace y dumpea el HTML de los candidatos a tarjeta (imagen + precio)
 * a diagnostico_publicacion.json. NO envía ningún mensaje.
 *
 * Uso: node diagnostico-publicacion.js
 */

const fs = require('fs');
const path = require('path');
const { iniciarBrowser, cerrarDialogos } = require('./src/browser');
const { obtenerConversaciones } = require('./src/messenger');
const { navegarAMarketplace } = require('./src/bot');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const SALIDA = path.join(__dirname, 'diagnostico_publicacion.json');

async function dumpTarjetas(page) {
  return await page.evaluate(() => {
    const precioPatron = /\$\s?\d{1,3}([.,]\d{3})*([.,]\d{1,2})?/;
    const area = document.querySelector('[role="main"]') || document.body;
    const resultado = [];
    const vistos = new Set();

    const todos = area.querySelectorAll('a, [role="link"], div, section');
    for (const el of todos) {
      if (el.offsetParent === null) continue;
      const texto = (el.innerText || el.textContent || '').trim();
      if (!texto || texto.length > 600) continue;
      const precio = texto.match(precioPatron);
      const img = el.querySelector('img');
      if (!img || !precio) continue;
      const clave = texto.slice(0, 60);
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      resultado.push({
        tag: el.tagName,
        className: (el.getAttribute('class') || '').slice(0, 120),
        precio: precio[0],
        texto: texto.slice(0, 300),
        imgSrc: (img.getAttribute('src') || '').slice(0, 200),
        outerHTML: el.outerHTML.slice(0, 800),
      });
    }

    return resultado.slice(0, 20);
  });
}

async function main() {
  console.log('🔍 Diagnóstico de tarjetita de publicación...');
  await iniciarBrowser();

  try {
    await navegarAMarketplace();
    const conversaciones = await obtenerConversaciones();
    console.log(`📋 ${conversaciones.length} conversaciones visibles`);

    if (conversaciones.length === 0) {
      console.log('⚠ No hay conversaciones de Marketplace para diagnosticar.');
      return;
    }

    const { page } = require('./src/state');
    const primera = conversaciones[0];
    const { indice } = primera;
    console.log(`🔍 Abriendo conversación: ${primera.nombre}`);

    const enlaces = await page.$$(require('./src/config').SEL.CONV_LINK);
    if (!enlaces[indice]) {
      console.log('⚠ No se encontró el enlace de la conversación.');
      return;
    }
    const href = await enlaces[indice].evaluate(el => el.getAttribute('href'));
    await page.goto(`https://www.messenger.com${href}`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await new Promise(r => setTimeout(r, 3000));
    await cerrarDialogos();

    const tarjetas = await dumpTarjetas(page);
    fs.writeFileSync(SALIDA, JSON.stringify({ conv: primera.nombre, tarjetas }, null, 2), 'utf8');

    console.log(`\n📄 ${tarjetas.length} candidato(s) a tarjeta guardados en ${SALIDA}`);
    if (tarjetas.length === 0) {
      console.log('   (Si el chat NO es de Marketplace o el chat no muestra tarjeta, es normal.)');
    } else {
      console.log('   Revisa el JSON para identificar la estructura real de la tarjeta.');
    }
  } finally {
    try {
      const { browser } = require('./src/state');
      if (browser) await browser.close();
    } catch (e) { /* ignora */ }
  }
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});