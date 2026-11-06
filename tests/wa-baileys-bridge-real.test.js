"use strict";
// Verificación SIN RED con Baileys 7.0.0-rc11 real.
// Prohibido llamar consultarVersion() o fabricaSocket() en esta prueba.
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes}=require("node:crypto");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {crearPuenteBaileysV3}=require("../whatsapp/baileys-bridge.js");
const {cargarBibliotecaBaileysReal,consultarVersionBaileysReal}=
 require("../whatsapp/baileys-loader.js");

test("Baileys fijado carga y prepara autenticacion cifrada sin abrir sockets",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"hs-baileys-offline-real-"));
 const url="file:"+join(dir,"wa.sqlite");
 const cliente=createClient({url});
 t.after(()=>{cliente.close();rmSync(dir,{recursive:true,force:true});});
 const b=await cargarBibliotecaBaileysReal();
 assert.equal(typeof b.makeWASocket,"function");
 assert.equal(typeof b.fetchLatestWaWebVersion,"function");
 assert.equal(b.logger.level,"silent");
 const puente=crearPuenteBaileysV3({
  cliente,urlBaseDatos:url,
  claveMaestraHex:randomBytes(32).toString("hex"),
  bandeja:{async recibir(){throw Error("No debe recibir nada sin socket");}},
  cargarBiblioteca:()=>Promise.resolve(b),
  consultarVersionWeb:consultarVersionBaileysReal,
 });
 const estado=await puente.comprobarSinRed();
 assert.equal(estado.autenticacionPreparada,true);
 assert.equal(estado.whatsappConectado,false);
 assert.equal(estado.socketCreado,false);
 const auth=await puente.crearAuth();
 assert.ok(auth.state.creds.noiseKey?.private);
 await auth.saveCreds();
 const n=await cliente.execute("SELECT COUNT(*) n FROM hogarstock_wa_auth_v3");
 assert.equal(Number(n.rows[0].n),1);
 await assert.rejects(puente.consultarVersion(),/WA_PUENTE_RED_DESHABILITADA/);
 await assert.rejects(puente.fabricaSocket({auth:auth.state,version:[2,3000,1]}),
  /WA_PUENTE_RED_DESHABILITADA/);
});
