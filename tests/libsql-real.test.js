"use strict";

// Pruebas de integracion con @libsql/client REAL y SQLite LOCAL.
// No utilizan TURSO_DATABASE_URL, TURSO_AUTH_TOKEN ni otros secretos.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createClient } = require("@libsql/client");

const { crearAlmacenCompras } = require("../compras/store.js");
const { crearAlmacenSeguridad } = require("../security/store.js");
const {
  crearServicioAcceso,
  crearHashContrasena,
} = require("../security/access.js");

async function preparar(t) {
  const carpeta = mkdtempSync(join(tmpdir(), "hogarstock-libsql-real-"));
  const ruta = join(carpeta, "pruebas.sqlite");
  const abiertos = new Set();

  function abrir() {
    const cliente = createClient({ url: "file:" + ruta });
    abiertos.add(cliente);
    return cliente;
  }

  async function cerrar(cliente) {
    if (abiertos.has(cliente)) {
      await cliente.close();
      abiertos.delete(cliente);
    }
  }

  t.after(async () => {
    for (const cliente of abiertos) await cliente.close();
    rmSync(carpeta, { recursive: true, force: true });
  });

  const principal = abrir();
  await principal.batch([
    "CREATE TABLE productos (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
    {
      sql: "INSERT INTO productos(id,nombre,categoria,agotado) VALUES" +
        "(1,'Leche','Lacteos',1)," +
        "(2,'Huevos','Lacteos',1)," +
        "(3,'Arroz','Despensa',0)",
      args: [],
    },
  ], "write");

  return { abrir, cerrar, principal };
}

function obtenerTotal(resultado) {
  return Number(resultado.rows[0].n);
}

test("libSQL real: crear compra persiste al cerrar y reabrir el cliente", async (t) => {
  const e = await preparar(t);
  const compras = crearAlmacenCompras(e.principal, { reloj: () => 1234567 });
  await compras.init();
  const creada = await compras.crearCompra({
    lineas: [
      { productoId: 1, cantidad: 2, unidad: "litros" },
      { productoId: 2 },
    ],
  });
  assert.equal(creada.cantidad, 2);
  const primera = await compras.obtenerCompra({ compraId: creada.compraId });
  assert.equal(primera.items.length, 2);
  assert.equal(primera.items[0].nombre, "Leche");
  assert.equal(primera.items[0].cantidad, 2);

  await e.cerrar(e.principal);
  const nuevaConexion = e.abrir();
  const comprasNueva = crearAlmacenCompras(nuevaConexion);
  await comprasNueva.init();
  const recuperada = await comprasNueva.obtenerCompra({ compraId: creada.compraId });
  assert.equal(recuperada.items.length, 2);
  assert.equal(recuperada.estado, "abierta");
  assert.equal(recuperada.items[0].nombre, "Leche");
  assert.equal(recuperada.items[0].unidad, "litros");
});

test("libSQL real: rollback completo si un producto no esta disponible", async (t) => {
  const e = await preparar(t);
  const compras = crearAlmacenCompras(e.principal);
  await compras.init();

  await assert.rejects(
    compras.crearCompra({ lineas: [{ productoId: 1 }, { productoId: 3 }] }),
    /PRODUCTO_NO_MARCADO_COMO_FALTANTE/
  );

  assert.equal(obtenerTotal(await e.principal.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_compras_v3"
  )), 0);
  assert.equal(obtenerTotal(await e.principal.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_compra_items_v3"
  )), 0);
});

