"use strict";

// Pruebas HTTP + Express + @libsql/client REAL, con SQLite local y sin secretos.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createClient } = require("@libsql/client");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { crearRouterV3 } = require("../api/v3-router.js");
const { crearAlmacenCompras } = require("../compras/store.js");
const { crearAlmacenSeguridad } = require("../security/store.js");
const { crearConciliadorCompras } = require("../compras/conciliacion.js");
const { crearServicioAcceso, crearHashContrasena } = require("../security/access.js");

const ORIGEN = "http://127.0.0.1";
const CLAVE = "Clave ficticia exclusiva de pruebas V3, no usar en produccion!";

async function escenario(t) {
  const carpeta = mkdtempSync(join(tmpdir(), "hs-v3-http-"));
  const cliente = createClient({ url: "file:" + join(carpeta, "pruebas.sqlite") });
  await cliente.batch([
    "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "nombre TEXT NOT NULL, categoria TEXT NOT NULL, agotado INTEGER DEFAULT 0)",
    "INSERT INTO productos(id,nombre,categoria,agotado) VALUES " +
      "(1,'Leche','Lacteos',1),(2,'Huevos','Lacteos',1),(3,'Arroz','Despensa',0)",
  ], "write");

  const compras = crearAlmacenCompras(cliente, { reloj: () => 1000000 });
  const almacen = crearAlmacenSeguridad(cliente);
  await compras.init();
  await almacen.init();
  let instante = 1000000;
  const acceso = crearServicioAcceso({
    almacen, hashAdministrador: crearHashContrasena(CLAVE), reloj: () => instante,
  });
  const conciliador = crearConciliadorCompras(cliente);
  const aplicacion = express();
  aplicacion.use("/api/v3", crearRouterV3({
    acceso, compras, conciliador, origen: ORIGEN, reloj: () => instante,
  }));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = aplicacion.listen(0, "127.0.0.1", () => resolve(instancia));
    instancia.on("error", reject);
  });
  t.after(async () => {
    await new Promise((resolve) => servidor.close(resolve));
    cliente.close();
    rmSync(carpeta, { recursive: true, force: true });
  });
  const BASE = "http://127.0.0.1:" + servidor.address().port + "/api/v3";
  async function solicitar(path, { method = "GET", cookie, token, body, origin = ORIGEN } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (token) headers.authorization = "Bearer " + token;
    if (method !== "GET") headers.origin = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const respuesta = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const datos = await respuesta.json();
    return { status: respuesta.status, datos, cookie: respuesta.headers.get("set-cookie"),
      headers: respuesta.headers };
  }
  async function iniciarAdmin() {
    const login = await solicitar("/auth/login", {
      method: "POST", body: { contrasena: CLAVE },
    });
    assert.equal(login.status, 200, JSON.stringify(login.datos));
    return login.cookie.split(";")[0];
  }
  async function crearCompra(cookie, ids) {
    const respuesta = await solicitar("/admin/compras", {
      method: "POST", cookie,
      body: { lineas: ids.map((productoId) => ({ productoId })) },
    });
    assert.equal(respuesta.status, 201, JSON.stringify(respuesta.datos));
    return respuesta.datos.compra.compraId;
  }
  async function invitar(cookie, compraId) {
    const respuesta = await solicitar("/admin/compras/" + compraId + "/invitaciones", {
      method: "POST", cookie, body: {},
    });
    assert.equal(respuesta.status, 201, JSON.stringify(respuesta.datos));
    return respuesta.datos.invitacion.token;
  }
  return { solicitar, iniciarAdmin, crearCompra, invitar, acceso, cliente,
    avanzar: (ms) => { instante += ms; } };
}

