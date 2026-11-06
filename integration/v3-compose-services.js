"use strict";

// Composición V3 con dependencias inyectadas: no abre conexiones, no despliega,
// no usa contraseñas de demo y no activa WhatsApp. init() escribe tablas V3,
// por lo que exige autorización explícita y preflight externo ya aprobado.
const { crearServicioAcceso } = require("../security/access.js");
const { crearAlmacenSeguridad } = require("../security/store.js");
const { crearCredencialesAdmin } = require("../security/admin-credentials.js");
const { crearSesionesComprador } = require("../security/buyer-sessions.js");
const { crearCatalogoV3 } = require("../catalogo/store.js");
const { crearAlmacenCompras } = require("../compras/store.js");
const { crearConciliadorCompras } = require("../compras/conciliacion.js");
const { crearBandejaWhatsApp } = require("../whatsapp/inbox-store.js");
const { crearAplicadorWhatsApp } = require("../whatsapp/apply-proposal.js");

function validarOpciones({ cliente, hashAdministrador, claveHmacHex,
  esquemaAuditado, escriturasAutorizadas } = {}) {
  if (!cliente || ["execute", "batch", "transaction"].some(
    nombre => typeof cliente[nombre] !== "function")) {
    throw new Error("V3_CLIENTE_LIBSQL_INVALIDO");
  }
  if (typeof hashAdministrador !== "string" ||
      !/^scrypt:16384:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hashAdministrador)) {
    throw new Error("V3_HASH_ADMIN_INVALIDO");
  }
  if (typeof claveHmacHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(claveHmacHex)) {
    throw new Error("V3_CLAVE_HMAC_INVALIDA");
  }
  if (esquemaAuditado !== true || escriturasAutorizadas !== true) {
    throw new Error("V3_INICIALIZACION_NO_AUTORIZADA");
  }
  if (process.env.HOGARSTOCK_V3_SANDBOX === "1") {
    throw new Error("V3_COMPOSICION_PRODUCTIVA_EN_SANDBOX");
  }
}

async function inicializarServiciosV3(opciones = {}) {
  validarOpciones(opciones);
  const { cliente, hashAdministrador, claveHmacHex } = opciones;
  // Los validadores e inicializadores de cada almacén detienen el proceso
  // si detectan un esquema incompatible. No se abre ningún servidor aquí.
  const almacenSeguridad = crearAlmacenSeguridad(cliente);
  const compras = crearAlmacenCompras(cliente);
  const credenciales = crearCredencialesAdmin({ cliente });
  const sesionesComprador = crearSesionesComprador({ cliente });
  const catalogo = crearCatalogoV3(cliente);
  const conciliador = crearConciliadorCompras(cliente);
  const bandejaWhatsApp = crearBandejaWhatsApp({
    cliente, compras, claveHmacHex,
  });
  const aplicadorWhatsApp = crearAplicadorWhatsApp({ cliente });
  await almacenSeguridad.init();
  await compras.init();
  await credenciales.init({ hashInicial: hashAdministrador });
  await sesionesComprador.init();
  await bandejaWhatsApp.init();
  await aplicadorWhatsApp.init();
  const acceso = crearServicioAcceso({
    almacen: almacenSeguridad, hashAdministrador, credenciales,
  });
  return Object.freeze({
    acceso, compras, catalogo, conciliador, sesionesComprador,
    bandejaWhatsApp, aplicadorWhatsApp,
  });
}

module.exports = { validarOpciones, inicializarServiciosV3 };
