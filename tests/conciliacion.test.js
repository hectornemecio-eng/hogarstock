"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { crearConciliadorCompras } = require("../compras/conciliacion.js");

function escenario(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT, agotado INTEGER);" +
    "CREATE TABLE hogarstock_compras_v3 (id INTEGER PRIMARY KEY, estado TEXT);" +
    "CREATE TABLE hogarstock_compra_items_v3 (" +
      "id INTEGER PRIMARY KEY, compra_id INTEGER, producto_id INTEGER," +
      "nombre TEXT, estado TEXT);" +
    "INSERT INTO productos VALUES (1,'Leche',1),(2,'Huevos',1),(3,'Arroz',0);" +
    "INSERT INTO hogarstock_compras_v3 VALUES (100,'finalizada'),(200,'abierta');" +
    "INSERT INTO hogarstock_compra_items_v3 VALUES " +
      "(1,100,1,'Leche','comprado')," +
      "(2,100,2,'Huevos','comprado')," +
      "(3,100,3,'Arroz','comprado')," +
      "(4,100,4,'Producto eliminado','comprado')," +
      "(5,100,5,'Pan','pendiente')," +
      "(6,200,2,'Huevos','pendiente');" +
    "INSERT INTO productos VALUES (5,'Pan',1);"
  );
  const consultas = [];
  const cliente = {
    async execute(consulta) {
      const sql = typeof consulta === "string" ? consulta : consulta.sql;
      consultas.push(sql);
      assert.match(sql, /^\s*SELECT\b/i, "Solo se permiten consultas SELECT");
      return { rows: db.prepare(sql).all(...(consulta.args || [])) };
    },
  };
  return { db, consultas, conciliacion: crearConciliadorCompras(cliente) };
}

test("Informe de compra finalizada clasifica sin actualizar inventario", async (t) => {
  const e = escenario(t);
  const antes = e.db.prepare("SELECT id,nombre,agotado FROM productos ORDER BY id").all();
  const informe = await e.conciliacion.informeCompraFinalizada({ compraId: 100 });
  const porId = new Map(informe.lineas.map((x) => [x.productoId, x]));
  assert.equal(informe.soloLectura, true);
  assert.equal(informe.aplicacionAutomatica, false);
  assert.equal(informe.lineas.length, 5);
  assert.equal(porId.get(1).codigo, "REVISION_ADMINISTRADOR");
  assert.equal(porId.get(2).codigo, "COMPRA_ABIERTA_COMPARTIDA");
  assert.equal(porId.get(3).codigo, "YA_NO_AGOTADO");
  assert.equal(porId.get(4).codigo, "PRODUCTO_NO_EXISTE");
  assert.equal(porId.get(5).codigo, "NO_COMPRADO");
  assert.deepEqual(
    e.db.prepare("SELECT id,nombre,agotado FROM productos ORDER BY id").all(),
    antes
  );
  assert.ok(e.consultas.every((sql) => /^\s*SELECT\b/i.test(sql)));
});

test("No ofrece conciliacion para compras que siguen abiertas", async (t) => {
  const e = escenario(t);
  await assert.rejects(
    e.conciliacion.informeCompraFinalizada({ compraId: 200 }),
    /COMPRA_NO_FINALIZADA/
  );
});

test("Rechaza IDs invalidos y compras inexistentes", async (t) => {
  const e = escenario(t);
  await assert.rejects(
    e.conciliacion.informeCompraFinalizada({ compraId: 0 }),
    /compraId invalido/
  );
  await assert.rejects(
    e.conciliacion.informeCompraFinalizada({ compraId: 999 }),
    /COMPRA_NO_ENCONTRADA_O_SIN_ITEMS/
  );
});

test("Una compra simultanea que termina deja de bloquear el informe", async (t) => {
  const e = escenario(t);
  const antes = await e.conciliacion.informeCompraFinalizada({ compraId: 100 });
  assert.equal(antes.lineas.find((x) => x.productoId === 2).codigo, "COMPRA_ABIERTA_COMPARTIDA");
  e.db.exec("UPDATE hogarstock_compras_v3 SET estado='finalizada' WHERE id=200");
  const despues = await e.conciliacion.informeCompraFinalizada({ compraId: 100 });
  assert.equal(despues.lineas.find((x) => x.productoId === 2).codigo, "REVISION_ADMINISTRADOR");
  assert.equal(e.db.prepare("SELECT agotado FROM productos WHERE id=2").get().agotado, 1);
});
