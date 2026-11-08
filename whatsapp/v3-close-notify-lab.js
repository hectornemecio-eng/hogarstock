"use strict";

// Cierre y notificacion V3, SOLO laboratorio aislado.
// NO conecta a WhatsApp, Turso ni Render. NO modificar productos.agotado.
// Registro OUTBOX y cierre de compra se confirman en la MISMA transaccion.
// Emisor inyectado y sometido a pruebas: prohibido en produccion.
// Un unico aviso logico por compra: clave de idempotencia estable.
// Un envio aceptado no se reintenta en reinicios; los fallos inciertos tampoco.
function crearCierreNotificadorV3({
  cliente, registro, despachador, destinatarioPermitido, entorno = {},
} = {}) {
  if (!cliente || typeof cliente.transaction !== "function" ||
      !registro || typeof registro.registrarSolicitudEnTransaccion !== "function" ||
      !despachador || typeof despachador.enviar !== "function" ||
      typeof destinatarioPermitido !== "function") {
    throw new TypeError("WA_CIERRE_DEPENDENCIAS_INVALIDAS");
  }
  if (entorno.HOGARSTOCK_V3_SANDBOX !== "1" ||
      entorno.HOGARSTOCK_V3_CLOSE_NOTIFY_LAB !== "1" ||
      entorno.HOGARSTOCK_V3_REMOTE_STAGE ||
      entorno.HOGARSTOCK_V3_WHATSAPP_LIVE ||
      entorno.HOGARSTOCK_STAGING_TURSO_URL ||
      entorno.TURSO_DATABASE_URL || entorno.TURSO_AUTH_TOKEN ||
      Object.keys(entorno).some(k => k.startsWith("WA_") && Boolean(entorno[k]))) {
    throw new Error("WA_CIERRE_SOLO_SANDBOX_FICTICIO");
  }
  function idValido(id) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError("WA_CIERRE_COMPRA_INVALIDA");
    }
    return id;
  }
  function telefonoValido(telefono) {
    if (typeof telefono !== "string" || telefono.length > 32) {
      throw new TypeError("WA_CIERRE_DESTINATARIO_INVALIDO");
    }
    const limpio = telefono.replace(/[\s()+-]/g, "");
    if (!/^[0-9]{8,15}$/.test(limpio)) {
      throw new TypeError("WA_CIERRE_DESTINATARIO_INVALIDO");
    }
    return limpio;
  }
  function textoSeguro(valor) {
    if (typeof valor !== "string") throw Error("WA_CIERRE_ITEM_INVALIDO");
    return valor.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  }
  function crearMensaje(compraId, items) {
    const faltantes = items.filter(x => x.estado !== "comprado");
    const completa = faltantes.length === 0;
    const comienzo = completa
      ? "Compra " + compraId + " completada. Todos los productos comprados."
      : "Compra " + compraId + " finalizada con faltantes. Quedan por conseguir:";
    const lineas = faltantes.map((x, i) =>
      (i + 1) + ". " + textoSeguro(x.nombre) +
      (x.estado === "no_disponible" ? " (no disponible)" : " (pendiente)"));
    const mensaje = [comienzo, ...lineas].join("\n");
    if (Buffer.byteLength(mensaje, "utf8") > 4096) {
      throw Error("WA_CIERRE_MENSAJE_DEMASIADO_LARGO");
    }
    return Object.freeze({ mensaje, completa, faltantes: faltantes.length });
  }
  function clave(compraId) { return "HS-V3-CIERRE-UNICO-" + compraId; }

  async function cerrarYNotificar({
    compraId, telefono, autorizarFaltantes = false,
  } = {}) {
    idValido(compraId);
    const numero = telefonoValido(telefono);
    if (typeof autorizarFaltantes !== "boolean") {
      throw new TypeError("WA_CIERRE_AUTORIZACION_INVALIDA");
    }
    // No asumir permiso por conocer telefono. El llamante ya debe ser
    // una frontera interna Baileys verificada o un administrador autorizado.
    if (await destinatarioPermitido(numero) !== true) {
      throw Error("WA_CIERRE_DESTINATARIO_NO_PERMITIDO");
    }
    const tx = await cliente.transaction("write");
    let paquete;
    try {
      const cab = await tx.execute({
        sql: "SELECT estado,revision FROM hogarstock_compras_v3 WHERE id=?",
        args: [compraId],
      });
      if (cab.rows.length !== 1) throw Error("WA_CIERRE_COMPRA_NO_EXISTE");
      const estado = String(cab.rows[0].estado);
      if (!["abierta", "finalizada"].includes(estado)) {
        throw Error("WA_CIERRE_ESTADO_INVALIDO");
      }
      const lista = await tx.execute({
        sql: "SELECT id,nombre,estado FROM hogarstock_compra_items_v3 " +
             "WHERE compra_id=? ORDER BY id",
        args: [compraId],
      });
      const items = lista.rows.map(x => ({
        nombre: String(x.nombre), estado: String(x.estado),
      }));
      if (!items.length ||
          items.some(x => !["comprado","pendiente","no_disponible"].includes(x.estado))) {
        throw Error("WA_CIERRE_ITEMS_INVALIDOS");
      }
      paquete = crearMensaje(compraId, items);
      if (!paquete.completa && autorizarFaltantes !== true) {
        throw Error("WA_CIERRE_FALTANTES_REQUIEREN_CONFIRMACION");
      }
      // Primero persistir en OUTBOX (cifrado); si falla, no cerrar compra.
      const operacion = await registro.registrarSolicitudEnTransaccion({
        transaccion: tx, claveIdempotencia: clave(compraId),
        telefono: numero, mensaje: paquete.mensaje, compraId,
      });
      if (estado === "abierta") {
        const actualizado = await tx.execute({
          sql: "UPDATE hogarstock_compras_v3 " +
            "SET estado='finalizada',finalizada=?,revision=revision+1 " +
            "WHERE id=? AND estado='abierta' AND revision=?",
          args: [Date.now(), compraId, Number(cab.rows[0].revision)],
        });
        if (Number(actualizado.rowsAffected) !== 1) {
          throw Error("WA_CIERRE_CONFLICTO_VERSION");
        }
      }
      await tx.commit();
      paquete = { ...paquete, operacionId: operacion.id,
        nuevaOperacion: operacion.creada, yaFinalizada: estado === "finalizada" };
    } catch (e) {
      try { await tx.rollback(); } catch (_) { /* preservar error original */ }
      throw e;
    } finally {
      tx.close();
    }

    // Este paso se hace SOLO despues de confirmar la transaccion.
    // Si falla, el mensaje persiste; reintento EXPLICITO posterior,
    // nunca reenvio automatico de un intento indeterminado.
    let envio;
    try {
      envio = await despachador.enviar({
        claveIdempotencia: clave(compraId), telefono: numero,
        mensaje: paquete.mensaje, compraId,
      });
    } catch (_) {
      return Object.freeze({
        compraId, cerrada: true, completa: paquete.completa,
        faltantes: paquete.faltantes, operacionId: paquete.operacionId,
        notificacion: "pendiente_verificacion_manual",
        // No afirmar que no se envio; puede haberse producido el efecto externo.
      });
    }
    return Object.freeze({
      compraId, cerrada: true, completa: paquete.completa,
      faltantes: paquete.faltantes, operacionId: paquete.operacionId,
      nuevaOperacion: paquete.nuevaOperacion,
      notificacion: String(envio.estado),
      // aceptado_proveedor no equivale a entregado.
    });
  }
  return Object.freeze({ cerrarYNotificar });
}
module.exports = { crearCierreNotificadorV3 };
