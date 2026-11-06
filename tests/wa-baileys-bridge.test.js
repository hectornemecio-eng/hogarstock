"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {EventEmitter}=require("node:events");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {randomBytes}=require("node:crypto");
const {crearPuenteBaileysV3}=require("../whatsapp/baileys-bridge.js");

async function escenario(t,{modo="sin_red",entorno={},versionOK=true}={}){
 const dir=mkdtempSync(join(tmpdir(),"hs-baileys-bridge-"));
 const ruta=join(dir,"auth.sqlite");
 const cliente=createClient({url:"file:"+ruta});
 t.after(()=>{cliente.close();rmSync(dir,{recursive:true,force:true});});
 const eventos=[],recibidos=[],sockets=[];
 let versiones=0,creados=0;
 const biblioteca={
  initAuthCreds:()=>({registrationId:42}),
  BufferJSON:{replacer(_k,v){return v},reviver(_k,v){return v}},
  proto:{Message:{AppStateSyncKeyData:{fromObject:x=>x}}},
  logger:{child(){return this}},
  makeWASocket(options){
   creados++;
   const ev=new EventEmitter();
   const sock={ev,options,sendMessage:async()=>({key:{id:"MOCK1234"}}),
    end(){eventos.push("socket_cerrado");}};
   sockets.push(sock);
   return sock;
  },
 };
 const puente=crearPuenteBaileysV3({
  cliente,urlBaseDatos:"file:"+ruta,claveMaestraHex:randomBytes(32).toString("hex"),
  bandeja:{async recibir(x){recibidos.push(x);}},
  cargarBiblioteca:async()=>biblioteca,
  consultarVersionWeb:async()=>{
   versiones++;return versionOK?{version:[2,3000,100],isLatest:true}:{version:[0],isLatest:false};
  },
  modo,entorno,
 });
 return {puente,cliente,recibidos,sockets,eventos,
   get creados(){return creados},get versiones(){return versiones}};
}
test("Preparación sin red verifica auth sin crear sockets ni consultar versión",async t=>{
 const e=await escenario(t);
 const estado=await e.puente.comprobarSinRed();
 assert.deepEqual(estado,{modo:"sin_red",autenticacionPreparada:true,
  socketCreado:false,whatsappConectado:false});
 assert.equal(e.creados,0);assert.equal(e.versiones,0);
 const tablas=await e.cliente.execute("PRAGMA table_info(hogarstock_wa_auth_v3)");
 assert.ok(tablas.rows.length>0);
 await assert.rejects(e.puente.consultarVersion(),/WA_PUENTE_RED_DESHABILITADA/);
 await assert.rejects(e.puente.fabricaSocket({auth:{},version:[2,3,4]}),/WA_PUENTE_RED_DESHABILITADA/);
});
test("Modo de conexión exige sandbox, autorización expresa y no admite Turso",async t=>{
 const e=await escenario(t);
 const opts={cliente:e.cliente,urlBaseDatos:"file:/tmp/prueba.sqlite",
  claveMaestraHex:randomBytes(32).toString("hex"),
  bandeja:{recibir:async()=>{}},cargarBiblioteca:async()=>({}),
  consultarVersionWeb:async()=>({version:[2,3000,1],isLatest:true}),
  modo:"conexion"};
 for(const entorno of [{},{HOGARSTOCK_V3_SANDBOX:"1"},
  {HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_WHATSAPP_LIVE:"1",TURSO_AUTH_TOKEN:"FICTICIO"}]){
  assert.throws(()=>crearPuenteBaileysV3({...opts,entorno}),/WA_PUENTE_CONEXION_NO_AUTORIZADA/);
 }
 assert.throws(()=>crearPuenteBaileysV3({...opts,urlBaseDatos:"libsql://remoto",
  entorno:{HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_WHATSAPP_LIVE:"1"}}),
  /WA_PUENTE_REQUIERE_SQLITE_LOCAL/);
});
test("Versión no verificada no abre socket",async t=>{
 const e=await escenario(t,{modo:"conexion",versionOK:false,
  entorno:{HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_WHATSAPP_LIVE:"1"}});
 await assert.rejects(e.puente.consultarVersion(),/WA_PUENTE_VERSION_NO_VERIFICADA/);
 assert.equal(e.creados,0);
});
test("Simulación de conexión: filtra entrada, no imprime QR, y elimina listeners al cerrar",async t=>{
 const e=await escenario(t,{modo:"conexion",
  entorno:{HOGARSTOCK_V3_SANDBOX:"1",HOGARSTOCK_V3_WHATSAPP_LIVE:"1"}});
 const auth=await e.puente.crearAuth(),v=await e.puente.consultarVersion();
 const sock=await e.puente.fabricaSocket({auth:auth.state,version:v.version});
 assert.equal(e.creados,1);
 assert.equal(sock.options.printQRInTerminal,false);
 assert.equal(sock.options.syncFullHistory,false);
 assert.equal(sock.options.markOnlineOnConnect,false);
 sock.ev.emit("messages.upsert",{type:"notify",messages:[{
  key:{remoteJid:"34600111222@s.whatsapp.net",id:"FAKEmessage99",fromMe:false},
  message:{conversation:"COMPRADO 1"},
 }]});
 await new Promise(setImmediate);
 assert.deepEqual(e.recibidos,[{telefono:"34600111222",mensajeId:"FAKEmessage99",texto:"COMPRADO 1"}]);
 sock.end();
 sock.ev.emit("messages.upsert",{type:"notify",messages:[{
  key:{remoteJid:"34600111222@s.whatsapp.net",id:"FAKEmessage10",fromMe:false},
  message:{conversation:"COMPRADO 2"},
 }]});
 await new Promise(setImmediate);
 assert.equal(e.recibidos.length,1);
 assert.equal(e.eventos.filter(v=>v==="socket_cerrado").length,1);
 await e.puente.detenerEntradas();
});
test("Dependencia Baileys incompatible falla antes de crear sesión",async t=>{
 const e=await escenario(t);
 const puente=crearPuenteBaileysV3({
  cliente:e.cliente,urlBaseDatos:"file:/tmp/ficticia.sqlite",
  claveMaestraHex:randomBytes(32).toString("hex"),
  bandeja:{recibir:async()=>{}},
  cargarBiblioteca:async()=>({}),
  consultarVersionWeb:async()=>({version:[2,3000,1],isLatest:true}),
 });
 await assert.rejects(puente.comprobarSinRed(),/WA_PUENTE_BAILEYS_INCOMPATIBLE/);
 assert.equal(e.creados,0);
});
