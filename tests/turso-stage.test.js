"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes}=require("node:crypto");
const {mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {validarDestinoEnsayo,crearClienteRemotoEnsayo,
  inspeccionarBaseSoloLectura}=require("../integration/turso-stage-guard.js");
const {inicializarEnsayoV3,iniciarModulosV3}=require("../integration/turso-stage-bootstrap.js");

const host="hogarstock-v3-test-ficticio-org.turso.io";
const produccion="hogarstock-org.turso.io";
const token="TOKEN_FICTICIO_DE_ENSAYO_NO_AUTENTICO";
const destino={host,verificado:true};
const secretos=()=>({
 auth:randomBytes(32).toString("hex"),
 outbox:randomBytes(32).toString("hex"),
 inbox:randomBytes(32).toString("hex"),
});
async function fixture(t){
 const carpeta=mkdtempSync(join(tmpdir(),"hs-turso-staging-"));
 const url="file:"+join(carpeta,"stage.sqlite");
 const conexiones=[];
 const abrir=()=>{const c=createClient({url});conexiones.push(c);return c;};
 t.after(()=>{for(const c of conexiones)c.close();rmSync(carpeta,{recursive:true,force:true});});
 return {cliente:abrir(),abrir};
}
test("Preflight de Turso: no abre conexión salvo permiso explícito",()=>{
 let aperturas=0;
 const args={url:"libsql://"+host,hostEsperado:host,
  hostProduccion:produccion,authToken:token,crearCliente:()=>{
   aperturas++;return {execute(){},batch(){},transaction(){}};
  }};
 assert.deepEqual(validarDestinoEnsayo(args),{host,verificado:true});
 assert.throws(()=>crearClienteRemotoEnsayo(args),/STAGING_RED_BLOQUEADA/);
 assert.equal(aperturas,0);
 const r=crearClienteRemotoEnsayo({...args,permitirRed:true});
 assert.equal(aperturas,1);
 assert.equal(r.host,host);
});
test("Preflight bloquea URL de producción, host inesperado, alias y credenciales inválidas",()=>{
 const base={url:"libsql://"+host,hostEsperado:host,
  hostProduccion:produccion,authToken:token};
 for(const variacion of [
  {url:"libsql://"+produccion},
  {url:"https://"+produccion},
  {url:"libsql://otro-v3-test-org.turso.io"},
  {url:"libsql://"+host+"/prod"},
  {url:"https://"+host+"?authToken=secreto"},
  {url:"http://"+host},
  {url:"libsql://"+host+":1234"},
  {hostEsperado:produccion},
  {hostProduccion:host},
  {authToken:"123"},
 ]){
  assert.throws(()=>validarDestinoEnsayo({...base,...variacion}));
 }
});
test("Inspección es de solo lectura y únicamente devuelve nombres de tablas",async(t)=>{
 const e=await fixture(t);
 assert.deepEqual(await inspeccionarBaseSoloLectura(e.cliente),{vacia:true,tablas:[]});
 await e.cliente.execute("CREATE TABLE tabla_sintetica(id INTEGER)");
 const r=await inspeccionarBaseSoloLectura(e.cliente);
 assert.deepEqual(r,{vacia:false,tablas:["tabla_sintetica"]});
});
test("Solo se inicializa un destino verificado y con tres claves diferentes",async(t)=>{
 const e=await fixture(t);
 for(const opciones of [
  {confirmacion:false,destino,secretos:secretos()},
  {confirmacion:true,destino:{host:"produccion.turso.io",verificado:true},secretos:secretos()},
  {confirmacion:true,destino,secretos:{auth:"x",outbox:"y",inbox:"z"}},
 ]){
  await assert.rejects(inicializarEnsayoV3({cliente:e.cliente,...opciones}));
 }
 const tablas=await inspeccionarBaseSoloLectura(e.cliente);
 assert.equal(tablas.vacia,true);
 const k=secretos();
 await assert.rejects(inicializarEnsayoV3({cliente:e.cliente,confirmacion:true,
  destino,secretos:{auth:k.auth,outbox:k.auth,inbox:k.inbox}}),
 /STAGING_SECRETOS_REUTILIZADOS/);
 assert.equal((await inspeccionarBaseSoloLectura(e.cliente)).vacia,true);
});
test("Ensayo V3 completo crea únicamente datos ficticios y esquemas V3",async(t)=>{
 const e=await fixture(t);
 const k=secretos();
 const r=await inicializarEnsayoV3({
  cliente:e.cliente,confirmacion:true,destino,secretos:k,
 });
 assert.equal(r.productosFicticios,3);
 assert.ok(r.tablas.includes("hogarstock_compras_v3"));
 assert.ok(r.tablas.includes("hogarstock_wa_auth_v3"));
 assert.ok(r.tablas.includes("hogarstock_wa_inbox_v3"));
 assert.ok(r.tablas.includes("hogarstock_wa_outbox_v3"));
 const productos=await e.cliente.execute("SELECT nombre FROM productos ORDER BY id");
 assert.deepEqual(productos.rows.map(x=>String(x.nombre)),[
  "Leche FICTICIA","Huevos FICTICIOS","Arroz FICTICIO"]);
 const auth=await e.cliente.execute("SELECT COUNT(*) AS n FROM hogarstock_wa_auth_v3");
 assert.equal(Number(auth.rows[0].n),0,"No guardar autenticación ficticia");
 const b=await r.modulos.compras.crearCompra({lineas:[{productoId:1}]});
 assert.ok(b.compraId>0);
 const out=await r.modulos.outbox.registrarSolicitud({
  claveIdempotencia:"staging-lista-1",telefono:"34600111222",
  mensaje:"Mensaje de PRUEBA, no enviar",compraId:b.compraId,
 });
 assert.equal(out.estado,"pendiente");
 const otra=e.abrir();
 const rep=await iniciarModulosV3({cliente:otra,secretos:k});
 const compra=await rep.compras.obtenerCompra({compraId:b.compraId});
 assert.equal(compra.items.length,1);
 assert.equal((await rep.outbox.obtener(out.id)).estado,"pendiente");
 const reservado=await rep.outbox.reclamarEnvio(out.id);
 assert.equal(reservado.adquirido,true);
 assert.equal(reservado.mensaje,"Mensaje de PRUEBA, no enviar");
 assert.equal((await rep.outbox.obtener(out.id)).estado,"en_envio");
});
test("Una base con cualquier tabla previa se preserva y rechaza inicialización",async(t)=>{
 const e=await fixture(t),k=secretos();
 await e.cliente.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT)");
 await e.cliente.execute("INSERT INTO productos VALUES(1,'CONSERVAR')");
 await assert.rejects(inicializarEnsayoV3({
  cliente:e.cliente,secretos:k,confirmacion:true,destino,
 }),/STAGING_BASE_NO_VACIA_NO_MODIFICADA/);
 const r=await e.cliente.execute("SELECT nombre FROM productos WHERE id=1");
 assert.equal(r.rows[0].nombre,"CONSERVAR");
 assert.deepEqual((await inspeccionarBaseSoloLectura(e.cliente)).tablas,["productos"]);
});
test("Reinicio con secretos incorrectos no destruye mensajes almacenados",async(t)=>{
 const e=await fixture(t),k=secretos();
 const x=await inicializarEnsayoV3({
  cliente:e.cliente,secretos:k,confirmacion:true,destino,
 });
 const op=await x.modulos.outbox.registrarSolicitud({
  claveIdempotencia:"ensayo-operacion",telefono:"34600111222",
  mensaje:"Contenido ficticio privado",compraId:1,
 });
 const nuevo=await iniciarModulosV3({cliente:e.abrir(),secretos:secretos()});
 await assert.rejects(nuevo.outbox.reclamarEnvio(op.id),/WA_OUTBOX_NO_DESCIFRABLE/);
 assert.equal((await x.modulos.outbox.obtener(op.id)).estado,"pendiente");
});
