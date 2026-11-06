"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createClient } = require("@libsql/client");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { crearAlmacenCompras } = require("../compras/store.js");
const { crearAlmacenSeguridad } = require("../security/store.js");
const { crearSesionesComprador } = require("../security/buyer-sessions.js");
const { crearServicioAcceso, crearHashContrasena } = require("../security/access.js");
const { crearConciliadorCompras } = require("../compras/conciliacion.js");
const { crearRouterV3 } = require("../api/v3-router.js");

const CLAVE = "Credencial exclusivamente ficticia para ensayos V3!";
const ORIGEN = "http://127.0.0.1";

async function preparar(t) {
  const carpeta = mkdtempSync(join(tmpdir(), "hogarstock-sesion-compra-"));
  const cliente = createClient({ url: "file:" + join(carpeta, "test.sqlite") });
  t.after(async () => { await cliente.close(); rmSync(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await cliente.batch([
    "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
    "INSERT INTO productos(id,nombre,categoria,agotado) VALUES (1,'Leche','Lacteos',1),(2,'Pan','Panaderia',1)",
  ], "write");
  const compras = crearAlmacenCompras(cliente);
  const almacen = crearAlmacenSeguridad(cliente);
  await compras.init();await almacen.init();
  let ahora = 1000000;
  const reloj = () => ahora;
  const sesiones = crearSesionesComprador({ cliente, reloj });
  await sesiones.init();
  const acceso = crearServicioAcceso({ almacen, reloj, hashAdministrador: crearHashContrasena(CLAVE) });
  const conciliador = crearConciliadorCompras(cliente);
  const app = express();
  app.use("/api/v3", crearRouterV3({ acceso, compras, conciliador, sesionesComprador: sesiones, origen: ORIGEN, reloj }));
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));s.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/api/v3";
  async function request(path, opts = {}) {
    const headers={};if(opts.cookie)headers.cookie=opts.cookie;
    if(opts.method && opts.method !== "GET")headers.origin=opts.origin === undefined ? ORIGEN : opts.origin;
    if(opts.body !== undefined)headers["content-type"]="application/json";
    const respuesta = await fetch(url + path,{
      method:opts.method || "GET",headers,
      body:opts.body===undefined?undefined:JSON.stringify(opts.body),
      redirect:"manual",
    });
    return { status:respuesta.status,data:await respuesta.json(),cookie:respuesta.headers.get("set-cookie") };
  }
  const login = await request("/auth/login",{method:"POST",body:{contrasena:CLAVE}});
  assert.equal(login.status,200);
  const cookieAdmin=login.cookie.split(";")[0];
  async function comprar(ids) {
    const response=await request("/admin/compras",{
      method:"POST",cookie:cookieAdmin,body:{lineas:ids.map(productoId=>({productoId}))},
    });
    assert.equal(response.status,201);
    return response.data.compra.compraId;
  }
  async function invitar(id){
    const response=await request("/admin/compras/"+id+"/invitaciones",{
      method:"POST",cookie:cookieAdmin,body:{},
    });
    assert.equal(response.status,201);
    return response.data.invitacion.token;
  }
  return {request,comprar,invitar,sesiones,cliente,acceso,avanzar:ms=>{ahora+=ms}};
}

test("Canje seguro: activa una vez y guarda solo huella", async(t)=>{
  const e=await preparar(t);
  const id=await e.comprar([1]);
  const invitacion=await e.invitar(id);
  const activada=await e.request("/compras/"+id+"/activar",{
    method:"POST",body:{invitacion},
  });
  assert.equal(activada.status,200,JSON.stringify(activada.data));
  assert.equal(activada.data.invitacion,undefined);
  assert.equal(activada.data.sesion,undefined);
  assert.match(activada.cookie,/HttpOnly/);
  assert.match(activada.cookie,/Secure/);
  assert.match(activada.cookie,/SameSite=Strict/);
  const cookie=activada.cookie.split(";")[0];
  assert.equal((await e.request("/compras/"+id,{cookie})).status,200);
  const repetir=await e.request("/compras/"+id+"/activar",{method:"POST",body:{invitacion}});
  assert.equal(repetir.status,403);
  const fila=(await e.cliente.execute("SELECT huella FROM hogarstock_buyer_sessions_v3")).rows[0];
  assert.ok(fila);
  assert.notEqual(fila.huella,cookie.split("=")[1]);
  assert.equal((await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_buyer_sessions_v3")).rows[0].n,1);
});

test("Cookie de A no autoriza B ni permite usar encabezado Bearer",async(t)=>{
  const e=await preparar(t);
  const a=await e.comprar([1]), b=await e.comprar([2]);
  const tokenA=await e.invitar(a);
  const result=await e.request("/compras/"+a+"/activar",{method:"POST",body:{invitacion:tokenA}});
  assert.equal(result.status,200);
  const cookie=result.cookie.split(";")[0];
  assert.equal((await e.request("/compras/"+a,{cookie})).status,200);
  assert.equal((await e.request("/compras/"+b,{cookie})).status,403);
  assert.equal((await e.request("/compras/"+a)).status,403);
  assert.equal((await e.request("/compras/"+b+"/finalizar",{method:"POST",cookie,body:{}})).status,403);
  const testVersion=await e.request("/compras/"+a,{cookie});
  const item=testVersion.data.compra.items[0];
  const cambio=await e.request("/compras/"+a+"/items/"+item.id,{
    method:"PATCH",cookie,body:{estado:"comprado",revisionEsperada:0},
  });
  assert.equal(cambio.status,200,JSON.stringify(cambio.data));
});

test("Canje atomico entre dos peticiones concurrentes: solo una acepta la invitacion",async(t)=>{
  const e=await preparar(t);
  const id=await e.comprar([1]);
  const invitacion=await e.invitar(id);
  const [x,y]=await Promise.all([
    e.request("/compras/"+id+"/activar",{method:"POST",body:{invitacion}}),
    e.request("/compras/"+id+"/activar",{method:"POST",body:{invitacion}}),
  ]);
  assert.deepEqual([x.status,y.status].sort((a,b)=>a-b),[200,403]);
  const sesiones=await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_buyer_sessions_v3");
  assert.equal(Number(sesiones.rows[0].n),1);
});

test("Cerrar sesion de compra revoca la cookie",async(t)=>{
  const e=await preparar(t);
  const id=await e.comprar([1]);
  const invitacion=await e.invitar(id);
  const activa=await e.request("/compras/"+id+"/activar",{method:"POST",body:{invitacion}});
  const cookie=activa.cookie.split(";")[0];
  assert.equal((await e.request("/compras/"+id,{cookie})).status,200);
  const salida=await e.request("/compras/"+id+"/salir",{method:"POST",cookie,body:{}});
  assert.equal(salida.status,200);
  assert.equal((await e.request("/compras/"+id,{cookie})).status,403);
});

test("Invitacion caducada y origen diferente: sin acceso",async(t)=>{
  const e=await preparar(t);
  const id=await e.comprar([1]);
  const invitacion=await e.invitar(id);
  const otroOrigen=await e.request("/compras/"+id+"/activar",{
    method:"POST",origin:"https://hostile.example",body:{invitacion},
  });
  assert.equal(otroOrigen.status,403);
  e.avanzar(24*60*60*1000);
  const caducado=await e.request("/compras/"+id+"/activar",{
    method:"POST",body:{invitacion},
  });
  assert.equal(caducado.status,403);
});
