"use strict";

// Inicializador ÚNICAMENTE de una base de ensayo V3 vacía.
// No importa db.js ni reutiliza catálogo, compras o secretos de producción.
// No contiene DROP, DELETE ni migraciones destructivas.

const {crearAlmacenCompras}=require("../compras/store.js");
const {crearAlmacenSeguridad}=require("../security/store.js");
const {crearSesionesComprador}=require("../security/buyer-sessions.js");
const {crearEstadoBaileysCifrado}=require("../whatsapp/auth-store.js");
const {crearRegistroWhatsApp}=require("../whatsapp/outbox-store.js");
const {crearBandejaWhatsApp}=require("../whatsapp/inbox-store.js");
const {crearAplicadorWhatsApp}=require("../whatsapp/apply-proposal.js");
const {inspeccionarBaseSoloLectura}=require("./turso-stage-guard.js");

const PRODUCTOS_FICTICIOS=Object.freeze([
 ["Leche FICTICIA","Lácteos"],
 ["Huevos FICTICIOS","Lácteos"],
 ["Arroz FICTICIO","Despensa"],
]);

function validarSecretos(secretos) {
 if (!secretos || typeof secretos!=="object") {
  throw new Error("STAGING_SECRETOS_AUSENTES");
 }
 const nombres=["auth","outbox","inbox"];
 const valores=nombres.map(n=>{
  const v=secretos[n];
  if(typeof v!=="string"||!/^[a-fA-F0-9]{64}$/.test(v)){
   throw new Error("STAGING_SECRETO_INVALIDO:"+n);
  }
  return v.toLowerCase();
 });
 if(new Set(valores).size!==3)throw new Error("STAGING_SECRETOS_REUTILIZADOS");
 return {auth:valores[0],outbox:valores[1],inbox:valores[2]};
}

async function iniciarModulosV3({cliente,secretos}) {
 const k=validarSecretos(secretos);
 if(!cliente||typeof cliente.execute!=="function"||
  typeof cliente.batch!=="function"||typeof cliente.transaction!=="function"){
  throw new TypeError("STAGING_CLIENTE_INCOMPATIBLE");
 }
 const compras=crearAlmacenCompras(cliente);
 await compras.init();
 const seguridad=crearAlmacenSeguridad(cliente);
 await seguridad.init();
 const sesiones=crearSesionesComprador({cliente});
 await sesiones.init();
 const outbox=crearRegistroWhatsApp({cliente,claveHex:k.outbox});
 await outbox.init();
 const inbox=crearBandejaWhatsApp({
  cliente,compras,claveHmacHex:k.inbox,
 });
 await inbox.init();
 const aplicador=crearAplicadorWhatsApp({cliente});
 await aplicador.init();
 // Solo inicializar el esquema, NO persistir credenciales de prueba que
 // pudieran confundirse con una vinculación WhatsApp real.
 await crearEstadoBaileysCifrado({
  cliente,masterKeyHex:k.auth,
  BufferJSON:{replacer:(_key,value)=>value,reviver:(_key,value)=>value},
  initAuthCreds:()=>({ensayoLocal:true}),
 });
 return Object.freeze({compras,seguridad,sesiones,outbox,inbox,aplicador});
}

async function inicializarEnsayoV3({
 cliente, secretos, confirmacion=false, destino,
}={}){
 // Esta función es exclusivamente para una DB dedicada, ya verificada
 // por el preflight. No debe llamarse en cada arranque.
 if(confirmacion!==true || !destino?.verificado ||
    !/^hogarstock-v3-test-[a-z0-9-]+\.turso\.io$/.test(destino.host||"")){
  throw new Error("STAGING_ESCRITURA_NO_AUTORIZADA");
 }
 validarSecretos(secretos);
 const antes=await inspeccionarBaseSoloLectura(cliente);
 if(!antes.vacia)throw new Error("STAGING_BASE_NO_VACIA_NO_MODIFICADA");
 // La creación y la carga de tres productos sintéticos se hacen en lote.
 const sentencias=[
  "CREATE TABLE productos ("+
   "id INTEGER PRIMARY KEY AUTOINCREMENT,"+
   "nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
  ...PRODUCTOS_FICTICIOS.map(([n,c])=>({
   sql:"INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,?)",
   args:[n,c,1],
  })),
 ];
 await cliente.batch(sentencias,"write");
 const modulos=await iniciarModulosV3({cliente,secretos});
 const despues=await inspeccionarBaseSoloLectura(cliente);
 const conteo=await cliente.execute("SELECT COUNT(*) AS n FROM productos");
 if(Number(conteo.rows[0]?.n)!==PRODUCTOS_FICTICIOS.length){
  throw new Error("STAGING_CATALOGO_FICTICIO_INCORRECTO");
 }
 return Object.freeze({
  creado:true, productosFicticios:PRODUCTOS_FICTICIOS.length,
  tablas:despues.tablas, modulos,
 });
}

module.exports={inicializarEnsayoV3,iniciarModulosV3,validarSecretos};
