"use strict";
// Decisión de vinculación explícita. Por defecto no se permite crear una identidad.
// Activar solo en un corte autorizado, cuando se haya demostrado que no existe
// ninguna sesión reutilizable y se haya detenido completamente la instancia V2.
// Revocar el permiso tras completar la vinculación (S -> N).
function permitirVinculacionNueva(env = process.env) {
  if (!env || typeof env !== "object") throw Error("HS_WA_VINCULACION_CONFIG_INVALIDA");
  const flag = env.HS_WA_PERMITIR_NUEVA_VINCULACION ?? "N";
  if (flag !== "S" && flag !== "N") throw Error("HS_WA_VINCULACION_CONFIG_INVALIDA");
  if (flag === "N") return false;
  // No habilitar un modo de alta con almacenamiento no cifrado.
  if (env.HS_WA_AUTH_STORAGE !== "turso" ||
      !/^[a-f0-9]{64}$/i.test(env.HS_WA_AUTH_ENC_KEY || "")) {
    throw Error("HS_WA_VINCULACION_CIFRADO_REQUERIDO");
  }
  return true;
}
module.exports={permitirVinculacionNueva};
