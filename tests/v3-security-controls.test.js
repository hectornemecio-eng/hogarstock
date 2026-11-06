"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const express=require("express"),{createClient}=require("@libsql/client");
const {mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path"),{tmpdir}=require("node:os");
const {crearAlmacenSeguridad}=require("../security/store.js");
const {crearHashContrasena,crearServicioAcceso,verificarContrasena}=require("../security/access.js");
const {crearCredencialesAdmin}=require("../security/admin-credentials.js");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearConciliadorCompras}=require("../compras/conciliacion.js");
const {crearSesionesComprador}=require("../security/buyer-sessions.js");
const {crearRouterV3}=require("../api/v3-router.js");

const anterior="Contraseña exclusivamente FICTICIA antigua V3 2026!";
const nueva="Frase de acceso nueva FICTICIA distinta 2026!";
const origen="http://127.0.0.1";

async function escenario(t){
 const dir=mkdtempSync(join(tmpdir(),"hs-security-v3-"));
 const db=createClient({url:"file:"+join(dir,"pruebas.sqlite")});
 await db.batch(["CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)",
  "INSERT INTO productos VALUES(1,'Leche ficticia','Lacteos',1),(2,'Huevos ficticios','Lacteos',1)"],"write");
 const almacen=crearAlmacenSeguridad(db);await almacen.init();
 const credenciales=crearCredencialesAdmin({cliente:db});
 await credenciales.init({hashInicial:crearHashContrasena(anterior)});
 const compras=crearAlmacenCompras(db);await compras.init();
 const sesionesComprador=crearSesionesComprador({cliente:db});await sesionesComprador.init();
 const acceso=crearServicioAcceso({almacen,credenciales,hashAdministrador:crearHashContrasena(anterior)});
 const app=express();
 app.use("/api/v3",crearRouterV3({acceso,compras,sesionesComprador,
  conciliador:crearConciliadorCompras(db),origen}));
 const server=await new Promise((ok,bad)=>{const s=app.listen(0,"127.0.0.1",()=>ok(s));s.on("error",bad);});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
 const base="http://127.0.0.1:"+server.address().port+"/api/v3";
 async function request(path,{method="GET",cookie,body}={}){
  const headers={};if(cookie)headers.cookie=cookie;
  if(method!=="GET")headers.origin=origen;
  if(body!==undefined)headers["content-type"]="application/json";
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")?.split(";")[0]};
 }
 const login=async clave=>request("/auth/login",{method:"POST",body:{contrasena:clave}});
 return {db,credenciales,compras,sesionesComprador,acceso,request,login};
}
test("Cambiar contraseña requiere administrador y contraseña actual; no guarda texto plano",async t=>{
 const e=await escenario(t);
 const login=await e.login(anterior);
 assert.equal(login.status,200);
 const ruta="/admin/contrasena";
 assert.equal((await e.request(ruta,{method:"POST",body:{actual:anterior,nueva}})).status,401);
 assert.equal((await e.request(ruta,{method:"POST",cookie:login.cookie,
   body:{actual:"contraseña incorrecta",nueva}})).status,403);
 assert.equal((await e.request("/admin/sesion",{cookie:login.cookie})).status,200);
 const igual=await e.request(ruta,{method:"POST",cookie:login.cookie,
   body:{actual:anterior,nueva:anterior}});
 assert.equal(igual.status,409);
 assert.equal(igual.data.error,"CONTRASENA_REUTILIZADA");
 assert.equal((await e.request("/admin/sesion",{cookie:login.cookie})).status,200);
 assert.equal((await e.login(anterior)).status,200);
 const db=JSON.stringify((await e.db.execute("SELECT * FROM hogarstock_admin_credentials_v3")).rows);
 assert.equal(db.includes(anterior),false);assert.equal(db.includes(nueva),false);
});
test("Cambio cierra todas las sesiones, invalida clave antigua y sobrevive a nuevo servicio",async t=>{
 const e=await escenario(t);
 const a=await e.login(anterior),b=await e.login(anterior);
 assert.equal(a.status,200);assert.equal(b.status,200);
 const cambio=await e.request("/admin/contrasena",{method:"POST",cookie:a.cookie,
  body:{actual:anterior,nueva}});
 assert.equal(cambio.status,200,JSON.stringify(cambio.data));
 assert.equal(cambio.data.sesionesInvalidadas,true);
 assert.equal((await e.request("/admin/sesion",{cookie:a.cookie})).status,401);
 assert.equal((await e.request("/admin/sesion",{cookie:b.cookie})).status,401);
 assert.equal((await e.login(anterior)).status,401);
 assert.equal((await e.login(nueva)).status,200);
 const reinicio=crearCredencialesAdmin({cliente:e.db});
 await reinicio.init({hashInicial:crearHashContrasena(anterior)});
 assert.equal(verificarContrasena(nueva,await reinicio.leerHash()),true);
 assert.equal(verificarContrasena(anterior,await reinicio.leerHash()),false);
});
test("Revocar accesos bloquea invitaciones sin usar y sesiones activas, sin cruzar compras",async t=>{
 const e=await escenario(t);
 const admin=(await e.login(anterior)).cookie;
 const crear=async productoId=>{
  const r=await e.request("/admin/compras",{method:"POST",cookie:admin,
    body:{lineas:[{productoId}]}});assert.equal(r.status,201);return r.data.compra.compraId;
 };
 const c1=await crear(1),c2=await crear(2);
 const invitar=async compraId=>{
  const r=await e.request("/admin/compras/"+compraId+"/invitaciones",{method:"POST",cookie:admin});
  assert.equal(r.status,201);return r.data.invitacion.token;
 };
 const unoUsada=await invitar(c1),unoPendiente=await invitar(c1),otro=await invitar(c2);
 const activar=async (id,token)=>e.request("/compras/"+id+"/activar",{method:"POST",
   body:{invitacion:token}});
 const s1=await activar(c1,unoUsada),s2=await activar(c2,otro);
 assert.equal(s1.status,200);assert.equal(s2.status,200);
 assert.equal((await e.request("/compras/"+c1,{cookie:s1.cookie})).status,200);
 assert.equal((await e.request("/compras/"+c2,{cookie:s2.cookie})).status,200);
 const path="/admin/compras/"+c1+"/revocar-accesos";
 assert.equal((await e.request(path,{method:"POST",body:{confirmacion:true}})).status,401);
 assert.equal((await e.request(path,{method:"POST",cookie:admin,body:{confirmacion:false}})).status,400);
 const rev=await e.request(path,{method:"POST",cookie:admin,body:{confirmacion:true}});
 assert.equal(rev.status,200);assert.equal(rev.data.invitacionesRevocadas,1);
 assert.equal(rev.data.sesionesRevocadas,1);
 assert.equal((await activar(c1,unoPendiente)).status,403);
 assert.equal((await e.request("/compras/"+c1,{cookie:s1.cookie})).status,403);
 assert.equal((await e.request("/compras/"+c2,{cookie:s2.cookie})).status,200);
 const otra=await e.request(path,{method:"POST",cookie:admin,body:{confirmacion:true}});
 assert.equal(otra.status,200);
 assert.equal(otra.data.invitacionesRevocadas,0);
 assert.equal(otra.data.sesionesRevocadas,0);
});
