"use strict";
// Acceso HTTP administrativo OPTIONAL a la reposicion con SQLite ficticia.
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createClient}=require("@libsql/client");
const {mkdtempSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {crearRouterV3}=require("../api/v3-router.js");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearRepositorInventarioV3}=require("../compras/v3-reposicion-sandbox.js");
const cookie="hs_admin_v3="+"A".repeat(43);
const origen="https://hogarstock-v3-stage.invalid";
async function servidor(t,habilitar=true){
  const dir=mkdtempSync(join(tmpdir(),"hs-rep-http-fake-"));
  const db=createClient({url:"file:"+join(dir,"reponer.sqlite")});
  await db.batch([
    "CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER NOT NULL)",
    "INSERT INTO productos VALUES(1,'Leche FICTICIA','Ensayo',1),(2,'Huevos FICTICIOS','Ensayo',1)",
  ],"write");
  const compras=crearAlmacenCompras(db);
  await compras.init();
  const id=(await compras.crearCompra({lineas:[{productoId:1},{productoId:2}]})).compraId;
  const c=await compras.obtenerCompra({compraId:id});
  await compras.cambiarEstadoItem({compraId:id,itemId:c.items[0].id,
    estado:"comprado",revisionEsperada:0});
  await compras.finalizarCompra({compraId:id});
  const reposicion=crearRepositorInventarioV3({cliente:db,entorno:{
    HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_REPOSICION_LAB:"1",
  }});
  await reposicion.init();
  const acceso={
    async iniciarSesionAdmin(){},async autorizarAdmin({token}){
      return token==="A".repeat(43);
    },async cerrarSesionAdmin(){},async emitirPermisoCompra(){},
    async autorizarCompra(){},
  };
  const app=express();
  app.use("/api/v3",crearRouterV3({
    acceso,compras,conciliador:{async informeCompraFinalizada(){return {}}},
    origen,reposicionInventario:habilitar?reposicion:null,
  }));
  const s=await new Promise((resolve,reject)=>{
    const server=app.listen(0,"127.0.0.1",()=>resolve(server));
    server.once("error",reject);
  });
  t.after(async()=>{
    const cerrada=new Promise(r=>s.close(r));
    s.closeAllConnections?.();
    await cerrada;await db.close();
  });
  const base="http://127.0.0.1:"+s.address().port+"/api/v3/admin/compras/"+id+"/reposicion";
  return {base,db,id,reposicion};
}
test("Sin servicio inyectado la ruta de escritura no existe",async t=>{
  const e=await servidor(t,false);
  const r=await fetch(e.base,{headers:{Cookie:cookie}});
  assert.equal(r.status,404);
});
test("Ruta opcional exige administrador valido antes de leer o escribir",async t=>{
  const e=await servidor(t);
  assert.equal((await fetch(e.base)).status,401);
  assert.equal((await fetch(e.base+"/aplicar",{
    method:"POST",headers:{"Origin":origen,"Content-Type":"application/json"},
    body:JSON.stringify({confirmacion:true,huellaEsperada:"f".repeat(64)}),
  })).status,401);
  assert.equal(Number((await e.db.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("Proteccion CSRF: la escritura exige Origin exacto",async t=>{
  const e=await servidor(t);
  const form={confirmacion:true,huellaEsperada:"f".repeat(64)};
  for(const origin of [undefined,"https://evil.invalid","http://hogarstock-v3-stage.invalid"]){
    const headers={Cookie:cookie,"Content-Type":"application/json"};
    if(origin)headers.Origin=origin;
    const res=await fetch(e.base+"/aplicar",{
      method:"POST",headers,body:JSON.stringify(form),
    });
    assert.equal(res.status,403);
  }
  assert.equal(Number((await e.db.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("Informe protegido + confirmacion + huella: repone solo comprado",async t=>{
  const e=await servidor(t);
  const res=await fetch(e.base,{headers:{Cookie:cookie}});
  assert.equal(res.status,200);
  const doc=(await res.json()).informe;
  assert.equal(doc.resumen.reponibles,1);
  const endpoint=e.base+"/aplicar";
  const baseHeaders={Cookie:cookie,Origin:origen,"Content-Type":"application/json"};
  const no=await fetch(endpoint,{method:"POST",headers:baseHeaders,
    body:JSON.stringify({huellaEsperada:doc.huella})});
  assert.equal(no.status,400);
  const bad=await fetch(endpoint,{method:"POST",headers:baseHeaders,
    body:JSON.stringify({confirmacion:true,huellaEsperada:"0".repeat(64)})});
  assert.equal(bad.status,409);
  const ok=await fetch(endpoint,{method:"POST",headers:baseHeaders,
    body:JSON.stringify({confirmacion:true,huellaEsperada:doc.huella})});
  assert.equal(ok.status,200);
  const result=(await ok.json()).resultado;
  assert.equal(result.numeroAplicados,1);
  const catalogo=await e.db.execute("SELECT id,agotado FROM productos ORDER BY id");
  assert.deepEqual(catalogo.rows.map(x=>Number(x.agotado)),[0,1]);
  const rep=await fetch(e.base,{headers:{Cookie:cookie}});
  assert.equal((await rep.json()).informe.lineas[0].decision,"CONCILIADA_ANTERIORMENTE");
});
