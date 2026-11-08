"use strict";
// Ensayo exclusivo SQLite local ficticio. No se importan Baileys, Render ni Turso.
// Datos de prueba se conservan hasta el fin del proceso Node (Windows EPERM).
const test=require("node:test");
const assert=require("node:assert/strict");
const {randomBytes}=require("node:crypto");
const {mkdtempSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {createClient}=require("@libsql/client");
const {crearAlmacenCompras}=require("../compras/store.js");
const {crearConciliadorCompras}=require("../compras/conciliacion.js");
const {crearRepositorInventarioV3}=require("../compras/v3-reposicion-sandbox.js");

const entorno={HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_REPOSICION_LAB:"1"};
async function escenario(t) {
  const dir=mkdtempSync(join(tmpdir(),"hs-v3-reposicion-"));
  const db=createClient({url:"file:"+join(dir,"catalogo-ficticio.sqlite")});
  t.after(async()=>db.close());
  await db.batch([
    "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER NOT NULL)",
    "INSERT INTO productos VALUES (1,'Leche FICTICIA','Ensayo',1),(2,'Huevos FICTICIOS','Ensayo',1),(3,'Arroz FICTICIO','Ensayo',1),(4,'Pasta FICTICIA','Ensayo',1)",
  ],"write");
  const compras=crearAlmacenCompras(db);
  await compras.init();
  const compraId=(await compras.crearCompra({
    lineas:[{productoId:1},{productoId:2},{productoId:3}],
  })).compraId;
  const rep=crearRepositorInventarioV3({cliente:db,entorno});
  await rep.init();
  const datos=()=>compras.obtenerCompra({compraId});
  async function marcar(productoId,estado="comprado") {
    const c=await datos();
    const item=c.items.find(x=>x.productoId===productoId);
    return compras.cambiarEstadoItem({
      compraId,itemId:item.id,estado,revisionEsperada:item.revision,
    });
  }
  const agotado=async id=>Number((await db.execute({
    sql:"SELECT agotado FROM productos WHERE id=?",args:[id],
  })).rows[0].agotado);
  const bitacora=async()=>Number((await db.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_reposiciones_v3")).rows[0].n);
  return {db,rep,compras,compraId,datos,marcar,agotado,bitacora};
}
test("Solo sandbox explicito; credenciales remotas bloqueadas antes de abrir DB",()=>{
  const proxy={execute(){throw Error("NO_TOQUE_DB");},transaction(){throw Error("NO_TOQUE_DB");}};
  for(const v of [
    {},{HOGARSTOCK_V3_SANDBOX:"1"},
    {...entorno,TURSO_DATABASE_URL:"libsql://real.turso.io"},
    {...entorno,TURSO_AUTH_TOKEN:"TOKEN_FICTICIO"},
    {...entorno,HOGARSTOCK_STAGING_TURSO_URL:"libsql://stage.turso.io"},
    {...entorno,HOGARSTOCK_V3_REMOTE_STAGE:"1"},
    {...entorno,HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
    {...entorno,WA_MASTER_KEY:"FICTICIA"},
  ]) assert.throws(()=>crearRepositorInventarioV3({
    cliente:proxy,entorno:v,
  }),/V3_REPOSICION_SOLO_SANDBOX/);
});
test("Compra abierta no permite siquiera informe de reposicion",async t=>{
  const e=await escenario(t);
  await assert.rejects(e.rep.preparar({compraId:e.compraId}),/COMPRA_NO_FINALIZADA/);
  assert.equal(await e.agotado(1),1);
});
test("Compra finalizada completa: solo despues de autorizacion limpia el catalogo",async t=>{
  const e=await escenario(t);
  await e.marcar(1); await e.marcar(2); await e.marcar(3);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const informe=await e.rep.preparar({compraId:e.compraId});
  assert.equal(informe.soloLectura,true);
  assert.equal(informe.resumen.reponibles,3);
  assert.equal(await e.agotado(1),1);
  await assert.rejects(e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:informe.huella,
  }),/CONFIRMACION_REQUERIDA/);
  const r=await e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:informe.huella,confirmacion:true,
  });
  assert.equal(r.numeroAplicados,3);
  assert.deepEqual(r.aplicados,[1,2,3]);
  for(const id of [1,2,3]) assert.equal(await e.agotado(id),0);
  assert.equal(await e.agotado(4),1);
  assert.equal(await e.bitacora(),3);
  assert.equal((await e.datos()).estado,"finalizada");
});
test("Finalizada con faltantes: solo se reponen lineas compradas",async t=>{
  const e=await escenario(t);
  await e.marcar(1,"comprado");
  await e.marcar(2,"no_disponible");
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  assert.equal(i.resumen.reponibles,1);
  assert.deepEqual(i.lineas.map(x=>x.decision),[
    "REPONIBLE","NO_COMPRADO","NO_COMPRADO",
  ]);
  const r=await e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:i.huella,confirmacion:true,
  });
  assert.equal(r.numeroAplicados,1);
  assert.equal(await e.agotado(1),0);
  assert.equal(await e.agotado(2),1);
  assert.equal(await e.agotado(3),1);
});
test("Producto compartido con otra compra abierta no se repone",async t=>{
  const e=await escenario(t);
  const otra=(await e.compras.crearCompra({lineas:[{productoId:1}]})).compraId;
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  assert.equal(i.lineas[0].decision,"COMPRA_ABIERTA_COMPARTIDA");
  assert.equal(i.resumen.reponibles,0);
  const r=await e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:i.huella,confirmacion:true,
  });
  assert.equal(r.numeroAplicados,0);
  assert.equal(await e.agotado(1),1);
  await e.compras.finalizarCompra({compraId:otra});
  const i2=await e.rep.preparar({compraId:e.compraId});
  assert.equal(i2.lineas[0].decision,"REPONIBLE");
  await e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i2.huella,confirmacion:true});
  assert.equal(await e.agotado(1),0);
});
test("Informe desactualizado por nueva compra abierta aborta sin escribir",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.compras.crearCompra({lineas:[{productoId:1}]});
  await assert.rejects(e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:i.huella,confirmacion:true,
  }),/DESACTUALIZADA/);
  assert.equal(await e.agotado(1),1);
  assert.equal(await e.bitacora(),0);
});
test("Informe desactualizado por cambio de necesidad aborta",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.db.execute("UPDATE productos SET agotado=0 WHERE id=1");
  await assert.rejects(e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:i.huella,confirmacion:true,
  }),/DESACTUALIZADA/);
  assert.equal(await e.bitacora(),0);
});
test("Conciliacion repetida no borra una nueva necesidad sobre el producto",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true});
  assert.equal(await e.agotado(1),0);
  await e.db.execute("UPDATE productos SET agotado=1 WHERE id=1");
  const nuevo=await e.rep.preparar({compraId:e.compraId});
  assert.equal(nuevo.lineas[0].decision,"CONCILIADA_ANTERIORMENTE");
  const r=await e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:nuevo.huella,confirmacion:true,
  });
  assert.equal(r.numeroAplicados,0);
  assert.equal(await e.agotado(1),1);
  assert.equal(await e.bitacora(),1);
});
test("Reapertura del servicio no pierde registro de conciliaciones",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true});
  const nuevo=crearRepositorInventarioV3({cliente:e.db,entorno});
  await nuevo.init();
  assert.equal((await nuevo.preparar({compraId:e.compraId})).lineas[0].decision,
    "CONCILIADA_ANTERIORMENTE");
  assert.equal(await e.bitacora(),1);
});
test("Fallo de bitacora revierte actualizacion de catalogo atomicamente",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.db.execute("CREATE TRIGGER hs_test_fallo_auditoria BEFORE INSERT ON hogarstock_reposiciones_v3 BEGIN SELECT RAISE(ABORT,'TEST_ROLLBACK'); END");
  await assert.rejects(e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true}),/TEST_ROLLBACK/);
  assert.equal(await e.agotado(1),1);
  assert.equal(await e.bitacora(),0);
});
test("Catalogo sin producto: no inventa reposicion ni toca otros",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  await e.db.execute("DELETE FROM productos WHERE id=1");
  const i=await e.rep.preparar({compraId:e.compraId});
  assert.equal(i.lineas[0].decision,"PRODUCTO_INEXISTENTE");
  const r=await e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true});
  assert.equal(r.numeroAplicados,0);
  assert.equal(await e.agotado(2),1);
});
test("Permite auditar escenarios del informe original sin alterarlo",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const conc=crearConciliadorCompras(e.db);
  const informe=await conc.informeCompraFinalizada({compraId:e.compraId});
  assert.equal(informe.soloLectura,true);
  assert.equal(informe.lineas[0].codigo,"REVISION_ADMINISTRADOR");
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true});
  const despues=await conc.informeCompraFinalizada({compraId:e.compraId});
  assert.equal(despues.lineas[0].codigo,"YA_NO_AGOTADO");
});
test("Huella invalida, ID invalido y envio sin init se rechazan",async t=>{
  const e=await escenario(t);
  await assert.rejects(e.rep.preparar({compraId:0}),/COMPRA_INVALIDA/);
  await assert.rejects(e.rep.aplicar({
    compraId:e.compraId,confirmacion:true,huellaEsperada:"incorrecta",
  }),/HUELLA_INVALIDA/);
  const rep2=crearRepositorInventarioV3({cliente:e.db,entorno});
  await assert.rejects(rep2.preparar({compraId:e.compraId}),
    /NO_INICIALIZADA/);
});

