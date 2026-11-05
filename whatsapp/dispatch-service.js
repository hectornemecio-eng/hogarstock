"use strict";

// Servicio de salida para la lista doméstica de contactos permitidos.
// Requiere almacenamiento persistente y un emisor interno autenticado.
// No abre conexiones ni publica rutas HTTP.
function crearDespachador({ registro, enviarInterno }) {
  if (!registro || ["registrarSolicitud","reclamarEnvio","registrarResultado","obtener"]
      .some(x => typeof registro[x] !== "function")) {
    throw new TypeError("REGISTRO_NO_VALIDO");
  }
  if (typeof enviarInterno !== "function") throw new TypeError("EMISOR_NO_VALIDO");

  const activos = new Map();
  async function enviar({ claveIdempotencia, telefono, mensaje, compraId = null }) {
    const op = await registro.registrarSolicitud({ claveIdempotencia, telefono, mensaje, compraId });
    if (activos.has(op.id)) {
      await activos.get(op.id);
      return registro.obtener(op.id);
    }
    const tarea = (async () => {
      const reserva = await registro.reclamarEnvio(op.id);
      if (!reserva.adquirido) return;
      let respuesta;
      try {
        respuesta = await enviarInterno({ telefono: reserva.telefono, mensaje: reserva.mensaje });
      } catch (_) {
        respuesta = { estado: "indeterminado", codigo: "WA_ENVIO_NO_VERIFICABLE" };
      }
      if (!respuesta || !["aceptado_por_proveedor","indeterminado","no_iniciado","rechazado"].includes(respuesta.estado)) {
        respuesta = { estado: "indeterminado", codigo: "WA_ENVIO_NO_VERIFICABLE" };
      }
      const datos = { id: op.id, estado: respuesta.estado, codigo: respuesta.codigo ?? null };
      if (respuesta.estado === "aceptado_por_proveedor") {
        datos.proveedorId = respuesta.proveedorId ?? null;
        if (datos.proveedorId === null) {
          datos.estado = "indeterminado";
          datos.codigo = "WA_SIN_ACUSE_DEL_PROVEEDOR";
          delete datos.proveedorId;
        }
      }
      await registro.registrarResultado(datos);
    })();
    activos.set(op.id, tarea);
    try { await tarea; } finally { activos.delete(op.id); }
    return registro.obtener(op.id);
  }
  return Object.freeze({ enviar });
}
module.exports = { crearDespachador };
