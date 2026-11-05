"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {randomBytes}=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearRegistroWhatsApp}=require("../whatsapp/outbox-store.js");

async function entorno(t){
 const carpeta=mkdtempSync(join(tmpdir(),"hs-wa-outbox-")),url="file:"+join(carpeta,"test.sqlite");
 const conexiones=[];
 const abrir=()=>{const c=createClient({url});conexiones.push(c);return c;};
 const cliente=abrir(),claveHex=randomBytes(32).toString("hex");
 let tiempo=1000000;
 t.after(()=>{for(const c of conexiones)c.close();rmSync(carpeta,{recursive:true,force:true});});
 const nuevo=async (c=cliente,key=claveHex)=>{
  const registro=crearRegistroWhatsApp({cliente:c,claveHex:key,reloj:()=>tiempo});
  await registro.init();return registro;
 };
 return {cliente,abrir,claveHex,nuevo,avanzar:ms=>{tiempo+=ms}};
}
const solicitud={claveIdempotencia:"compra-7-lista-inicial",telefono:"+34 600 111 222",
 mensaje:"Lista de prueba: leche, huevos",compraId:7};

test("Crear solicitud guarda metadatos pero no texto ni telefono en claro",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const x=await r.registrarSolicitud(solicitud);
 assert.equal(x.creada,true);assert.equal(x.estado,"pendiente");
 const row=(await e.cliente.execute("SELECT * FROM hogarstock_wa_outbox_v3")).rows[0];
 assert.equal(row.estado,"pendiente");assert.equal(row.compra_id,7);
 assert.doesNotMatch(JSON.stringify(row),/600111222|Lista de prueba|leche, huevos|compra-7-lista-inicial/);
 const publico=await r.obtener(x.id);
 assert.equal(Object.hasOwn(publico,"telefono"),false);
 assert.equal(Object.hasOwn(publico,"mensaje"),false);
});
test("Idempotencia estable entre conexiones; colision con distinto contenido se rechaza",async t=>{
 const e=await entorno(t),a=await e.nuevo();
 const primero=await a.registrarSolicitud(solicitud);
 const b=await e.nuevo(e.abrir());
 const repetido=await b.registrarSolicitud(solicitud);
 assert.equal(repetido.creada,false);assert.equal(repetido.id,primero.id);
 await assert.rejects(b.registrarSolicitud({...solicitud,mensaje:"Contenido cambiado"}),/WA_IDEMPOTENCIA_CONFLICTO/);
 assert.equal(Number((await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_wa_outbox_v3")).rows[0].n),1);
});
test("Solo un proceso reclama el envio; una recuperacion no reenvia",async t=>{
 const e=await entorno(t),a=await e.nuevo(),b=await e.nuevo(e.abrir());
 const x=await a.registrarSolicitud(solicitud);
 const [p,q]=await Promise.all([a.reclamarEnvio(x.id),b.reclamarEnvio(x.id)]);
 assert.equal([p,q].filter(v=>v.adquirido).length,1);
 assert.equal([p,q].find(v=>v.adquirido).mensaje,solicitud.mensaje);
 e.avanzar(61000);
 const marcado=await a.recuperarIntentosInterrumpidos({antiguedadMs:60000});
 assert.equal(marcado.marcadasIndeterminadas,1);
 assert.equal((await b.obtener(x.id)).estado,"indeterminado");
 assert.equal((await a.reclamarEnvio(x.id)).adquirido,false);
});
test("Proveedor acepto no implica entrega; acuse verificable avanza, duplicado no",async t=>{
 const e=await entorno(t),a=await e.nuevo();
 const x=await a.registrarSolicitud(solicitud);
 await a.reclamarEnvio(x.id);
 const aceptado=await a.registrarResultado({id:x.id,estado:"aceptado_por_proveedor",
  codigo:"WA_PROVEEDOR_ACEPTO_SOLICITUD",proveedorId:"FAKEID12345"});
 assert.equal(aceptado.estado,"aceptado_proveedor");
 assert.equal((await a.obtener(x.id)).entregadoEn,null);
 assert.equal((await a.registrarAcuse({telefono:"34699999999",proveedorId:"FAKEID12345",tipo:"entregado"})).actualizado,false);
 assert.equal((await a.registrarAcuse({telefono:"34600111222",proveedorId:"FAKEID12345",tipo:"entregado"})).actualizado,true);
 assert.equal((await a.registrarAcuse({telefono:"34600111222",proveedorId:"FAKEID12345",tipo:"entregado"})).actualizado,false);
 assert.equal((await a.registrarAcuse({telefono:"34600111222",proveedorId:"FAKEID12345",tipo:"leido"})).actualizado,true);
 assert.equal((await a.obtener(x.id)).estado,"confirmado_lectura");
 assert.equal((await a.registrarAcuse({telefono:"34600111222",proveedorId:"FAKEID12345",tipo:"entregado"})).actualizado,false);
});
test("Error de envio ambiguo permanece indeterminado sin reintento",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const x=await r.registrarSolicitud(solicitud);await r.reclamarEnvio(x.id);
 await r.registrarResultado({id:x.id,estado:"indeterminado",codigo:"WA_ENVIO_NO_VERIFICABLE"});
 assert.equal((await r.obtener(x.id)).estado,"indeterminado");
 await assert.rejects(r.registrarResultado({id:x.id,estado:"aceptado_por_proveedor",
  proveedorId:"FAKEID12345"}),/WA_TRANSICION_INVALIDA/);
 assert.equal((await r.reclamarEnvio(x.id)).adquirido,false);
});
test("No conectado puede regresar a pendiente sin registrar envio",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const x=await r.registrarSolicitud(solicitud);await r.reclamarEnvio(x.id);
 await r.registrarResultado({id:x.id,estado:"no_iniciado",codigo:"WA_NO_CONECTADO"});
 assert.equal((await r.obtener(x.id)).estado,"pendiente");
 assert.equal((await r.reclamarEnvio(x.id)).adquirido,true);
});
test("Clave incorrecta, contenido alterado y esquema incompatible: fallo cerrado",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const x=await r.registrarSolicitud(solicitud);
 const equivocado=await e.nuevo(e.abrir(),randomBytes(32).toString("hex"));
 await assert.rejects(equivocado.reclamarEnvio(x.id),/WA_OUTBOX_NO_DESCIFRABLE/);
 assert.equal((await r.obtener(x.id)).estado,"pendiente");
 await e.cliente.execute({sql:"UPDATE hogarstock_wa_outbox_v3 SET contenido_cifrado=? WHERE id=?",
  args:["datos-danados",x.id]});
 await assert.rejects(r.reclamarEnvio(x.id),/WA_OUTBOX_NO_DESCIFRABLE/);
 assert.equal((await r.obtener(x.id)).estado,"pendiente");
});
test("No se confunden dos compras y no se expone informacion sensible",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const a=await r.registrarSolicitud(solicitud);
 const b=await r.registrarSolicitud({...solicitud,claveIdempotencia:"compra-8-lista-inicial",compraId:8});
 const l7=await r.listarPorCompra({compraId:7});
 const l8=await r.listarPorCompra({compraId:8});
 assert.deepEqual(l7.map(v=>v.id),[a.id]);assert.deepEqual(l8.map(v=>v.id),[b.id]);
 assert.equal(JSON.stringify(l7).includes("leche"),false);
 await assert.rejects(r.registrarSolicitud({...solicitud,telefono:"abc"}),/WA_DESTINATARIO_INVALIDO/);
});
test("No permite reutilizar un identificador de proveedor asociado a otro mensaje",async t=>{
 const e=await entorno(t),r=await e.nuevo();
 const a=await r.registrarSolicitud(solicitud);
 const b=await r.registrarSolicitud({...solicitud,claveIdempotencia:"otro-intento"});
 await r.reclamarEnvio(a.id);await r.reclamarEnvio(b.id);
 await r.registrarResultado({id:a.id,estado:"aceptado_por_proveedor",proveedorId:"PROVIDER-01"});
 await assert.rejects(r.registrarResultado({id:b.id,estado:"aceptado_por_proveedor",
  proveedorId:"PROVIDER-01"}));
 assert.equal((await r.obtener(b.id)).estado,"en_envio");
});
