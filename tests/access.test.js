"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  crearHashContrasena,
  verificarContrasena,
  huellaToken,
  crearServicioAcceso,
} = require("../security/access.js");

function almacenFalso() {
  const admins = new Map(), compras = new Map();
  return {
    async guardarSesionAdmin(x) { admins.set(x.huella, {...x}); },
    async leerSesionAdmin({huella}) { return admins.get(huella) ?? null; },
    async revocarSesionAdmin({huella,revocado}) {
      if (admins.has(huella)) admins.get(huella).revocado = revocado;
    },
    async guardarPermisoCompra(x) { compras.set(x.huella,{...x}); },
    async leerPermisoCompra({huella}) { return compras.get(huella) ?? null; },
    async revocarPermisoCompra({huella,revocado}) {
      if (compras.has(huella)) compras.get(huella).revocado = revocado;
    },
    admins, compras,
  };
}

const clave = "Clave de pruebas nunca usar en produccion 2026!";
const hash = crearHashContrasena(clave);

test("Contrasenas: scrypt con sal y comparacion exacta", () => {
  const segundo = crearHashContrasena(clave);
  assert.notEqual(hash, segundo);
  assert.equal(verificarContrasena(clave, hash), true);
  assert.equal(verificarContrasena("clave erronea", hash), false);
  assert.equal(verificarContrasena(clave, "hash invalido"), false);
  assert.throws(() => crearHashContrasena("demasiado corta"), /al menos 12/);
});

test("Sin hash administrador valido: no inicia el servicio", () => {
  assert.throws(
    () => crearServicioAcceso({almacen:almacenFalso(),hashAdministrador:""}),
    /ausente o invalido/
  );
});

test("Sesion administrativa: acceso, rechazo, caducidad y cierre", async () => {
  let now = 100000;
  const almacen = almacenFalso();
  const auth = crearServicioAcceso({almacen,hashAdministrador:hash,reloj:()=>now});
  assert.equal(await auth.iniciarSesionAdmin({contrasena:"incorrecta",ttlMs:60000}),null);
  const sesion = await auth.iniciarSesionAdmin({contrasena:clave,ttlMs:60000});
  assert.ok(sesion.token);
  assert.equal(sesion.token.length,43);
  assert.equal(await auth.autorizarAdmin({token:sesion.token}),true);
  assert.equal(await auth.autorizarAdmin({token:"token invalido"}),false);
  assert.equal(await auth.autorizarAdmin({token:sesion.token+"x"}),false);
  assert.equal(JSON.stringify([...almacen.admins.values()]).includes(sesion.token),false);
  now += 59999;
  assert.equal(await auth.autorizarAdmin({token:sesion.token}),true);
  now += 1;
  assert.equal(await auth.autorizarAdmin({token:sesion.token}),false);
  const segunda = await auth.iniciarSesionAdmin({contrasena:clave,ttlMs:60000});
  assert.equal(await auth.autorizarAdmin({token:segunda.token}),true);
  assert.equal(await auth.cerrarSesionAdmin({token:segunda.token}),true);
  assert.equal(await auth.autorizarAdmin({token:segunda.token}),false);
});

test("Autorizacion por compra: aislamiento A/B, vencimiento y revocacion", async () => {
  let now = 200000;
  const almacen = almacenFalso();
  const auth = crearServicioAcceso({almacen,hashAdministrador:hash,reloj:()=>now});
  const a = await auth.emitirPermisoCompra({compraId:1,ttlMs:60000});
  const b = await auth.emitirPermisoCompra({compraId:2,ttlMs:120000});
  assert.equal(await auth.autorizarCompra({compraId:1,token:a.token}),true);
  assert.equal(await auth.autorizarCompra({compraId:2,token:a.token}),false);
  assert.equal(await auth.autorizarCompra({compraId:1,token:b.token}),false);
  assert.equal(await auth.autorizarCompra({compraId:2,token:b.token}),true);
  assert.equal(await auth.autorizarCompra({compraId:0,token:a.token}),false);
  assert.equal(await auth.autorizarAdmin({token:a.token}),false);
  assert.equal(JSON.stringify([...almacen.compras.values()]).includes(a.token),false);
  now += 60000;
  assert.equal(await auth.autorizarCompra({compraId:1,token:a.token}),false);
  assert.equal(await auth.autorizarCompra({compraId:2,token:b.token}),true);
  await auth.revocarPermisoCompra({token:b.token});
  assert.equal(await auth.autorizarCompra({compraId:2,token:b.token}),false);
});

test("Entradas no validas: rechazo de ID y duracion", async () => {
  const auth = crearServicioAcceso({almacen:almacenFalso(),hashAdministrador:hash});
  await assert.rejects(() => auth.emitirPermisoCompra({compraId:"../1",ttlMs:60000}), /Identificador/);
  await assert.rejects(() => auth.emitirPermisoCompra({compraId:1,ttlMs:0}), /Duracion/);
  await assert.rejects(() => auth.iniciarSesionAdmin({contrasena:clave,ttlMs:31*24*3600*1000}),/Duracion/);
  assert.equal(await auth.autorizarCompra({compraId:"not-a-number",token:"x"}),false);
  assert.equal(huellaToken("no-valido"),null);
});

test("Fallo del almacenamiento: no se expide un token reutilizable", async () => {
  const almacen=almacenFalso();
  almacen.guardarSesionAdmin=async()=>{throw Error("fallo intencionado");};
  const auth=crearServicioAcceso({almacen,hashAdministrador:hash});
  await assert.rejects(
    () => auth.iniciarSesionAdmin({contrasena:clave,ttlMs:60000}),
    /fallo intencionado/
  );
});
