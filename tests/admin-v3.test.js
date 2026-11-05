"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createClient}=require("@libsql/client");
const {mkdtempSync,rmSync,readFileSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {crearCatalogoV3}=require("../catalogo/store.js");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearAlmacenSeguridad}=require("../security/store.js");
const {crearServicioAcceso,crearHashContrasena}=require("../security/access.js");
const {crearSesionesComprador}=require("../security/buyer-sessions.js");
const {crearConciliadorCompras}=require("../compras/conciliacion.js");
const {crearRouterV3}=require("../api/v3-router.js");

const CLAVE="Contraseña ficticia de pruebas administrativas V3!";
async function preparar(t){
 const dir=mkdtempSync(join(tmpdir(),"hogarstock-admin-v3-"));
 const db=createClient({url:"file:"+join(dir,"test.sqlite")});
 await db.batch([
  "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
  "INSERT INTO productos(id,nombre,categoria,agotado) VALUES (1,'Leche','Lacteos',1),(2,'Huevos','Lacteos',1),(3,'Arroz','Despensa',0)",
 ],"write");
 const compras=crearAlmacenCompras(db),seguridad=crearAlmacenSeguridad(db);
 await compras.init();await seguridad.init();
 const sesiones=crearSesionesComprador({cliente:db});await sesiones.init();
 const app=express();
 app.use("/api/v3",crearRouterV3({
  compras,catalogo:crearCatalogoV3(db),sesionesComprador:sesiones,
  acceso:crearServicioAcceso({almacen:seguridad,hashAdministrador:crearHashContrasena(CLAVE)}),
  conciliador:crearConciliadorCompras(db),origen:"http://127.0.0.1"
 }));
 const server=await new Promise((resolve,reject)=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));s.on("error",reject);});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
 const root="http://127.0.0.1:"+server.address().port+"/api/v3";
 async function request(path,{method="GET",cookie,body,origin="http://127.0.0.1"}={}){
  const headers={};if(cookie)headers.cookie=cookie;
  if(method!=="GET")headers.origin=origin;
  if(body!==undefined)headers["content-type"]="application/json";
  const response=await fetch(root+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get("set-cookie")};
 }
 const login=await request("/auth/login",{method:"POST",body:{contrasena:CLAVE}});
 assert.equal(login.status,200);
 return {request,db,cookie:login.cookie.split(";")[0]};
}
test("Catálogo: sin cookie no se lee ni modifica",async(t)=>{
 const e=await preparar(t);
 assert.equal((await e.request("/admin/productos")).status,401);
 assert.equal((await e.request("/admin/productos",{method:"POST",body:{nombre:"Té",categoria:"Bebidas"}})).status,401);
 assert.equal(Number((await e.db.execute("SELECT COUNT(*) AS n FROM productos")).rows[0].n),3);
});
test("Catálogo: listado, alta, edición y cambios condicionados",async(t)=>{
 const e=await preparar(t),c=e.cookie;
 const inicial=await e.request("/admin/productos",{cookie:c});assert.equal(inicial.status,200);assert.equal(inicial.data.productos.length,3);
 const creado=await e.request("/admin/productos",{method:"POST",cookie:c,body:{nombre:"Manzanas",categoria:"Fruta"}});
 assert.equal(creado.status,201);const id=creado.data.producto.id;
 assert.equal((await e.request("/admin/productos",{method:"POST",cookie:c,body:{nombre:"MANZANAS",categoria:"fruta"}})).status,409);
 const cambio=await e.request("/admin/productos/"+id,{method:"PUT",cookie:c,body:{nombre:"Manzana roja",categoria:"Fruta"}});
 assert.equal(cambio.status,200);assert.equal(cambio.data.producto.nombre,"Manzana roja");
 const falta=await e.request("/admin/productos/"+id+"/necesidad",{method:"PATCH",cookie:c,body:{agotado:1,agotadoEsperado:0}});
 assert.equal(falta.status,200);assert.equal(falta.data.producto.agotado,true);
 const obsoleto=await e.request("/admin/productos/"+id+"/necesidad",{method:"PATCH",cookie:c,body:{agotado:1,agotadoEsperado:0}});
 assert.equal(obsoleto.status,409);
});
test("Compras: historial administrativo y transacciones independientes",async(t)=>{
 const e=await preparar(t),c=e.cookie;
 assert.equal((await e.request("/admin/compras")).status,401);
 const primero=await e.request("/admin/compras",{method:"POST",cookie:c,body:{lineas:[{productoId:1}]}});
 assert.equal(primero.status,201);
 const segundo=await e.request("/admin/compras",{method:"POST",cookie:c,body:{lineas:[{productoId:2}]}});
 assert.equal(segundo.status,201);
 const historial=await e.request("/admin/compras",{cookie:c});
 assert.equal(historial.status,200);
 assert.deepEqual(historial.data.compras.map(x=>x.id),[
  segundo.data.compra.compraId,primero.data.compra.compraId
 ]);
 assert.deepEqual(historial.data.compras.map(x=>x.total),[1,1]);
 assert.ok(historial.data.compras.every(x=>x.estado==="abierta"));
});
test("Catálogo: identidad HTML segura y enlace sin WhatsApp automatico",()=>{
 const pagina=readFileSync(join(__dirname,"../public/admin-v3.html"),"utf8");
 assert.ok(pagina.includes('id="loginForm"'));
 for(const x of ['id="catalogo"','id="compras"','id="invitationArea"','id="reconciliation"']){
  assert.ok(pagina.includes(x),x);
 }
 assert.match(pagina,/document\.createElement/);
 assert.match(pagina,/textContent/);
 assert.doesNotMatch(pagina,/\binnerHTML\b|\bouterHTML\b|\blocalStorage\b|\bsessionStorage\b/);
 assert.ok(pagina.includes('api.whatsapp.com/send?text='));
 assert.ok(pagina.includes("confirmar su envío"));
});
