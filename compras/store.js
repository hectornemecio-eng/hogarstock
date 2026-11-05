"use strict";

// Modelo aislado de compras V3. No se integra en server.js ni usa credenciales.
// Requiere un cliente compatible con @libsql/client: execute(), batch(),
// transaction("write"). NO modifica la tabla productos ni su campo agotado.

const CABECERA = "hogarstock_compras_v3";
const LINEAS = "hogarstock_compra_items_v3";
const ESTADOS_ITEM = new Set(["pendiente", "comprado", "no_disponible"]);

const ESQUEMA = [
  "CREATE TABLE IF NOT EXISTS hogarstock_compras_v3 (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "estado TEXT NOT NULL DEFAULT 'abierta' " +
      "CHECK(estado IN ('abierta','finalizada')), " +
    "creada INTEGER NOT NULL, finalizada INTEGER, " +
    "revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0))",
  "CREATE TABLE IF NOT EXISTS hogarstock_compra_items_v3 (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "compra_id INTEGER NOT NULL REFERENCES hogarstock_compras_v3(id), " +
    "producto_id INTEGER NOT NULL, nombre TEXT NOT NULL, " +
    "categoria TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 1 " +
      "CHECK(cantidad >= 1 AND cantidad <= 999), " +
    "unidad TEXT, estado TEXT NOT NULL DEFAULT 'pendiente' " +
      "CHECK(estado IN ('pendiente','comprado','no_disponible')), " +
    "actualizada INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0 " +
      "CHECK(revision >= 0), UNIQUE(compra_id,producto_id))",
  "CREATE INDEX IF NOT EXISTS idx_hs_compras_estado_v3 " +
    "ON hogarstock_compras_v3(estado,creada)",
  "CREATE INDEX IF NOT EXISTS idx_hs_compra_items_compra_v3 " +
    "ON hogarstock_compra_items_v3(compra_id)",
];

function validarId(id, nombre) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError(nombre + " debe ser un entero positivo seguro");
  }
  return id;
}

function validarVersion(version) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError("revisionEsperada debe ser un entero no negativo");
  }
  return version;
}

function fechaSegura(reloj) {
  const fecha = reloj();
  if (!Number.isSafeInteger(fecha) || fecha < 0) {
    throw new TypeError("Instante de reloj invalido");
  }
  return fecha;
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0 || lineas.length > 300) {
    throw new TypeError("Se requieren entre 1 y 300 productos");
  }
  const vistos = new Set();
  return lineas.map((linea) => {
    if (!linea || typeof linea !== "object" || Array.isArray(linea)) {
      throw new TypeError("Linea de compra invalida");
    }
    const productoId = validarId(linea.productoId, "productoId");
    if (vistos.has(productoId)) throw new Error("PRODUCTO_DUPLICADO");
    vistos.add(productoId);
    const cantidad = linea.cantidad === undefined ? 1 : linea.cantidad;
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) {
      throw new TypeError("cantidad fuera de rango 1-999");
    }
    const unidad = linea.unidad === undefined || linea.unidad === null
      ? null
      : String(linea.unidad).trim();
    if (unidad !== null && (unidad.length === 0 || unidad.length > 30)) {
      throw new TypeError("unidad invalida");
    }
    return { productoId, cantidad, unidad };
  });
}

function numeroId(valor) {
  const id = Number(valor);
  return validarId(id, "ID generado");
}

async function conTransaccion(cliente, tarea) {
  const tx = await cliente.transaction("write");
  try {
    const valor = await tarea(tx);
    await tx.commit();
    return valor;
  } catch (error) {
    // Las transacciones se cierran aun si falla un INSERT o un CHECK.
    try { await tx.rollback(); } catch (_) { /* evitar ocultar la causa */ }
    throw error;
  } finally {
    tx.close();
  }
}

