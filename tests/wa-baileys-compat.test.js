"use strict";
// Test de compatibilidad del adaptador con Baileys 7.0.0-rc11 REAL.
// No crea sockets ni se conecta a WhatsApp. Utiliza SQLite temporal y
// credenciales nuevas ficticias.
const test=require("node:test");
const assert=require("node:assert/strict");
const {createRequire}=require("node:module");
const {pathToFileURL}=require("node:url");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {randomBytes}=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearEstadoBaileysCifrado}=require("../whatsapp/auth-store.js");

async function cargarBaileysReal() {
 const base=process.env.HOGARSTOCK_TEST_DEPS;
 if(!base)throw new Error("Falta HOGARSTOCK_TEST_DEPS");
 const resolver=createRequire(join(base,"package.json"));
 return import(pathToFileURL(resolver.resolve("@whiskeysockets/baileys")).href);
}

test("Baileys real: credenciales, BufferJSON y claves Signal sobreviven a reinicio",async(t)=>{
 const baileys=await cargarBaileysReal();
 assert.equal(typeof baileys.initAuthCreds,"function","initAuthCreds no exportado");
 assert.equal(typeof baileys.BufferJSON?.replacer,"function");
 assert.equal(typeof baileys.BufferJSON?.reviver,"function");
 assert.equal(typeof baileys.proto?.Message?.AppStateSyncKeyData?.fromObject,"function");
 const dir=mkdtempSync(join(tmpdir(),"hs-wa-baileys-real-"));
 const url="file:"+join(dir,"auth.sqlite");
 const a=createClient({url});const b=createClient({url});
 t.after(()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true});});
 const master=randomBytes(32).toString("hex");
 const args={masterKeyHex:master,BufferJSON:baileys.BufferJSON,
   initAuthCreds:baileys.initAuthCreds,
   reviveAppStateSyncKey:baileys.proto.Message.AppStateSyncKeyData.fromObject,
 };
 const primero=await crearEstadoBaileysCifrado({cliente:a,...args});
 assert.equal(typeof primero.state.creds.registrationId,"number");
 assert.ok(primero.state.creds.noiseKey?.private,"No hay noiseKey de Baileys");
 const orig=Buffer.from(primero.state.creds.noiseKey.private);
 await primero.saveCreds();
 await primero.state.keys.set({session:{
  "jid.ficticio.0":new Uint8Array([0,1,128,255])
 }});
 const segundo=await crearEstadoBaileysCifrado({cliente:b,...args});
 assert.deepEqual(Buffer.from(segundo.state.creds.noiseKey.private),orig);
 const values=await segundo.state.keys.get("session",["jid.ficticio.0"]);
 assert.deepEqual(Array.from(values["jid.ficticio.0"]),[0,1,128,255]);
 const crudo=await b.execute("SELECT contenido FROM hogarstock_wa_auth_v3 WHERE tipo='creds'");
 assert.doesNotMatch(String(crudo.rows[0].contenido),/noiseKey|registrationId/);
});
