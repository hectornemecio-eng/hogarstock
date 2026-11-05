"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearHttpPrototipo } = require("../security/http-prototype.js");
const { crearHashContrasena, crearServicioAcceso } = require("../security/access.js");

const contrasena = "Contrasena ficticia de pruebas HTTP 2026!";
const origen = "http://127.0.0.1";

function almacenEnMemoria() {
  const admins = new Map();
  const invitados = new Map();
  return {
    guardarSesionAdmin: async (x) => { admins.set(x.huella, { ...x }); },
    leerSesionAdmin: async ({ huella }) => admins.get(huella) ?? null,
    revocarSesionAdmin: async ({ huella, revocado }) => {
      const registro = admins.get(huella);
      if (registro) registro.revocado = revocado;
    },
    guardarPermisoCompra: async (x) => { invitados.set(x.huella, { ...x }); },
    leerPermisoCompra: async ({ huella }) => invitados.get(huella) ?? null,
    revocarPermisoCompra: async ({ huella, revocado }) => {
      const registro = invitados.get(huella);
      if (registro) registro.revocado = revocado;
    },
  };
}

async function entornoHTTP(t) {
  const acceso = crearServicioAcceso({
    almacen: almacenEnMemoria(),
    hashAdministrador: crearHashContrasena(contrasena),
  });
  const compras = new Map([
    ["1", { id: 1, producto: "Leche ficticia" }],
    ["2", { id: 2, producto: "Pan ficticio" }],
  ]);
  const servidor = crearHttpPrototipo({ acceso, origen, compras });
  await new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  const url = "http://127.0.0.1:" + servidor.address().port;
  const solicitar = async (ruta, opciones = {}) => {
    const resultado = await fetch(url + ruta, opciones);
    const datos = await resultado.json();
    return { status: resultado.status, headers: resultado.headers, datos };
  };
  return { solicitar, acceso };
}

test("Visitantes no pueden consultar el QR ficticio", async (t) => {
  const { solicitar } = await entornoHTTP(t);
  const sinSesion = await solicitar("/demo/qr");
  assert.equal(sinSesion.status, 401);
  assert.equal(Object.hasOwn(sinSesion.datos, "qr"), false);
});

test("Login administrativo: cookie HttpOnly y rechazo de contrasena incorrecta", async (t) => {
  const { solicitar } = await entornoHTTP(t);
  const malo = await solicitar("/demo/login", {
    method: "POST",
    headers: { origin: origen, "content-type": "application/json" },
    body: JSON.stringify({ contrasena: "incorrecta" }),
  });
  assert.equal(malo.status, 401);
  const login = await solicitar("/demo/login", {
    method: "POST",
    headers: { origin: origen, "content-type": "application/json" },
    body: JSON.stringify({ contrasena }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const cabeceraCookie = cookie.split(";")[0];
  const qr = await solicitar("/demo/qr", { headers: { cookie: cabeceraCookie } });
  assert.equal(qr.status, 200);
  assert.equal(qr.datos.qr, "QR_FICTICIO_NO_VINCULABLE");
});

test("POST de origen distinto o sin Origin no permite iniciar sesion", async (t) => {
  const { solicitar } = await entornoHTTP(t);
  for (const origin of ["https://otro.example", ""]) {
    const respuesta = await solicitar("/demo/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ contrasena }),
    });
    assert.equal(respuesta.status, 403);
  }
});

test("Los invitados consultan solo la compra autorizada", async (t) => {
  const { solicitar, acceso } = await entornoHTTP(t);
  const token = (await acceso.emitirPermisoCompra({ compraId: 1, ttlMs: 60000 })).token;
  const cabecera = { authorization: "Bearer " + token };
  const compraA = await solicitar("/demo/compras/1", { headers: cabecera });
  assert.equal(compraA.status, 200);
  assert.equal(compraA.datos.compra.producto, "Leche ficticia");
  const compraB = await solicitar("/demo/compras/2", { headers: cabecera });
  assert.equal(compraB.status, 403);
  const sinToken = await solicitar("/demo/compras/1");
  assert.equal(sinToken.status, 403);
  const qr = await solicitar("/demo/qr", { headers: cabecera });
  assert.equal(qr.status, 401);
});

test("Un permiso revocado ya no autoriza consultas HTTP", async (t) => {
  const { solicitar, acceso } = await entornoHTTP(t);
  const invitacion = await acceso.emitirPermisoCompra({ compraId: 2, ttlMs: 60000 });
  const cabecera = { authorization: "Bearer " + invitacion.token };
  assert.equal((await solicitar("/demo/compras/2", { headers: cabecera })).status, 200);
  await acceso.revocarPermisoCompra({ token: invitacion.token });
  assert.equal((await solicitar("/demo/compras/2", { headers: cabecera })).status, 403);
});
