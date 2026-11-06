"use strict";
// No es el punto de entrada del servidor. No inicia red ni servicios externos.
const { inicializarServiciosV3 } = require("./v3-compose-services.js");
const { crearAplicacionV3Produccion, validarOrigen } = require("./v3-production-app.js");

async function prepararAplicacionV3({
  cliente, origen, hashAdministrador, claveHmacHex,
  esquemaAuditado = false, escriturasAutorizadas = false,
} = {}) {
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
