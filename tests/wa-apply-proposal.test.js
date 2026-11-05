"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes}=require("node:crypto"),{mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path"),{tmpdir}=require("node:os");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearBandejaWhatsApp}=require("../whatsapp/inbox-store.js");
const {crearAplicadorWhatsApp}=require("../whatsapp/apply-proposal.js");
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"hs-wa-apply-"));
 const db=createClient({url:"file:"+join(dir,"t.sqlite")});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 await db.batch(["CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)",
  "INSERT INTO productos VALUES(1,'Leche','Lacteos',1),(2,'Huevos','Lacteos',1)"],"write");
 const compras=crearAlmacenCompras(db);await compras.init();
 const a=(await compras.crearCompra({lineas:[{productoId:1}]})).compraId;
 const b=(await compras.crearCompra({lineas:[{productoId:2}]})).compraId;
 const bandeja=crearBandejaWhatsApp({cliente:db,compras,claveHmacHex:randomBytes(32).toString("hex")});await bandeja.init();
 const aplicador=crearAplicadorWhatsApp({cliente:db});await aplicador.init();
 await bandeja.vincularRemitente({compraId:a,telefono:"34600111222"});
 const item=(await compras.obtenerCompra({compraId:a})).items[0];
 const proponer=async(accion="COMPRADO",id="MSG1234")=>bandeja.recibir({telefono:"34600111222",mensajeId:id,texto:accion+" "+item.id});
 return {db,compras,bandeja,aplicador,a,b,item,proponer};
}
test("Aplica atómicamente y no altera productos.agotado",async t=>{
 const e=await fixture(t),p=await e.proponer();
 const r=await e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0});
 assert.equal(r.estado,"comprado");assert.equal(r.revisionNueva,1);
 assert.equal((await e.compras.obtenerCompra({compraId:e.a})).items[0].estado,"comprado");
 assert.equal((await e.bandeja.listarPorCompra({compraId:e.a}))[0].estado,"revisada");
 assert.equal(Number((await e.db.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("Segunda aplicación es idempotente",async t=>{
 const e=await fixture(t),p=await e.proponer();
 const x=await e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0});
 const y=await e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0});
 assert.equal(y.yaAplicada,true);assert.equal(y.id,x.id);
 assert.equal((await e.compras.obtenerCompra({compraId:e.a})).items[0].revision,1);
});
test("Rechaza propuesta de otra compra sin mutar",async t=>{
 const e=await fixture(t),p=await e.proponer();
 await assert.rejects(e.aplicador.aplicar({compraId:e.b,respuestaId:p.id,revisionEsperada:0}),/WA_PROPUESTA_AJENA/);
 assert.equal((await e.compras.obtenerCompra({compraId:e.a})).items[0].estado,"pendiente");
});
test("Conflicto de versión no consume propuesta",async t=>{
 const e=await fixture(t),p=await e.proponer();
 await e.compras.cambiarEstadoItem({compraId:e.a,itemId:e.item.id,estado:"no_disponible",revisionEsperada:0});
 await assert.rejects(e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0}),/CONFLICTO_VERSION/);
 assert.equal((await e.bandeja.listarPorCompra({compraId:e.a}))[0].estado,"pendiente_revision");
});
test("Compra finalizada bloquea aplicación",async t=>{
 const e=await fixture(t),p=await e.proponer();await e.compras.finalizarCompra({compraId:e.a});
 await assert.rejects(e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0}),/COMPRA_CERRADA/);
});
test("Una propuesta descartada no se aplica",async t=>{
 const e=await fixture(t),p=await e.proponer();
 await e.bandeja.revisar({compraId:e.a,id:p.id,decision:"descartada"});
 await assert.rejects(e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0}),/WA_PROPUESTA_NO_APLICABLE/);
});
test("Aplicar estado idéntico registra auditoría sin incrementar revisión",async t=>{
 const e=await fixture(t),p=await e.proponer("PENDIENTE");
 const r=await e.aplicador.aplicar({compraId:e.a,respuestaId:p.id,revisionEsperada:0});
 assert.equal(r.cambiado,false);assert.equal(r.revisionNueva,0);
 assert.equal((await e.aplicador.listarPorCompra({compraId:e.a})).length,1);
});
