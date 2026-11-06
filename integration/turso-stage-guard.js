"use strict";

// Preflight de Turso V3, sin conexiones de red al validar argumentos.
// Nunca registrar URL, tokens ni contenido de respuestas de la base.
// NO es una garantía de identidad absoluta: el propietario debe confirmar
// que el hostname de ensayo corresponde a una base SEPARADA de producción.

function hostDeUrl(url) {
  if (typeof url !== "string" || url.length > 512) {
    throw new Error("STAGING_URL_INVALIDA");
  }
  let u;
  try { u = new URL(url); } catch (_) { throw new Error("STAGING_URL_INVALIDA"); }
  if (!["libsql:", "https:"].includes(u.protocol) ||
      u.username || u.password || u.port || u.pathname !== "/" ||
      u.search || u.hash || !/^[a-z0-9.-]+$/.test(u.hostname)) {
    throw new Error("STAGING_URL_INVALIDA");
  }
  return u.hostname.toLowerCase();
}
function validarDestinoEnsayo({
  url, hostEsperado, hostProduccion, authToken,
} = {}) {
  const host = hostDeUrl(url);
  if (typeof hostEsperado !== "string" ||
      typeof hostProduccion !== "string" ||
      !/^[a-z0-9.-]+$/.test(hostEsperado) ||
      !/^[a-z0-9.-]+$/.test(hostProduccion)) {
    throw new Error("STAGING_IDENTIDAD_NO_CONFIRMADA");
  }
  // La etiqueta de laboratorio es intencionadamente estricta: una BD
  // existente con otro nombre debe ser rechazada y no adaptarse a ciegas.
  if (!/^hogarstock-v3-test-[a-z0-9-]+\.turso\.io$/.test(host) ||
      host !== hostEsperado.toLowerCase() ||
      host === hostProduccion.toLowerCase()) {
    throw new Error("STAGING_DESTINO_NO_AUTORIZADO");
  }
  if (typeof authToken !== "string" ||
      authToken.length < 20 || authToken.length > 16384) {
    throw new Error("STAGING_TOKEN_INVALIDO");
  }
  return Object.freeze({ host, verificado: true });
}
function crearClienteRemotoEnsayo({
  url, hostEsperado, hostProduccion, authToken,
  permitirRed = false, crearCliente,
} = {}) {
  const verificacion = validarDestinoEnsayo({
    url, hostEsperado, hostProduccion, authToken,
  });
  if (permitirRed !== true) throw new Error("STAGING_RED_BLOQUEADA");
  if (typeof crearCliente !== "function") {
    throw new TypeError("STAGING_FABRICA_CLIENTE_INVALIDA");
  }
  // La fábrica y el token nunca se devuelven al frontend ni a los logs.
  const cliente = crearCliente({url, authToken});
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.batch !== "function" ||
      typeof cliente.transaction !== "function") {
    throw new Error("STAGING_CLIENTE_INCOMPATIBLE");
  }
  return {cliente, host:verificacion.host};
}
async function inspeccionarBaseSoloLectura(cliente) {
  if (!cliente || typeof cliente.execute !== "function") {
    throw new TypeError("STAGING_CLIENTE_INVALIDO");
  }
  const r = await cliente.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  const tablas = r.rows.map(x=>String(x.name)).filter(x=>!x.startsWith("sqlite_"));
  return Object.freeze({
    vacia: tablas.length===0,
    tablas: tablas.map(x=>x.replace(/[^a-zA-Z0-9_]/g,"?")),
    // Solo nombres de tablas; no devolver filas, tokens ni contenido.
  });
}
module.exports={validarDestinoEnsayo,crearClienteRemotoEnsayo,
 inspeccionarBaseSoloLectura};
