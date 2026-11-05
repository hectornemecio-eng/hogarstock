"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createClient} = require("@libsql/client");
const {mkdtempSync,rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {randomBytes} = require("node:crypto");
const {crearEstadoBaileysCifrado} = require("../whatsapp/auth-store.js");

const MASTER = randomBytes(32).toString("hex");
// Codec simulador con semantica binaria comparable a BufferJSON.
// La compatibilidad con el BufferJSON real se comprueba por separado.
const codec = {
 replacer(_k,value){
  if(Buffer.isBuffer(value))return {__fakeBuffer:value.toString("base64")};
  return value;
 },
 reviver(_k,value){
  if(value && value.__fakeBuffer)return Buffer.from(value.__fakeBuffer,"base64");
  return value;
 },
};

async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),"hogarstock-waauth-"));
 const path=join(dir,"auth.sqlite");
 const conexiones=[];
 function nuevaConexion() {const c=createClient({url:"file:"+path});conexiones.push(c);return c;}
 const cliente=nuevaConexion();
 t.after(async()=>{for(const c of conexiones)c.close();rmSync(dir,{recursive:true,force:true});});
 return {cliente,nuevaConexion};
}
async function abrir(cliente,key=MASTER,opts={}) {
 return crearEstadoBaileysCifrado({
  cliente,masterKeyHex:key,
  BufferJSON:codec,
  initAuthCreds:()=>({registrationId:7788,me:{id:"ficticio@s.whatsapp.net"},key:{type:"Buffer",data:[1,2]}}),
  ...opts,
 });
}
test("Sin clave correcta o sin cliente valido falla cerrado",async(t)=>{
 const e=await fixture(t);
 await assert.rejects(abrir(e.cliente,"abc"),/WA_MASTER_KEY_INVALIDA/);
 await assert.rejects(crearEstadoBaileysCifrado({
  cliente:null,masterKeyHex:MASTER,BufferJSON:codec,initAuthCreds:()=>({})
 }),/Cliente libSQL incompleto/);
});
test("Credenciales se cifran y persisten tras nueva conexion",async(t)=>{
 const e=await fixture(t);
 const a=await abrir(e.cliente);
 a.state.creds.registrationId=9900;
 a.state.creds.me.id="contacto-ficticio@s.whatsapp.net";
 await a.saveCreds();
 const raw=await e.cliente.execute("SELECT contenido FROM hogarstock_wa_auth_v3 WHERE tipo='creds'");
 assert.equal(raw.rows.length,1);
 assert.doesNotMatch(String(raw.rows[0].contenido),/contacto-ficticio|registrationId/);
 const b=await abrir(e.nuevaConexion());
 assert.equal(b.state.creds.registrationId,9900);
 assert.equal(b.state.creds.me.id,"contacto-ficticio@s.whatsapp.net");
});
test("Claves Signal set/get/delete y restauracion desde segunda instancia",async(t)=>{
 const e=await fixture(t);
 const a=await abrir(e.cliente);
 await a.state.keys.set({
  session:{"1.0":{name:"ficticia",n:9},"2.0":{n:10}},
  "app-state-sync-key":{"key-1":{value:"datos-ficticios"}},
 });
 const b=await abrir(e.nuevaConexion());
 const leidas=await b.state.keys.get("session",["1.0","2.0","3.0"]);
 assert.equal(leidas["1.0"].name,"ficticia");
 assert.equal(leidas["2.0"].n,10);
 assert.equal(leidas["3.0"],undefined);
 await b.state.keys.set({session:{"1.0":null}});
 assert.equal((await a.state.keys.get("session",["1.0"]))["1.0"],undefined);
 assert.equal((await a.state.keys.get("app-state-sync-key",["key-1"]))["key-1"].value,"datos-ficticios");
});
test("Clave maestra equivocada: no reconstruye credenciales por encima de datos existentes",async(t)=>{
 const e=await fixture(t);
 const a=await abrir(e.cliente);
 await a.saveCreds();
 const mal=randomBytes(32).toString("hex");
 await assert.rejects(abrir(e.nuevaConexion(),mal),/WA_AUTH_NO_DESCIFRABLE/);
 const b=await abrir(e.nuevaConexion());
 assert.equal(b.state.creds.registrationId,7788);
});
test("No permite trasplantar ciphertext de un registro a otro (AAD)",async(t)=>{
 const e=await fixture(t);
 const a=await abrir(e.cliente);
 await a.state.keys.set({session:{"uno":{valor:"sensible"},"dos":{valor:"distinto"}}});
 const filas=await e.cliente.execute({
  sql:"SELECT contenido FROM hogarstock_wa_auth_v3 WHERE tipo=? AND identificador=?",
  args:["session","uno"],
 });
 await e.cliente.execute({
  sql:"UPDATE hogarstock_wa_auth_v3 SET contenido=? WHERE tipo=? AND identificador=?",
  args:[filas.rows[0].contenido,"session","dos"],
 });
 await assert.rejects(a.state.keys.get("session",["dos"]),/WA_AUTH_NO_DESCIFRABLE/);
});
test("Borrados y actualizaciones Signal se ejecutan en lote atomico",async(t)=>{
 const e=await fixture(t);const a=await abrir(e.cliente);
 await a.state.keys.set({session:{"primero":{n:1},"segundo":{n:2}}});
 await assert.rejects(a.state.keys.set({
  session:{"primero":{n:999},"segundo":"x".repeat(2*1024*1024+100)},
 }),/WA_DATO_TAMANO_INVALIDO/);
 const resultado=await a.state.keys.get("session",["primero","segundo"]);
 assert.equal(resultado.primero.n,1);
 assert.equal(resultado.segundo.n,2);
});
test("Esquema incompatible conserva la tabla original intacta",async(t)=>{
 const e=await fixture(t);
 await e.cliente.execute("CREATE TABLE hogarstock_wa_auth_v3(tipo TEXT,identificador TEXT,valor_heredado TEXT)");
 await e.cliente.execute({
  sql:"INSERT INTO hogarstock_wa_auth_v3 VALUES(?,?,?)",
  args:["x","y","conservar"],
 });
 await assert.rejects(abrir(e.cliente),/WA_AUTH_ESQUEMA_INCOMPATIBLE/);
 const resultado=await e.cliente.execute("SELECT valor_heredado FROM hogarstock_wa_auth_v3");
 assert.equal(resultado.rows[0].valor_heredado,"conservar");
});
test("No se guardan secretos ni datos cifrados en logs de error",async(t)=>{
 const e=await fixture(t);
 const a=await abrir(e.cliente);
 await a.saveCreds();
 const datos=await e.cliente.execute("SELECT contenido FROM hogarstock_wa_auth_v3 WHERE tipo='creds'");
 await e.cliente.execute({
  sql:"UPDATE hogarstock_wa_auth_v3 SET contenido=? WHERE tipo='creds'",
  args:["datos-corruptos"],
 });
 try { await abrir(e.nuevaConexion());assert.fail("Debe rechazar el contenido corrupto"); }
 catch(err){
  assert.match(err.message,/WA_AUTH_NO_DESCIFRABLE/);
  assert.doesNotMatch(err.message,/datos-corruptos|registrationId/);
 }
 assert.ok(datos.rows.length===1);
});