test("El contador monotónico detecta ABA 1-0-1 después del informe",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const antes=await e.rep.preparar({compraId:e.compraId});
  const version0=antes.lineas[0].versionProducto;
  await e.db.execute("UPDATE productos SET agotado=0 WHERE id=1");
  await e.db.execute("UPDATE productos SET agotado=1 WHERE id=1");
  const despues=await e.rep.preparar({compraId:e.compraId});
  assert.equal(despues.lineas[0].versionProducto,version0+2);
  assert.notEqual(despues.huella,antes.huella);
  await assert.rejects(e.rep.aplicar({
    compraId:e.compraId,huellaEsperada:antes.huella,confirmacion:true,
  }),/DESACTUALIZADA/);
  assert.equal(await e.agotado(1),1);
  assert.equal(await e.bitacora(),0);
});
test("Los cambios directos del catálogo incrementan revisión; no-op no incrementa",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const inicio=(await e.rep.preparar({compraId:e.compraId})).lineas[0].versionProducto;
  await e.db.execute("UPDATE productos SET nombre='Otro nombre FICTICIO' WHERE id=1");
  await e.db.execute("UPDATE productos SET agotado=1 WHERE id=1");
  const nuevo=(await e.rep.preparar({compraId:e.compraId})).lineas[0].versionProducto;
  assert.equal(nuevo,inicio+1);
});
test("Borrado y recreación con mismo ID invalidan informe antiguo",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  const i=await e.rep.preparar({compraId:e.compraId});
  await e.db.execute("DELETE FROM productos WHERE id=1");
  await e.db.execute("INSERT INTO productos(id,nombre,categoria,agotado) VALUES(1,'Recreado FICTICIO','Ensayo',1)");
  const segundo=await e.rep.preparar({compraId:e.compraId});
  assert.ok(segundo.lineas[0].versionProducto>=i.lineas[0].versionProducto+2);
  await assert.rejects(e.rep.aplicar({compraId:e.compraId,
    huellaEsperada:i.huella,confirmacion:true}),/DESACTUALIZADA/);
});
test("La version de catálogo persiste al reinicializar el servicio",async t=>{
  const e=await escenario(t);
  await e.marcar(1);
  await e.compras.finalizarCompra({compraId:e.compraId});
  await e.db.execute("UPDATE productos SET agotado=0 WHERE id=1");
  await e.db.execute("UPDATE productos SET agotado=1 WHERE id=1");
  const i=await e.rep.preparar({compraId:e.compraId});
  const segundo=crearRepositorInventarioV3({cliente:e.db,entorno});
  await segundo.init();
  const b=await segundo.preparar({compraId:e.compraId});
  assert.equal(b.lineas[0].versionProducto,i.lineas[0].versionProducto);
  assert.equal(b.huella,i.huella);
});
