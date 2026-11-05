"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createClient}=require("@libsql/client");
const {randomBytes}=require("node:crypto");
const {mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {crearBandejaWhatsApp}=require("../whatsapp/inbox-store.js");
const {crearAplicadorWhatsApp}=require("../whatsapp/apply-proposal.js");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearAlmacenSeguridad}=require("../security/store.js");
const {crearServicioAcceso,crearHashContrasena}=require("../security/access.js");
const {crearConciliadorCompras}=require("../compras/conciliacion.js");
const {crearRouterV3}=require("../api/v3-router.js");

const CLAVE="Solo-Pruebas-HogarStock-V3-Contraseña-Ficticia!";
async function crearEntorno(t){
 const carpeta=mkdtempSync(join(tmpdir(),"hs-revision-http-"));
 const cliente=createClient({url:"file:"+join(carpeta,"test.sqlite")});
 await cliente.batch([
  "CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER NOT NULL)",
  "INSERT INTO productos VALUES (1,'Leche ficticia','Lacteos',1),(2,'Huevos ficticios','Lacteos',1)",
 ],"write");
 const compras=crearAlmacenCompras(cliente),seguridad=crearAlmacenSeguridad(cliente);
 await compras.init();await seguridad.init();
 const c1=(await compras.crearCompra({lineas:[{productoId:1}]})).compraId;
 const c2=(await compras.crearCompra({lineas:[{productoId:2}]})).compraId;
 const bandeja=crearBandejaWhatsApp({
  cliente,compras,claveHmacHex:randomBytes(32).toString("hex"),
 });
 await bandeja.init();
 const aplicador=crearAplicadorWhatsApp({cliente});await aplicador.init();
 await bandeja.vincularRemitente({compraId:c1,telefono:"34600111222"});
 const item=(await compras.obtenerCompra({compraId:c1})).items[0];
 const mensaje=await bandeja.recibir({
  telefono:"34600111222",mensajeId:"TESTmensaje1234",
  texto:"COMPRADO "+item.id,
 });
 const app=express();
 app.use("/api/v3",crearRouterV3({
  acceso:crearServicioAcceso({
   almacen:seguridad,hashAdministrador:crearHashContrasena(CLAVE),
  }),
  compras,conciliador:crearConciliadorCompras(cliente),
  bandejaWhatsApp:bandeja,aplicadorWhatsApp:aplicador,origen:"http://127.0.0.1",
 }));
 const servidor=await new Promise((resolve,reject)=>{
  const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  s.on("error",reject);
 });
 t.after(async()=>{
  await new Promise(resolve=>servidor.close(resolve));
  cliente.close();rmSync(carpeta,{recursive:true,force:true});
 });
 const base="http://127.0.0.1:"+servidor.address().port+"/api/v3";
 async function req(path,{method="GET",cookie,body}={}){
  const headers={};
  if(cookie)headers.cookie=cookie;
  if(method!=="GET")headers.origin="http://127.0.0.1";
  if(body!==undefined)headers["content-type"]="application/json";
  const r=await fetch(base+path,{method,headers,
   body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")};
 }
 const login=await req("/auth/login",{method:"POST",body:{contrasena:CLAVE}});
 assert.equal(login.status,200);
 const cookie=login.cookie.split(";")[0];
 return {cliente,compras,bandeja,aplicador,c1,c2,mensaje,cookie,req};
}
test("Consulta respuestas requiere sesión administrativa",async t=>{
 const e=await crearEntorno(t);
 const ruta="/admin/compras/"+e.c1+"/respuestas";
 const sin=await e.req(ruta);
 assert.equal(sin.status,401);
 const bien=await e.req(ruta,{cookie:e.cookie});
 assert.equal(bien.status,200);
 assert.equal(bien.data.respuestas.length,1);
 assert.equal(bien.data.respuestas[0].estado,"pendiente_revision");
 assert.equal(JSON.stringify(bien.data).includes("34600111222"),false);
 assert.equal(JSON.stringify(bien.data).includes("TESTmensaje1234"),false);
});
test("Revisión no puede afectar respuesta de otra compra",async t=>{
 const e=await crearEntorno(t);
 const mal=await e.req("/admin/compras/"+e.c2+"/respuestas/"+e.mensaje.id+"/revisar",{
  method:"POST",cookie:e.cookie,body:{decision:"revisada"},
 });
 assert.equal(mal.status,409);
 assert.equal((await e.bandeja.listarPorCompra({compraId:e.c1}))[0].estado,"pendiente_revision");
});
test("Revisión correcta es única, exige permiso y no modifica inventario",async t=>{
 const e=await crearEntorno(t);
 const ruta="/admin/compras/"+e.c1+"/respuestas/"+e.mensaje.id+"/revisar";
 assert.equal((await e.req(ruta,{method:"POST",body:{decision:"revisada"}})).status,401);
 const revisada=await e.req(ruta,{method:"POST",cookie:e.cookie,body:{decision:"revisada"}});
 assert.equal(revisada.status,200);
 assert.deepEqual(revisada.data,{actualizado:true,aplicadaAlInventario:false});
 assert.equal((await e.req(ruta,{method:"POST",cookie:e.cookie,body:{decision:"revisada"}})).status,409);
 const item=(await e.compras.obtenerCompra({compraId:e.c1})).items[0];
 assert.equal(item.estado,"pendiente");
 assert.equal(Number((await e.cliente.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("Decisión inválida o ruta incorrecta se rechaza sin mutaciones",async t=>{
 const e=await crearEntorno(t);
 const ruta="/admin/compras/"+e.c1+"/respuestas/"+e.mensaje.id+"/revisar";
 assert.equal((await e.req(ruta,{method:"POST",cookie:e.cookie,body:{decision:"aplicar"}})).status,400);
 assert.equal((await e.req("/admin/compras/0/respuestas",{cookie:e.cookie})).status,400);
 assert.equal((await e.bandeja.listarPorCompra({compraId:e.c1}))[0].estado,"pendiente_revision");
});

test("Aplicación HTTP solo admin y revisión esperada obligatoria",async t=>{
 const e=await crearEntorno(t);
 const ruta="/admin/compras/"+e.c1+"/respuestas/"+e.mensaje.id+"/aplicar";
 assert.equal((await e.req(ruta,{method:"POST",body:{confirmacion:true,revisionEsperada:0}})).status,401);
 assert.equal((await e.req(ruta,{method:"POST",cookie:e.cookie,body:{confirmacion:false,revisionEsperada:0}})).status,400);
 const ok=await e.req(ruta,{method:"POST",cookie:e.cookie,body:{confirmacion:true,revisionEsperada:0}});
 assert.equal(ok.status,200,JSON.stringify(ok.data));
 assert.equal(ok.data.aplicacion.estado,"comprado");
 assert.equal(ok.data.inventarioGlobalModificado,false);
 assert.equal((await e.compras.obtenerCompra({compraId:e.c1})).items[0].estado,"comprado");
 const rep=await e.req(ruta,{method:"POST",cookie:e.cookie,body:{confirmacion:true,revisionEsperada:0}});
 assert.equal(rep.status,200);assert.equal(rep.data.aplicacion.yaAplicada,true);
 assert.equal((await e.req("/admin/compras/"+e.c1+"/aplicaciones",{cookie:e.cookie})).data.aplicaciones.length,1);
 assert.equal(Number((await e.cliente.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("Aplicación por URL de otra compra y versión obsoleta fallan cerradas",async t=>{
 const e=await crearEntorno(t);
 const mal=await e.req("/admin/compras/"+e.c2+"/respuestas/"+e.mensaje.id+"/aplicar",{
  method:"POST",cookie:e.cookie,body:{confirmacion:true,revisionEsperada:0}});
 assert.equal(mal.status,409);
 const item=(await e.compras.obtenerCompra({compraId:e.c1})).items[0];
 await e.compras.cambiarEstadoItem({compraId:e.c1,itemId:item.id,estado:"no_disponible",revisionEsperada:0});
 const obsoleto=await e.req("/admin/compras/"+e.c1+"/respuestas/"+e.mensaje.id+"/aplicar",{
  method:"POST",cookie:e.cookie,body:{confirmacion:true,revisionEsperada:0}});
 assert.equal(obsoleto.status,409);
 assert.equal((await e.compras.obtenerCompra({compraId:e.c1})).items[0].estado,"no_disponible");
});