test("Visitante: rutas administrativas y de compra protegidas", async (t) => {
  const e = await escenario(t);
  assert.equal((await e.solicitar("/admin/sesion")).status, 401);
  assert.equal((await e.solicitar("/admin/compras", {
    method: "POST", body: { lineas: [{ productoId: 1 }] },
  })).status, 401);
  assert.equal((await e.solicitar("/compras/1")).status, 403);
  assert.equal((await e.solicitar("/compras/1/items/1", {
    method: "PATCH", body: { estado: "comprado", revisionEsperada: 0 },
  })).status, 403);
  assert.equal(Number((await e.cliente.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_compras_v3"
  )).rows[0].n), 0);
});

test("Administrador: login, cookie segura y cierre revocable", async (t) => {
  const e = await escenario(t);
  const respuesta = await e.solicitar("/auth/login", {
    method: "POST", body: { contrasena: CLAVE },
  });
  assert.equal(respuesta.status, 200);
  assert.match(respuesta.cookie, /HttpOnly/);
  assert.match(respuesta.cookie, /Secure/);
  assert.match(respuesta.cookie, /SameSite=Strict/);
  assert.match(respuesta.cookie, /Path=\/api\/v3/);
  const cookie = respuesta.cookie.split(";")[0];
  assert.equal((await e.solicitar("/admin/sesion", { cookie })).status, 200);
  assert.equal((await e.solicitar("/auth/logout", {
    method: "POST", cookie, body: {},
  })).status, 200);
  assert.equal((await e.solicitar("/admin/sesion", { cookie })).status, 401);
});

test("Comprador A no lee, marca ni finaliza compra B", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const a = await e.crearCompra(cookie, [1]);
  const b = await e.crearCompra(cookie, [2]);
  const tokenA = await e.invitar(cookie, a);
  const tokenB = await e.invitar(cookie, b);
  const compraB = await e.solicitar("/compras/" + b, { token: tokenB });
  assert.equal(compraB.status, 200);
  const itemB = compraB.datos.compra.items[0];
  assert.equal((await e.solicitar("/compras/" + b, { token: tokenA })).status, 403);
  assert.equal((await e.solicitar("/compras/" + b + "/items/" + itemB.id, {
    method: "PATCH", token: tokenA,
    body: { estado: "comprado", revisionEsperada: 0 },
  })).status, 403);
  assert.equal((await e.solicitar("/compras/" + b + "/finalizar", {
    method: "POST", token: tokenA, body: {},
  })).status, 403);
  const despues = await e.solicitar("/compras/" + b, { token: tokenB });
  assert.equal(despues.datos.compra.items[0].estado, "pendiente");
  assert.equal(despues.datos.compra.estado, "abierta");
});

test("Comprador: marcar, conflicto 409, deshacer y cierre idempotente", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const compraId = await e.crearCompra(cookie, [1, 2]);
  const token = await e.invitar(cookie, compraId);
  const inicial = (await e.solicitar("/compras/" + compraId, { token })).datos.compra;
  const item = inicial.items[0];
  const ruta = "/compras/" + compraId + "/items/" + item.id;
  assert.equal((await e.solicitar(ruta, {
    method: "PATCH", token, body: { estado: "comprado", revisionEsperada: 0 },
  })).status, 200);
  const conflicto = await e.solicitar(ruta, {
    method: "PATCH", token, body: { estado: "no_disponible", revisionEsperada: 0 },
  });
  assert.equal(conflicto.status, 409);
  assert.equal(conflicto.datos.error, "CONFLICTO_VERSION");
  const deshacer = await e.solicitar(ruta, {
    method: "PATCH", token, body: { estado: "pendiente", revisionEsperada: 1 },
  });
  assert.equal(deshacer.status, 200);
  assert.equal(deshacer.datos.resultado.revision, 2);
  const final = await e.solicitar("/compras/" + compraId + "/finalizar", {
    method: "POST", token, body: {},
  });
  assert.equal(final.status, 200);
  assert.equal(final.datos.resultado.yaFinalizada, false);
  const segundo = await e.solicitar("/compras/" + compraId + "/finalizar", {
    method: "POST", token, body: {},
  });
  assert.equal(segundo.status, 200);
  assert.equal(segundo.datos.resultado.yaFinalizada, true);
  const cerrada = await e.solicitar(ruta, {
    method: "PATCH", token, body: { estado: "comprado", revisionEsperada: 2 },
  });
  assert.equal(cerrada.status, 409);
  assert.equal(cerrada.datos.error, "COMPRA_CERRADA");
});

