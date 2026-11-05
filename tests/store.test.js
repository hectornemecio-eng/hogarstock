"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { crearAlmacenSeguridad } = require("../security/store.js");
const { crearServicioAcceso, crearHashContrasena } = require("../security/access.js");

const clavePrueba = "Clave de ensayos exclusivamente ficticia, 2026!";
const hashPrueba = crearHashContrasena(clavePrueba);

function clienteSqlite(base) {
  return {
    async execute(consulta) {
      const sql = typeof consulta === "string" ? consulta : consulta.sql;
      const args = typeof consulta === "string" ? [] : (consulta.args || []);
      const sentencia = base.prepare(sql);
      if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
        return { rows: sentencia.all(...args) };
      }
      const cambio = sentencia.run(...args);
      return { rows: [], rowsAffected: cambio.changes };
    },
  };
}

function archivoTemporal(t) {
  const carpeta = mkdtempSync(join(tmpdir(), "hogarstock-store-test-"));
  t.after(() => rmSync(carpeta, { recursive: true, force: true }));
  return join(carpeta, "autorizaciones.sqlite");
}

test("Crea tablas e indices de seguridad sin alterar productos", async (t) => {
  const archivo = archivoTemporal(t);
  const base = new DatabaseSync(archivo);
  t.after(() => base.close());
  base.exec("CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT);");
  base.exec("INSERT INTO productos VALUES (42, 'Intacto');");
  const almacen = crearAlmacenSeguridad(clienteSqlite(base));
  await almacen.init();
  const nombres = base.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.ok(nombres.some((x) => x.name === "hogarstock_admin_sessions_v3"));
  assert.ok(nombres.some((x) => x.name === "hogarstock_purchase_grants_v3"));
  assert.equal(base.prepare("SELECT nombre FROM productos WHERE id=42").get().nombre, "Intacto");
});

test("Sesiones administrativas persisten despues de reabrir SQLite y se revocan", async (t) => {
  const archivo = archivoTemporal(t);
  let instante = 1000000;
  const base1 = new DatabaseSync(archivo);
  const almacen1 = crearAlmacenSeguridad(clienteSqlite(base1));
  await almacen1.init();
  const auth1 = crearServicioAcceso({ almacen: almacen1, hashAdministrador: hashPrueba, reloj: () => instante });
  const sesion = await auth1.iniciarSesionAdmin({ contrasena: clavePrueba, ttlMs: 60000 });
  assert.ok(sesion.token);
  assert.equal(await auth1.autorizarAdmin({ token: sesion.token }), true);
  base1.close();

  const base2 = new DatabaseSync(archivo);
  t.after(() => base2.close());
  const almacen2 = crearAlmacenSeguridad(clienteSqlite(base2));
  await almacen2.init();
  const auth2 = crearServicioAcceso({ almacen: almacen2, hashAdministrador: hashPrueba, reloj: () => instante });
  assert.equal(await auth2.autorizarAdmin({ token: sesion.token }), true);
  await auth2.cerrarSesionAdmin({ token: sesion.token });
  assert.equal(await auth2.autorizarAdmin({ token: sesion.token }), false);
  assert.equal(
    base2.prepare("SELECT COUNT(*) AS n FROM hogarstock_admin_sessions_v3 WHERE huella=?")
      .get(sesion.token).n,
    0,
    "La base no debe guardar tokens sin hash"
  );
});

test("Permisos por compra persisten, no cruzan ambitos y caducan", async (t) => {
  const archivo = archivoTemporal(t);
  let instante = 2000000;
  const base1 = new DatabaseSync(archivo);
  const almacen1 = crearAlmacenSeguridad(clienteSqlite(base1));
  await almacen1.init();
  const auth1 = crearServicioAcceso({ almacen: almacen1, hashAdministrador: hashPrueba, reloj: () => instante });
  const invitacion = await auth1.emitirPermisoCompra({ compraId: 10, ttlMs: 60000 });
  base1.close();

  const base2 = new DatabaseSync(archivo);
  t.after(() => base2.close());
  const almacen2 = crearAlmacenSeguridad(clienteSqlite(base2));
  await almacen2.init();
  const auth2 = crearServicioAcceso({ almacen: almacen2, hashAdministrador: hashPrueba, reloj: () => instante });
  assert.equal(await auth2.autorizarCompra({ compraId: 10, token: invitacion.token }), true);
  assert.equal(await auth2.autorizarCompra({ compraId: 11, token: invitacion.token }), false);
  assert.equal(await auth2.autorizarAdmin({ token: invitacion.token }), false);
  instante += 60000;
  assert.equal(await auth2.autorizarCompra({ compraId: 10, token: invitacion.token }), false);
});

test("La revocacion de permisos de compra es persistente", async (t) => {
  const archivo = archivoTemporal(t);
  const base = new DatabaseSync(archivo);
  t.after(() => base.close());
  const almacen = crearAlmacenSeguridad(clienteSqlite(base));
  await almacen.init();
  const auth = crearServicioAcceso({ almacen, hashAdministrador: hashPrueba, reloj: () => 2500000 });
  const invitacion = await auth.emitirPermisoCompra({ compraId: 5, ttlMs: 60000 });
  assert.equal(await auth.autorizarCompra({ compraId: 5, token: invitacion.token }), true);
  await auth.revocarPermisoCompra({ token: invitacion.token });
  assert.equal(await auth.autorizarCompra({ compraId: 5, token: invitacion.token }), false);
});

test("Esquema incompatible: no borra datos existentes", async (t) => {
  const archivo = archivoTemporal(t);
  const base = new DatabaseSync(archivo);
  t.after(() => base.close());
  base.exec("CREATE TABLE hogarstock_admin_sessions_v3 (huella TEXT PRIMARY KEY, columna_vieja TEXT);");
  base.exec("INSERT INTO hogarstock_admin_sessions_v3 VALUES ('registro-protegido','conservar');");
  const almacen = crearAlmacenSeguridad(clienteSqlite(base));
  await assert.rejects(almacen.init(), /ESQUEMA_SEGURIDAD_INCOMPATIBLE/);
  assert.equal(
    base.prepare("SELECT columna_vieja FROM hogarstock_admin_sessions_v3 WHERE huella='registro-protegido'")
      .get().columna_vieja,
    "conservar"
  );
  assert.equal(
    base.prepare("SELECT COUNT(*) AS n FROM hogarstock_admin_sessions_v3").get().n,
    1
  );
});

test("No permite utilizar el almacen sin inicializar ni guarda entradas invalidas", async (t) => {
  const archivo = archivoTemporal(t);
  const base = new DatabaseSync(archivo);
  t.after(() => base.close());
  const almacen = crearAlmacenSeguridad(clienteSqlite(base));
  await assert.rejects(
    almacen.guardarSesionAdmin({ huella: "a".repeat(64), creado: 1, expira: 2 }),
    /ALMACEN_NO_INICIALIZADO/
  );
  await almacen.init();
  await assert.rejects(
    almacen.guardarSesionAdmin({ huella: "invalida", creado: 1, expira: 2 }),
    /Huella/
  );
  await assert.rejects(
    almacen.guardarPermisoCompra({
      huella: "b".repeat(64), compraId: "../123", creado: 1, expira: 2
    }),
    /ID de compra invalido/
  );
});
