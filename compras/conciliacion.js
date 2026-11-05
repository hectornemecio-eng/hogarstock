"use strict";

// Conciliacion V3: informe de SOLO LECTURA, no cambia productos.agotado.
// Se limita a compras FINALIZADAS, requiere revision explicita del administrador.

function comprobarId(id) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError("compraId invalido");
  }
}

function crearConciliadorCompras(cliente) {
  if (!cliente || typeof cliente.execute !== "function") {
    throw new TypeError("Se requiere cliente SQL de consulta");
  }

  async function informeCompraFinalizada({ compraId }) {
    comprobarId(compraId);

    // Una unica SELECT produce una fotografia coherente para el informe.
    const resultado = await cliente.execute({
      sql:
        "SELECT c.id AS compra_id, c.estado AS compra_estado, " +
        "i.id AS item_id, i.producto_id, i.nombre AS nombre_comprado, " +
        "i.estado AS estado_item, p.nombre AS nombre_catalogo, " +
        "p.agotado AS agotado_actual, " +
        "EXISTS (SELECT 1 FROM hogarstock_compra_items_v3 otro " +
        "JOIN hogarstock_compras_v3 otra_compra ON otra_compra.id=otro.compra_id " +
        "WHERE otro.producto_id=i.producto_id AND otra_compra.estado='abierta' " +
        "AND otra_compra.id<>c.id) AS en_otra_compra_abierta " +
        "FROM hogarstock_compras_v3 c " +
        "JOIN hogarstock_compra_items_v3 i ON i.compra_id=c.id " +
        "LEFT JOIN productos p ON p.id=i.producto_id " +
        "WHERE c.id=? ORDER BY i.id",
      args: [compraId],
    });

    if (resultado.rows.length === 0) {
      throw new Error("COMPRA_NO_ENCONTRADA_O_SIN_ITEMS");
    }
    if (resultado.rows[0].compra_estado !== "finalizada") {
      throw new Error("COMPRA_NO_FINALIZADA");
    }

    const lineas = resultado.rows.map((fila) => {
      const comprada = String(fila.estado_item) === "comprado";
      const existe = fila.nombre_catalogo !== null && fila.nombre_catalogo !== undefined;
      const agotado = existe && Number(fila.agotado_actual) === 1;
      const compartido = Number(fila.en_otra_compra_abierta) === 1;
      let codigo;
      let accionSugerida;

      if (!existe) {
        codigo = "PRODUCTO_NO_EXISTE";
        accionSugerida = "Revisar manualmente: el producto ya no existe en el catalogo";
      } else if (!comprada) {
        codigo = "NO_COMPRADO";
        accionSugerida = "Mantener la necesidad pendiente; revisar el resultado de compra";
      } else if (!agotado) {
        codigo = "YA_NO_AGOTADO";
        accionSugerida = "No cambiar: el catalogo ya no indica que falte";
      } else if (compartido) {
        codigo = "COMPRA_ABIERTA_COMPARTIDA";
        accionSugerida = "No limpiar automaticamente; existe otra compra abierta con el articulo";
      } else {
        codigo = "REVISION_ADMINISTRADOR";
        accionSugerida = "Posible reposicion; verificar y confirmar manualmente";
      }

      return {
        itemId: Number(fila.item_id),
        productoId: Number(fila.producto_id),
        nombreEnCompra: String(fila.nombre_comprado),
        estadoEnCompra: String(fila.estado_item),
        agotadoActual: existe ? Number(fila.agotado_actual) : null,
        existeEnCatalogo: existe,
        apareceEnOtraCompraAbierta: compartido,
        codigo,
        accionSugerida,
      };
    });

    const conteos = {};
    for (const item of lineas) conteos[item.codigo] = (conteos[item.codigo] || 0) + 1;
    return {
      compraId,
      estado: "finalizada",
      soloLectura: true,
      aplicacionAutomatica: false,
      notas:
        "Una confirmacion administrativa futura debera volver a consultar el " +
        "estado y prevenir carreras; este informe NO es una autorizacion de escritura.",
      conteos,
      lineas,
    };
  }

  return Object.freeze({ informeCompraFinalizada });
}

module.exports = { crearConciliadorCompras };