test("Item de otra compra no puede modificarse con token de compra A", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const a = await e.crearCompra(cookie, [1]);
  const b = await e.crearCompra(cookie, [2]);
  const tokenA = await e.invitar(cookie, a);
  const tokenB = await e.invitar(cookie, b);
  const itemB = (await e.solicitar("/compras/" + b, { token: tokenB }))
    .datos.compra.items[0];
  const cambio = await e.solicitar("/compras/" + a + "/items/" + itemB.id, {
    method: "PATCH", token: tokenA,
    body: { estado: "comprado", revisionEsperada: 0 },
  });
  assert.equal(cambio.status, 404);
  assert.equal((await e.solicitar("/compras/" + b, { token: tokenB }))
    .datos.compra.items[0].estado, "pendiente");
});

test("Invitacion revocada o caducada pierde acceso", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const compraId = await e.crearCompra(cookie, [1]);
  const token = await e.invitar(cookie, compraId);
  assert.equal((await e.solicitar("/compras/" + compraId, { token })).status, 200);
  await e.acceso.revocarPermisoCompra({ token });
  assert.equal((await e.solicitar("/compras/" + compraId, { token })).status, 403);
  const otro = await e.invitar(cookie, compraId);
  e.avanzar(24 * 60 * 60 * 1000);
  assert.equal((await e.solicitar("/compras/" + compraId, { token: otro })).status, 403);
});

test("Admin: conciliacion solo tras finalizar y sin alterar catalogo", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const compraId = await e.crearCompra(cookie, [1]);
  const token = await e.invitar(cookie, compraId);
  const informeAntes = await e.solicitar("/admin/compras/" + compraId + "/conciliacion", { cookie });
  assert.equal(informeAntes.status, 409);
  assert.equal((await e.solicitar("/compras/" + compraId + "/finalizar", {
    method: "POST", token, body: {},
  })).status, 200);
  const informe = await e.solicitar("/admin/compras/" + compraId + "/conciliacion", { cookie });
  assert.equal(informe.status, 200);
  assert.equal(informe.datos.informe.soloLectura, true);
  assert.equal(Number((await e.cliente.execute(
    "SELECT agotado FROM productos WHERE id=1"
  )).rows[0].agotado), 1);
});

test("Origen ajeno y JSON invalido se rechazan sin alterar la base", async (t) => {
  const e = await escenario(t);
  const cookie = await e.iniciarAdmin();
  const extranjero = await e.solicitar("/admin/compras", {
    method: "POST", cookie, origin: "https://evil.example",
    body: { lineas: [{ productoId: 1 }] },
  });
  assert.equal(extranjero.status, 403);
  const sinOrigen = await e.solicitar("/admin/compras", {
    method: "POST", cookie, origin: "",
    body: { lineas: [{ productoId: 1 }] },
  });
  assert.equal(sinOrigen.status, 403);
  const mal = await e.solicitar("/admin/compras", {
    method: "POST", cookie, body: { lineas: [] },
  });
  assert.equal(mal.status, 400);
  assert.equal(Number((await e.cliente.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_compras_v3"
  )).rows[0].n), 0);
});

test("Rate limit local: 5 contrasenas falsas activan 429", async (t) => {
  const e = await escenario(t);
  for (let intento = 0; intento < 5; intento++) {
    const r = await e.solicitar("/auth/login", {
      method: "POST", body: { contrasena: "falsa" },
    });
    assert.equal(r.status, 401);
  }
  const bloqueo = await e.solicitar("/auth/login", {
    method: "POST", body: { contrasena: CLAVE },
  });
  assert.equal(bloqueo.status, 429);
  assert.ok(bloqueo.headers.get("retry-after"));
});
