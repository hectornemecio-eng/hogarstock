"use strict";

// Carga Baileys 7 como ESM desde una aplicación CommonJS.
// Solo IMPORTA el paquete; nunca abre sockets ni inicia sesión.
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

async function cargarBibliotecaBaileysReal() {
  // resolver CJS respeta NODE_PATH usado por las pruebas aisladas.
  const ruta = require.resolve("@whiskeysockets/baileys");
  const mod = await import(pathToFileURL(ruta).href);
  const resolver = createRequire(ruta);
  const P = resolver("pino");
  if (typeof P !== "function") {
    throw new Error("WA_PUENTE_LOGGER_INCOMPATIBLE");
  }
  return Object.freeze({
    makeWASocket: mod.default,
    initAuthCreds: mod.initAuthCreds,
    BufferJSON: mod.BufferJSON,
    proto: mod.proto,
    fetchLatestWaWebVersion: mod.fetchLatestWaWebVersion,
    logger: P({ level: "silent" }),
  });
}

// Esta consulta solo está permitida en el modo explícito "conexion".
// Puede hacer una petición HTTPS a la infraestructura WhatsApp Web;
// nunca se invoca durante comprobarSinRed().
async function consultarVersionBaileysReal(mod) {
  if (typeof mod?.fetchLatestWaWebVersion !== "function") {
    throw new Error("WA_PUENTE_CONSULTA_VERSION_NO_DISPONIBLE");
  }
  return mod.fetchLatestWaWebVersion();
}
module.exports = {
  cargarBibliotecaBaileysReal,
  consultarVersionBaileysReal,
};
