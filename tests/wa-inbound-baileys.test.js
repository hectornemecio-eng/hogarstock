"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {crearAdaptadorEntradaBaileys}=require("../whatsapp/inbound-baileys.js");

const plantilla=(texto="COMPRADO 12",overrides={})=>({
 key:{remoteJid:"34600111222@s.whatsapp.net",id:"TESTmsg01",fromMe:false},
 message:{conversation:texto},
 ...overrides,
});
function escenario(){
 const eventos=new EventEmitter(),recibidos=[];
 let fallo=false;
 const bandeja={async recibir(x){if(fallo)throw Error("datos sensibles");recibidos.push(x);return {estado:"pendiente_revision"};}};
 const a=crearAdaptadorEntradaBaileys({eventos,bandeja});
 a.iniciar();
 async function enviar(messages,type="notify"){
  eventos.emit("messages.upsert",{type,messages});
  await a.esperarPendientes();
 }
 return {a,enviar,recibidos,setFallo:x=>{fallo=x;}};
}
test("Acepta solo mensaje individual recibido, notificación nueva y texto simple",async()=>{
 const e=escenario();
 await e.enviar([plantilla()]);
 assert.equal(e.recibidos.length,1);
 assert.deepEqual(e.recibidos[0],{telefono:"34600111222",mensajeId:"TESTmsg01",texto:"COMPRADO 12"});
 assert.equal(e.a.estadisticas().aceptadas,1);
 await e.a.detener();
});
test("Descarta mensajes del propio usuario, grupos, estados, LID y participantes",async()=>{
 const e=escenario();
 for(const msg of [
  plantilla("A",{key:{...plantilla().key,fromMe:true}}),
  plantilla("B",{key:{...plantilla().key,remoteJid:"12345-678@g.us"}}),
  plantilla("C",{key:{...plantilla().key,remoteJid:"status@broadcast"}}),
  plantilla("D",{key:{...plantilla().key,remoteJid:"123456789@lid"}}),
  plantilla("E",{key:{...plantilla().key,participant:"34600999999@s.whatsapp.net"}}),
 ]){
  await e.enviar([msg]);
 }
 assert.equal(e.recibidos.length,0);
 assert.equal(e.a.estadisticas().ignoradas,5);
 await e.a.detener();
});
test("Descarta historial append y lotes sospechosos",async()=>{
 const e=escenario();
 await e.enviar([plantilla()],"append");
 await e.enviar(Array.from({length:101},(_,n)=>plantilla("MENSAJE",{key:{...plantilla().key,id:"M"+String(n).padStart(4,"0")}})));
 assert.equal(e.recibidos.length,0);
 await e.a.detener();
});
test("Acepta extendedTextMessage y contenido efímero sin adjuntos",async()=>{
 const e=escenario();
 await e.enviar([
  plantilla("",{message:{extendedTextMessage:{text:"PENDIENTE 10"}}}),
  plantilla("",{key:{...plantilla().key,id:"EFIMERO99"},
   message:{ephemeralMessage:{message:{conversation:"NO DISPONIBLE 11"}}}}),
 ]);
 assert.deepEqual(e.recibidos.map(x=>x.texto),["PENDIENTE 10","NO DISPONIBLE 11"]);
 await e.a.detener();
});
test("Descarta multimodal, reacciones, protocolo y varios tipos simultáneos",async()=>{
 const e=escenario();
 await e.enviar([
  plantilla("",{message:{imageMessage:{caption:"COMPRADO 1"}}}),
  plantilla("",{message:{reactionMessage:{text:"COMPRADO 1"}}}),
  plantilla("",{message:{protocolMessage:{type:14}}}),
  plantilla("",{message:{conversation:"COMPRADO 1",imageMessage:{}}}),
  plantilla("",{messageStubType:12}),
 ]);
 assert.equal(e.recibidos.length,0);
 await e.a.detener();
});
test("Mensajes sin ID verificable o texto excesivo no pasan a bandeja",async()=>{
 const e=escenario();
 await e.enviar([
  plantilla("A",{key:{...plantilla().key,id:"x"}}),
  plantilla("B",{key:{...plantilla().key,id:"a".repeat(161)}}),
  plantilla("C",{message:{conversation:"x".repeat(4097)}}),
 ]);
 assert.equal(e.recibidos.length,0);
 await e.a.detener();
});
test("No registra secretos ni propaga excepciones del almacén en eventos",async()=>{
 const e=escenario();e.setFallo(true);
 await e.enviar([plantilla()]);
 const stats=e.a.estadisticas();
 assert.deepEqual(stats,{aceptadas:0,ignoradas:0,errores:1});
 assert.equal(JSON.stringify(stats).includes("datos sensibles"),false);
 await e.a.detener();
});
test("Parada elimina el listener e impide procesar eventos nuevos",async()=>{
 const e=escenario();
 await e.enviar([plantilla()]);
 await e.a.detener();
 await e.enviar([plantilla("COMPRADO 99")]);
 assert.equal(e.recibidos.length,1);
 assert.equal(e.a.iniciar(),true);
 await e.enviar([plantilla("COMPRADO 77")]);
 assert.equal(e.recibidos.length,2);
 await e.a.detener();
});
