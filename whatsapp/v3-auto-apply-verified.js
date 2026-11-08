"use strict";

// Procesador de respuestas V3: SOLO eventos que ya atravesaron la frontera
// autenticada del adaptador interno Baileys. NUNCA montar en HTTP/WebSocket.
// OFF por defecto y únicamente habilitable en sandbox con datos ficticios.
// No emite WhatsApp, no finaliza compras ni cambia productos.agotado.
function crearProcesadorRespuestasV3({
  bandeja, compras, aplicador, modo = "revision_manual", entorno = {},
} = {}) {
  if (!bandeja || typeof bandeja.recibir !== "function" ||
      !compras || typeof compras.obtenerCompra !== "function" ||
      !aplicador || typeof aplicador.aplicar !== "function") {
    throw new TypeError("WA_AUTO_APPLY_DEPENDENCIAS_INVALIDAS");
  }
  if (!["revision_manual", "auto_comprado"].includes(modo)) {
    throw new TypeError("WA_AUTO_APPLY_MODO_INVALIDO");
  }
  if (modo === "auto_comprado" && (
    entorno.HOGARSTOCK_V3_SANDBOX !== "1" ||
    entorno.HOGARSTOCK_V3_AUTO_APPLY_INBOUND !== "1" ||
    entorno.HOGARSTOCK_V3_REMOTE_STAGE ||
    entorno.TURSO_DATABASE_URL ||
    entorno.TURSO_AUTH_TOKEN ||
    entorno.HOGARSTOCK_STAGING_TURSO_URL ||
    entorno.HOGARSTOCK_V3_WHATSAPP_LIVE
  )) {
    throw new Error("WA_AUTO_APPLY_SOLO_SANDBOX_FICTICIO");
  }
  const automatico = modo === "auto_comprado";

  async function recibir(entrada) {
    // Autenticidad: esta función sólo se invoca desde el adaptador interno.
    // La bandeja verifica la vinculación del número con UNA compra abierta,
    // deduplica los IDs y registra la propuesta antes de modificar estados.
    const propuesta = await bandeja.recibir(entrada);
    if (!automatico || propuesta?.estado !== "pendiente_revision" ||
        propuesta.accion !== "comprado") {
      return Object.freeze({
        estado: propuesta?.estado ?? "no_interpretable",
        aplicado: false,
        requiereRevision: propuesta?.estado === "pendiente_revision",
      });
    }
    if (!Number.isSafeInteger(propuesta.compraId) || propuesta.compraId < 1 ||
        !Number.isSafeInteger(propuesta.itemId) || propuesta.itemId < 1 ||
        typeof propuesta.id !== "string") {
      return Object.freeze({
        estado: "pendiente_revision", aplicado: false, requiereRevision: true,
        codigo: "WA_AUTO_PROPUESTA_INVALIDA",
      });
    }

    try {
      const compra = await compras.obtenerCompra({ compraId: propuesta.compraId });
      const item = compra?.items?.find(x => x.id === propuesta.itemId);
      if (compra?.estado !== "abierta" || !item ||
          !Number.isSafeInteger(item.revision)) {
        return Object.freeze({
          estado: "pendiente_revision", aplicado: false,
          requiereRevision: true, codigo: "WA_AUTO_COMPRA_NO_APLICABLE",
        });
      }
      const resultado = await aplicador.aplicar({
        compraId: propuesta.compraId,
        respuestaId: propuesta.id,
        revisionEsperada: item.revision,
      });
      const nueva = await compras.obtenerCompra({ compraId: propuesta.compraId });
      const todosComprados = nueva?.resumen?.total > 0 &&
        nueva.resumen.comprados === nueva.resumen.total;
      return Object.freeze({
        estado: "aplicado_automatico",
        aplicado: true,
        cambiado: resultado.cambiado,
        compraId: propuesta.compraId,
        itemId: propuesta.itemId,
        todosComprados: Boolean(todosComprados),
        // Únicamente una señal interna: NO finaliza ni envía confirmación.
        requiereNotificacion: Boolean(todosComprados),
      });
    } catch (_) {
      // Dejar propuesta pendiente. Ni reintentar a ciegas ni exponer SQL,
      // teléfono, texto, credenciales o identificadores del proveedor.
      return Object.freeze({
        estado: "pendiente_revision", aplicado: false,
        requiereRevision: true, codigo: "WA_AUTO_APLICACION_NO_CONFIRMADA",
      });
    }
  }
  return Object.freeze({ recibir, modo });
}
module.exports = { crearProcesadorRespuestasV3 };
