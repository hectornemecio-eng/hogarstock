"use strict";
// NO es el entrypoint de Render. Sin listen(), Turso ni Baileys automáticos.
const { inicializarServiciosV3 } = require("./v3-compose-services.js");
const { crearAplicacionV3Produccion } = require("./v3-production-app.js");

async function prepararAplicacionV3({
  cliente, origen, hashAdministrador, claveHmacHex,
  esquemaAuditado = false, escriturasAutorizadas = false,
} = {}) {
  // Nunca iniciar escrituras hasta validar el origen y el estado del esquema.
  const { validarOrigen } = require("./v3-production-app.js");
  validarOrigen(origen);
  const servicios = await inicializarServiciosV3({
    cliente, hashAdministrador, claveHmacHex,
    esquemaAuditado, escriturasAutorizadas,
  });
  const app = crearAplicacionV3Produccion({
    ...servicios, origen, esquemaVerificado: true,
  });
  return Object.freeze({ app, servicios });
}
module.exports = { prepararAplicacionV3 };