test("libSQL real: revisiones entre dos clientes y cierre idempotente", async (t) => {
  const e = await preparar(t);
  const segundo = e.abrir();
  const a = crearAlmacenCompras(e.principal);
  const b = crearAlmacenCompras(segundo);
  await a.init();
  await b.init();

  const creada = await a.crearCompra({ lineas: [{ productoId: 1 }] });
  const linea = (await a.obtenerCompra({ compraId: creada.compraId })).items[0];

  const cambio = await a.cambiarEstadoItem({
    compraId: creada.compraId,
    itemId: linea.id,
    estado: "comprado",
    revisionEsperada: 0,
  });
  assert.equal(cambio.revision, 1);

  await assert.rejects(
    b.cambiarEstadoItem({
      compraId: creada.compraId,
      itemId: linea.id,
      estado: "no_disponible",
      revisionEsperada: 0,
    }),
    /CONFLICTO_VERSION/
  );

  const cierre = await b.finalizarCompra({ compraId: creada.compraId });
  assert.equal(cierre.yaFinalizada, false);
  const repetido = await a.finalizarCompra({ compraId: creada.compraId });
  assert.equal(repetido.yaFinalizada, true);
  assert.equal(repetido.finalizada, cierre.finalizada);

  const resultado = await a.obtenerCompra({ compraId: creada.compraId });
  assert.equal(resultado.items[0].estado, "comprado");
  assert.equal(resultado.estado, "finalizada");
  assert.equal(Number((await a.obtenerCompra({ compraId: creada.compraId })).resumen.comprados), 1);
});

test("libSQL real: sesiones y permisos sobreviven al reinicio y se revocan", async (t) => {
  const e = await preparar(t);
  let ahora = 9000000;
  const contrasena = "Contrasena ficticia exclusivamente para pruebas!";
  const hashAdministrador = crearHashContrasena(contrasena);
  const almacen = crearAlmacenSeguridad(e.principal);
  await almacen.init();
  const auth = crearServicioAcceso({
    almacen, hashAdministrador, reloj: () => ahora,
  });
  const sesion = await auth.iniciarSesionAdmin({
    contrasena, ttlMs: 60000,
  });
  const permiso = await auth.emitirPermisoCompra({
    compraId: 1, ttlMs: 60000,
  });
  assert.equal(await auth.autorizarAdmin({ token: sesion.token }), true);

  await e.cerrar(e.principal);
  const segundo = e.abrir();
  const almacen2 = crearAlmacenSeguridad(segundo);
  await almacen2.init();
  const auth2 = crearServicioAcceso({
    almacen: almacen2, hashAdministrador, reloj: () => ahora,
  });
  assert.equal(await auth2.autorizarAdmin({ token: sesion.token }), true);
  assert.equal(await auth2.autorizarCompra({ compraId: 1, token: permiso.token }), true);
  assert.equal(await auth2.autorizarCompra({ compraId: 2, token: permiso.token }), false);

  await auth2.cerrarSesionAdmin({ token: sesion.token });
  await auth2.revocarPermisoCompra({ token: permiso.token });
  assert.equal(await auth2.autorizarAdmin({ token: sesion.token }), false);
  assert.equal(await auth2.autorizarCompra({ compraId: 1, token: permiso.token }), false);
  ahora += 60000;
  assert.equal(await auth2.autorizarCompra({ compraId: 1, token: permiso.token }), false);
});

test("libSQL real: compras simultaneas con el mismo producto siguen aisladas", async (t) => {
  const e = await preparar(t);
  const a = crearAlmacenCompras(e.principal);
  await a.init();
  const b = crearAlmacenCompras(e.abrir());
  await b.init();

  // La creacion secuencial permite medir que el aislamiento no depende
  // de que la otra compra este ya finalizada.
  const x = await a.crearCompra({ lineas: [{ productoId: 1 }] });
  const y = await b.crearCompra({ lineas: [{ productoId: 1 }] });

  const ix = (await a.obtenerCompra({ compraId: x.compraId })).items[0];
  await a.cambiarEstadoItem({
    compraId: x.compraId,
    itemId: ix.id,
    estado: "comprado",
    revisionEsperada: 0,
  });
  assert.equal((await a.obtenerCompra({ compraId: x.compraId })).items[0].estado, "comprado");
  assert.equal((await b.obtenerCompra({ compraId: y.compraId })).items[0].estado, "pendiente");

  const global = await e.principal.execute(
    "SELECT agotado FROM productos WHERE id=1"
  );
  assert.equal(Number(global.rows[0].agotado), 1);
});
