"use strict";

// Catalogo administrativo V3. Opera sobre la tabla productos existente.
// No elimina filas ni modifica compras. Requiere un cliente libSQL.
function idValido(valor) {
  if (!Number.isSafeInteger(valor) || valor < 1) {
    throw new TypeError("ID_PRODUCTO_INVALIDO");
  }
  return valor;
}
function campoTexto(valor, nombre, limite) {
  if (typeof valor !== "string") throw new TypeError(nombre + " invalido");
  const limpio = valor.trim().replace(/\s+/g, " ");
  if (!limpio || limpio.length > limite || /[\u0000-\u001f\u007f]/.test(valor)) {
    throw new TypeError(nombre + " invalido");
  }
  return limpio;
}
function estadoValido(valor) {
  if (valor !== 0 && valor !== 1) {
    throw new TypeError("ESTADO_AGOTADO_INVALIDO");
  }
  return valor;
}
async function transaccion(cliente, tarea) {
  const tx = await cliente.transaction("write");
  try {
    const resultado = await tarea(tx);
    await tx.commit();
    return resultado;
  } catch (error) {
    try { await tx.rollback(); } catch (_) { /* preservar causa */ }
    throw error;
  } finally {
    tx.close();
  }
}
function crearCatalogoV3(cliente) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.transaction !== "function") {
    throw new TypeError("Cliente SQL incompleto");
  }
  async function listarProductos() {
    const resultado = await cliente.execute(
      "SELECT id,nombre,categoria,agotado FROM productos ORDER BY categoria,nombre,id"
    );
    return resultado.rows.map((r) => ({
      id: Number(r.id),
      nombre: String(r.nombre),
      categoria: String(r.categoria),
      agotado: Number(r.agotado) === 1,
    }));
  }
  async function agregarProducto({ nombre, categoria }) {
    const n = campoTexto(nombre, "nombre", 120);
    const c = campoTexto(categoria, "categoria", 70);
    return transaccion(cliente, async (tx) => {
      const encontrado = await tx.execute({
        sql: "SELECT id FROM productos WHERE LOWER(TRIM(nombre))=LOWER(?) " +
          "AND LOWER(TRIM(categoria))=LOWER(?) LIMIT 1",
        args: [n, c],
      });
      if (encontrado.rows.length) throw new Error("PRODUCTO_DUPLICADO");
      const resultado = await tx.execute({
        sql: "INSERT INTO productos (nombre,categoria,agotado) VALUES (?,?,0)",
        args: [n, c],
      });
      return { id: Number(resultado.lastInsertRowid), nombre: n, categoria: c, agotado: false };
    });
  }
  async function editarProducto({ productoId, nombre, categoria }) {
    const id = idValido(productoId);
    const n = campoTexto(nombre, "nombre", 120);
    const c = campoTexto(categoria, "categoria", 70);
    return transaccion(cliente, async (tx) => {
      const actual = await tx.execute({
        sql: "SELECT id,agotado FROM productos WHERE id=? LIMIT 1",args:[id],
      });
      if (!actual.rows.length) throw new Error("PRODUCTO_INEXISTENTE");
      const duplicado = await tx.execute({
        sql: "SELECT id FROM productos WHERE id<>? AND LOWER(TRIM(nombre))=LOWER(?) " +
          "AND LOWER(TRIM(categoria))=LOWER(?) LIMIT 1",
        args:[id,n,c],
      });
      if (duplicado.rows.length) throw new Error("PRODUCTO_DUPLICADO");
      await tx.execute({
        sql:"UPDATE productos SET nombre=?,categoria=? WHERE id=?",args:[n,c,id],
      });
      return { id,nombre:n,categoria:c,agotado:Number(actual.rows[0].agotado)===1 };
    });
  }
  async function cambiarNecesidad({ productoId, agotado, agotadoEsperado }) {
    const id = idValido(productoId);
    const nuevo = estadoValido(agotado);
    const esperado = estadoValido(agotadoEsperado);
    if (nuevo === esperado) {
      throw new TypeError("ESTADO_SIN_CAMBIO");
    }
    return transaccion(cliente, async (tx) => {
      const cambio = await tx.execute({
        sql: "UPDATE productos SET agotado=? WHERE id=? AND agotado=?",
        args:[nuevo,id,esperado],
      });
      if (Number(cambio.rowsAffected) === 1) {
        return { id, agotado: nuevo === 1 };
      }
      const existe = await tx.execute({
        sql:"SELECT id FROM productos WHERE id=? LIMIT 1",args:[id],
      });
      if (!existe.rows.length) throw new Error("PRODUCTO_INEXISTENTE");
      throw new Error("CONFLICTO_ESTADO_PRODUCTO");
    });
  }
  return Object.freeze({ listarProductos,agregarProducto,editarProducto,cambiarNecesidad });
}
module.exports = { crearCatalogoV3 };
