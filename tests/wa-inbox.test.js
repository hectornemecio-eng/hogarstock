"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes}=require("node:crypto");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearBandejaWhatsApp}=require("../whatsapp/inbox-store.js");

async function escenario(t){
  const dir=mkdtempSync(join(tmpdir(),"hs-wa-inbox-"));
  const url="file:"+join(dir,"pruebas.sqlite");
  const cliente=createClient({url});
  const otras=[];
  t.after(()=>{for(const c of otras)c.close();cliente.close();rmSync(dir,{recursive:true,force:true});});
  await cliente.batch([
    "CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL,"+
      "categoria TEXT NOT NULL,agotado INTEGER NOT NULL)",
    "INSERT INTO productos VALUES (1,'Leche','Lacteos',1),(2,'Huevos','Lacteos',1)",
  ],"write");
  let tiempo=1000000;
  const compras=crearAlmacenCompras(cliente);
  await compras.init();
  const c1=await compras.crearCompra({lineas:[{productoId:1}]});
  const c2=await compras.crearCompra({lineas:[{productoId:2}]});
  const secreto=randomBytes(32).toString("hex");
  async function abrir(c=cliente,clave=secreto){
    const inbox=crearBandejaWhatsApp({
      cliente:c,compras,claveHmacHex:clave,reloj:()=>tiempo,
    });
    await inbox.init();return inbox;
  }
  const inbox=await abrir();
  return {cliente,compras,inbox,abrir,otraConexion:()=>{
    const c=createClient({url});otras.push(c);return c;
  },c1:c1.compraId,c2:c2.compraId,
  avanzar:ms=>{tiempo+=ms;}};
}
const telefono="34600111222";
test("Remitente no vinculado no se almacena ni modifica una compra",async t=>{
  const e=await escenario(t);
  const compra=await e.compras.obtenerCompra({compraId:e.c1});
  const r=await e.inbox.recibir({telefono,mensajeId:"Amsg1234",
    texto:"COMPRADO "+compra.items[0].id});
  assert.equal(r.estado,"remitente_no_vinculado");
  const n=await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_wa_inbox_v3");
  assert.equal(Number(n.rows[0].n),0);
  assert.equal((await e.compras.obtenerCompra({compraId:e.c1})).items[0].estado,"pendiente");
});
test("Remitente vinculado: propuesta, deduplicacion y revision sin tocar inventario",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  const id=(await e.compras.obtenerCompra({compraId:e.c1})).items[0].id;
  const peticion={telefono,mensajeId:"Amsg5678",texto:"COMPRADO "+id};
  const primera=await e.inbox.recibir(peticion);
  assert.equal(primera.estado,"pendiente_revision");
  assert.equal(primera.compraId,e.c1);
  assert.equal(primera.itemId,id);
  assert.equal(primera.accion,"comprado");
  assert.equal((await e.inbox.recibir(peticion)).estado,"duplicado");
  const listado=await e.inbox.listarPorCompra({compraId:e.c1});
  assert.equal(listado.length,1);
  assert.equal(listado[0].estado,"pendiente_revision");
  assert.equal((await e.inbox.revisar({id:primera.id,decision:"revisada"})).actualizado,true);
  assert.equal((await e.inbox.revisar({id:primera.id,decision:"revisada"})).actualizado,false);
  assert.equal((await e.compras.obtenerCompra({compraId:e.c1})).items[0].estado,"pendiente");
  const raw=JSON.stringify((await e.cliente.execute(
    "SELECT * FROM hogarstock_wa_inbox_v3")).rows);
  assert.doesNotMatch(raw,/34600111222|Amsg5678|COMPRADO 1/i);
});
test("Vinculo ambiguo: no adjudica la respuesta a ninguna compra",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  await e.inbox.vincularRemitente({compraId:e.c2,telefono});
  const id=(await e.compras.obtenerCompra({compraId:e.c1})).items[0].id;
  const r=await e.inbox.recibir({telefono,mensajeId:"Bmsg1234",texto:"COMPRADO "+id});
  assert.equal(r.estado,"ambigua");
  assert.equal(r.compraId,null);
  assert.equal(r.itemId,null);
  assert.equal((await e.inbox.listarPorCompra({compraId:e.c1})).length,0);
});
test("Mensaje no interpretable y artículo de otra compra no realizan cambios",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  const desconocido=(await e.compras.obtenerCompra({compraId:e.c2})).items[0].id;
  const a=await e.inbox.recibir({telefono,mensajeId:"Cmsg1234",texto:"hola"});
  const b=await e.inbox.recibir({telefono,mensajeId:"Cmsg5678",
    texto:"NO DISPONIBLE "+desconocido});
  assert.equal(a.estado,"no_interpretable");
  assert.equal(b.estado,"no_interpretable");
  assert.equal((await e.compras.obtenerCompra({compraId:e.c2})).items[0].estado,"pendiente");
});
test("Revocacion, caducidad y compra cerrada bloquean respuestas",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono,duracionMs:60000});
  assert.equal((await e.inbox.revocarVinculo({compraId:e.c1,telefono})).revocado,true);
  assert.equal((await e.inbox.recibir({telefono,mensajeId:"Dmsg1234",texto:"PENDIENTE 1"})).estado,
    "remitente_no_vinculado");
  await e.inbox.vincularRemitente({compraId:e.c1,telefono,duracionMs:60000});
  e.avanzar(60000);
  assert.equal((await e.inbox.recibir({telefono,mensajeId:"Dmsg5678",texto:"PENDIENTE 1"})).estado,
    "remitente_no_vinculado");
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  await e.compras.finalizarCompra({compraId:e.c1});
  assert.equal((await e.inbox.recibir({telefono,mensajeId:"Dmsg9000",texto:"PENDIENTE 1"})).estado,
    "remitente_no_vinculado");
});
test("Dos conexiones deduplican y la tabla no almacena texto, telefono ni ID remoto",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  const otra=await e.abrir(e.otraConexion());
  const id=(await e.compras.obtenerCompra({compraId:e.c1})).items[0].id;
  const p={telefono,mensajeId:"Emsg1234",texto:"COMPRADO "+id};
  const a=await e.inbox.recibir(p);
  const b=await otra.recibir(p);
  assert.equal(a.estado,"pendiente_revision");
  assert.equal(b.estado,"duplicado");
  const n=await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_wa_inbox_v3");
  assert.equal(Number(n.rows[0].n),1);
  const raw=JSON.stringify((await e.cliente.execute(
    "SELECT * FROM hogarstock_wa_links_v3")).rows);
  assert.doesNotMatch(raw,/34600111222/);
});
test("Clave HMAC incorrecta no reidentifica enlaces existentes",async t=>{
  const e=await escenario(t);
  await e.inbox.vincularRemitente({compraId:e.c1,telefono});
  const distinto=await e.abrir(e.otraConexion(),randomBytes(32).toString("hex"));
  const id=(await e.compras.obtenerCompra({compraId:e.c1})).items[0].id;
  assert.equal((await distinto.recibir({telefono,mensajeId:"Fmsg1234",
    texto:"COMPRADO "+id})).estado,"remitente_no_vinculado");
});