function crearAlmacenCompras(cliente, { reloj = Date.now } = {}) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.batch !== "function" ||
      typeof cliente.transaction !== "function") {
    throw new TypeError("Se requiere un cliente libSQL con execute, batch y transaction");
  }
  let inicializado = false;
  function exigirInit() {
    if (!inicializado) throw new Error("COMPRAS_NO_INICIALIZADAS");
  }
  async function comprobarTabla(nombre, columnasRequeridas) {
    const consulta = await cliente.execute("PRAGMA table_info(" + nombre + ")");
    if (consulta.rows.length === 0) return false;
    const columnas = new Map(consulta.rows.map((fila) => [String(fila.name), fila]));
    const faltantes = columnasRequeridas.filter((columna) => !columnas.has(columna));
    if (faltantes.length ||
        Number(columnas.get("id").pk) !== 1) {
      throw new Error(
        "ESQUEMA_COMPRAS_INCOMPATIBLE: " + nombre +
        " faltan columnas/clave primaria " + faltantes.join(", ") +
        "; no se borraran datos."
      );
    }
    return true;
  }

  async function init() {
    const columnasProducto = await cliente.execute("PRAGMA table_info(productos)");
    const presentes = new Set(columnasProducto.rows.map((fila) => String(fila.name)));
    for (const nombre of ["id", "nombre", "categoria", "agotado"]) {
      if (!presentes.has(nombre)) {
        throw new Error("ESQUEMA_PRODUCTOS_INCOMPATIBLE: falta " + nombre);
      }
    }
    await comprobarTabla(CABECERA, ["id", "estado", "creada", "finalizada", "revision"]);
    await comprobarTabla(LINEAS, [
      "id", "compra_id", "producto_id", "nombre", "categoria",
      "cantidad", "unidad", "estado", "actualizada", "revision",
    ]);
    // Las sentencias de creacion se ejecutan juntas o no se aplica ninguna.
    await cliente.batch(ESQUEMA, "write");
    await comprobarTabla(CABECERA, ["id", "estado", "creada", "finalizada", "revision"]);
    await comprobarTabla(LINEAS, [
      "id", "compra_id", "producto_id", "nombre", "categoria",
      "cantidad", "unidad", "estado", "actualizada", "revision",
    ]);
    inicializado = true;
  }

  async function crearCompra({ lineas }) {
    exigirInit();
    const pedido = validarLineas(lineas);
    return conTransaccion(cliente, async (tx) => {
      // Se comprueba el estado de productos en la misma transaccion.
      const fotografias = [];
      for (const item of pedido) {
        const consulta = await tx.execute({
          sql: "SELECT id,nombre,categoria,agotado FROM productos WHERE id=?",
          args: [item.productoId],
        });
        const producto = consulta.rows[0];
        if (!producto) throw new Error("PRODUCTO_INEXISTENTE");
        if (Number(producto.agotado) !== 1) {
          throw new Error("PRODUCTO_NO_MARCADO_COMO_FALTANTE");
        }
        fotografias.push({
          productoId: item.productoId,
          nombre: String(producto.nombre),
          categoria: String(producto.categoria),
          cantidad: item.cantidad,
          unidad: item.unidad,
        });
      }

      const creada = fechaSegura(reloj);
      const cabecera = await tx.execute({
        sql: "INSERT INTO hogarstock_compras_v3 (estado,creada,finalizada,revision) " +
          "VALUES ('abierta',?,NULL,0)",
        args: [creada],
      });
      const compraId = numeroId(cabecera.lastInsertRowid);
      for (const item of fotografias) {
        await tx.execute({
          sql: "INSERT INTO hogarstock_compra_items_v3 (" +
            "compra_id,producto_id,nombre,categoria,cantidad,unidad,estado,actualizada,revision" +
            ") VALUES (?,?,?,?,?,?,'pendiente',?,0)",
          args: [
            compraId, item.productoId, item.nombre, item.categoria,
            item.cantidad, item.unidad, creada,
          ],
        });
      }
      return { compraId, cantidad: fotografias.length, creada };
    });
  }

  async function obtenerCompra({ compraId }) {
    exigirInit();
    validarId(compraId, "compraId");
    const respuesta = await cliente.execute({
      sql: "SELECT c.id AS compra_id,c.estado AS compra_estado," +
        "c.creada AS compra_creada,c.finalizada AS compra_finalizada," +
        "c.revision AS compra_revision," +
        "i.id AS item_id,i.producto_id,i.nombre,i.categoria,i.cantidad," +
        "i.unidad,i.estado AS item_estado,i.revision AS item_revision " +
        "FROM hogarstock_compras_v3 c " +
        "LEFT JOIN hogarstock_compra_items_v3 i ON i.compra_id=c.id " +
        "WHERE c.id=? ORDER BY i.id",
      args: [compraId],
    });
    if (respuesta.rows.length === 0) return null;
    const filas = respuesta.rows;
    const items = filas.filter((fila) => fila.item_id != null).map((fila) => ({
      id: numeroId(fila.item_id),
      productoId: numeroId(fila.producto_id),
      nombre: String(fila.nombre),
      categoria: String(fila.categoria),
      cantidad: Number(fila.cantidad),
      unidad: fila.unidad === null ? null : String(fila.unidad),
      estado: String(fila.item_estado),
      revision: Number(fila.item_revision),
    }));
    return {
      id: numeroId(filas[0].compra_id),
      estado: String(filas[0].compra_estado),
      creada: Number(filas[0].compra_creada),
      finalizada: filas[0].compra_finalizada == null
        ? null : Number(filas[0].compra_finalizada),
      revision: Number(filas[0].compra_revision),
      items,
      resumen: {
        total: items.length,
        pendientes: items.filter((i) => i.estado === "pendiente").length,
        comprados: items.filter((i) => i.estado === "comprado").length,
        noDisponibles: items.filter((i) => i.estado === "no_disponible").length,
      },
    };
  }

  async function cambiarEstadoItem({ compraId, itemId, estado, revisionEsperada }) {
    exigirInit();
    validarId(compraId, "compraId");
    validarId(itemId, "itemId");
    validarVersion(revisionEsperada);
    if (!ESTADOS_ITEM.has(estado)) throw new TypeError("Estado de compra invalido");
    return conTransaccion(cliente, async (tx) => {
      const cabecera = await tx.execute({
        sql: "SELECT estado FROM hogarstock_compras_v3 WHERE id=?",
        args: [compraId],
      });
      if (!cabecera.rows.length) throw new Error("COMPRA_NO_ENCONTRADA");
      if (cabecera.rows[0].estado !== "abierta") throw new Error("COMPRA_CERRADA");
      const actual = await tx.execute({
        sql: "SELECT estado,revision FROM hogarstock_compra_items_v3 WHERE id=? AND compra_id=?",
        args: [itemId, compraId],
      });
      if (!actual.rows.length) throw new Error("ITEM_NO_ENCONTRADO");
      if (Number(actual.rows[0].revision) !== revisionEsperada) {
        throw new Error("CONFLICTO_VERSION");
      }
      if (actual.rows[0].estado === estado) {
        return { cambiado: false, revision: revisionEsperada, estado };
      }
      const cambio = await tx.execute({
        sql: "UPDATE hogarstock_compra_items_v3 " +
          "SET estado=?, revision=revision+1, actualizada=? " +
          "WHERE id=? AND compra_id=? AND revision=?",
        args: [estado, fechaSegura(reloj), itemId, compraId, revisionEsperada],
      });
      if (Number(cambio.rowsAffected) !== 1) throw new Error("CONFLICTO_VERSION");
      return { cambiado: true, revision: revisionEsperada + 1, estado };
    });
  }

  async function finalizarCompra({ compraId }) {
    exigirInit();
    validarId(compraId, "compraId");
    return conTransaccion(cliente, async (tx) => {
      const anterior = await tx.execute({
        sql: "SELECT estado,finalizada FROM hogarstock_compras_v3 WHERE id=?",
        args: [compraId],
      });
      if (!anterior.rows.length) throw new Error("COMPRA_NO_ENCONTRADA");
      if (anterior.rows[0].estado === "finalizada") {
        return {
          compraId, finalizada: Number(anterior.rows[0].finalizada),
          yaFinalizada: true,
        };
      }
      const finalizada = fechaSegura(reloj);
      const resultado = await tx.execute({
        sql: "UPDATE hogarstock_compras_v3 " +
          "SET estado='finalizada',finalizada=?,revision=revision+1 " +
          "WHERE id=? AND estado='abierta'",
        args: [finalizada, compraId],
      });
      if (Number(resultado.rowsAffected) !== 1) throw new Error("CONFLICTO_VERSION");
      // NO modifica productos.agotado ni envia mensajes; la integracion decidira
      // cuando sincronizar inventario y confirmar la entrega por WhatsApp.
      return { compraId, finalizada, yaFinalizada: false };
    });
  }

  async function listarCompras({ limite = 40 } = {}) {
    exigirInit();
    if (!Number.isSafeInteger(limite) || limite < 1 || limite > 100) {
      throw new TypeError("Limite de compras invalido");
    }
    const resultado = await cliente.execute({
      sql: "SELECT c.id,c.estado,c.creada,c.finalizada,c.revision," +
        "COUNT(i.id) AS total," +
        "SUM(CASE WHEN i.estado='comprado' THEN 1 ELSE 0 END) AS comprados," +
        "SUM(CASE WHEN i.estado='pendiente' THEN 1 ELSE 0 END) AS pendientes," +
        "SUM(CASE WHEN i.estado='no_disponible' THEN 1 ELSE 0 END) AS no_disponibles " +
        "FROM hogarstock_compras_v3 c " +
        "LEFT JOIN hogarstock_compra_items_v3 i ON i.compra_id=c.id " +
        "GROUP BY c.id ORDER BY c.id DESC LIMIT ?",
      args: [limite],
    });
    return resultado.rows.map((fila) => ({
      id: Number(fila.id),
      estado: String(fila.estado),
      creada: Number(fila.creada),
      finalizada: fila.finalizada == null ? null : Number(fila.finalizada),
      revision: Number(fila.revision),
      total: Number(fila.total),
      comprados: Number(fila.comprados || 0),
      pendientes: Number(fila.pendientes || 0),
      noDisponibles: Number(fila.no_disponibles || 0),
    }));
  }

  return Object.freeze({
    init, crearCompra, obtenerCompra, cambiarEstadoItem, finalizarCompra, listarCompras,
  });
}

module.exports = { crearAlmacenCompras };
