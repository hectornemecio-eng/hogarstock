"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {crearCoordinadorWhatsApp}=require("../whatsapp/coordinator.js");

function escenario(override={}){
  const conexiones=[];
  const timers=new Map();
  let timerId=0,authCount=0,saveCount=0,versionCount=0;
  let fallarGuardar=false,fallarConexion=false,enviarError=false,respuestaConId=true;
  let receptorPermitido="34600111222";
  const estados=[];
  const socketFactory=async ()=>{
    if(fallarConexion)throw new Error("Error FICTICIO con secreto, nunca debe propagarse");
    const ev=new EventEmitter();
    const s={ev,
      envios:[],
      cerrado:false,
      end(){this.cerrado=true;},
      async sendMessage(jid,contenido){
        this.envios.push({jid,contenido});
        if(enviarError)throw Error("Se desconoce si se envio");
        return respuestaConId?{key:{id:"ID_PRUEBA"}}:{};
      },
    };
    conexiones.push(s);return s;
  };
  const opts={
    crearAuth:async()=>{authCount++;return {state:{creds:{ficticio:true},keys:{}},
      saveCreds:async()=>{saveCount++;if(fallarGuardar)throw Error("Secretos no deben registrarse");}};},
    fabricaSocket:socketFactory,
    consultarVersion:async()=>{versionCount++;return {isLatest:true,version:[2,3000,100]};},
    destinatarioPermitido:async n=>n===receptorPermitido,
    programar:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},
    cancelar:id=>{timers.delete(id);},
    notificarEstado:estado=>estados.push(estado),
    ...override,
  };
  const coordinador=crearCoordinadorWhatsApp(opts);
  async function abrir(){await coordinador.iniciar();const s=conexiones.at(-1);assert.ok(s);s.ev.emit("connection.update",{connection:"open"});return s;}
  async function ejecutarReconexion(){assert.equal(timers.size,1);const [id,tm]=[...timers.entries()][0];timers.delete(id);tm.fn();await new Promise(setImmediate);}
  return {
    coordinador,conexiones,timers,estados,abrir,ejecutarReconexion,
    get authCount(){return authCount},get versionCount(){return versionCount},get saveCount(){return saveCount},
    setGuardarFalla(v){fallarGuardar=v},setConexionFalla(v){fallarConexion=v},
    setEnviarFalla(v){enviarError=v},setRespuestaId(v){respuestaConId=v},
  };
}
async function flush(){await new Promise(setImmediate);}

test("Arranque y estado: QR solo en vista privada; estado publico no incluye QR",async()=>{
 const e=escenario();const c=e.coordinador;
 await c.iniciar();
 const socket=e.conexiones[0];
 socket.ev.emit("connection.update",{qr:"QR_FICTICIO_SECRETO"});
 assert.equal(c.leerEstadoPrivado().qr,"QR_FICTICIO_SECRETO");
 assert.equal(c.leerEstadoPublico().fase,"esperando_qr");
 assert.equal(Object.hasOwn(c.leerEstadoPublico(),"qr"),false);
 assert.equal(JSON.stringify(e.estados).includes("QR_FICTICIO_SECRETO"),false);
 socket.ev.emit("connection.update",{connection:"open"});
 assert.equal(c.leerEstadoPublico().conectado,true);
 assert.equal(c.leerEstadoPrivado().qr,null);
 await c.detener();
});

test("Lanzar iniciar dos veces no crea dos sockets y estado conectado se conserva",async()=>{
 const e=escenario();const c=e.coordinador;
 await Promise.all([c.iniciar(),c.iniciar()]);
 assert.equal(e.conexiones.length,1);
 e.conexiones[0].ev.emit("connection.update",{connection:"open"});
 await c.iniciar();
 assert.equal(e.conexiones.length,1);
 await c.detener();
});

test("Cierre recuperable: programa reconexion, limpia QR y no reutiliza sockets viejos",async()=>{
 const e=escenario();const c=e.coordinador;
 const uno=await e.abrir();
 uno.ev.emit("connection.update",{qr:"QR_TEMPORAL"});
 uno.ev.emit("connection.update",{connection:"close",lastDisconnect:{error:{output:{statusCode:408}}}});
 assert.equal(uno.cerrado,true);
 assert.equal(c.leerEstadoPrivado().qr,null);
 assert.equal(c.leerEstadoPublico().fase,"reconexion_programada");
 assert.equal([...e.timers.values()][0].ms,30000);
 uno.ev.emit("connection.update",{qr:"QR_ANTIGUO"});
 assert.equal(c.leerEstadoPrivado().qr,null);
 await e.ejecutarReconexion();
 assert.equal(e.conexiones.length,2);
 const dos=e.conexiones[1];
 dos.ev.emit("connection.update",{connection:"open"});
 assert.equal(c.leerEstadoPublico().conectado,true);
 await c.detener();
});

test("Sesion cerrada 401: bloquear sin borrar credenciales ni reintentar",async()=>{
 const e=escenario();const c=e.coordinador;
 const s=await e.abrir();
 s.ev.emit("connection.update",{connection:"close",lastDisconnect:{error:{output:{statusCode:401}}}});
 assert.equal(c.leerEstadoPublico().fase,"bloqueado");
 assert.equal(c.leerEstadoPublico().errorCodigo,"WA_SESION_CERRADA");
 assert.equal(e.timers.size,0);
 await assert.rejects(c.iniciar(),/WA_COORDINADOR_BLOQUEADO/);
 await c.detener();
});

test("Falla persistencia: bloquear por seguridad y sin exponer secreto",async()=>{
 const e=escenario();const c=e.coordinador;
 const s=await e.abrir();
 e.setGuardarFalla(true);
 s.ev.emit("creds.update",{});
 await flush();
 assert.equal(c.leerEstadoPublico().fase,"bloqueado");
 assert.equal(c.leerEstadoPublico().errorCodigo,"WA_CREDENCIALES_NO_PERSISTIDAS");
 assert.equal(s.cerrado,true);
 assert.equal(JSON.stringify(e.estados).includes("Secretos"),false);
 await c.detener();
});

test("Envio permitido devuelve aceptacion del proveedor, nunca entrega confirmada",async()=>{
 const e=escenario();const c=e.coordinador;const s=await e.abrir();
 const res=await c.enviarTexto({telefono:"+34 600 111 222",mensaje:"Hola, datos ficticios"});
 assert.equal(res.estado,"aceptado_por_proveedor");
 assert.equal(res.entregado,false);
 assert.equal(s.envios.length,1);
 assert.equal(s.envios[0].jid,"34600111222@s.whatsapp.net");
 assert.ok(!JSON.stringify(res).includes("34600111222"));
 await c.detener();
});

test("Destinatario distinto, telefono invalido y mensaje demasiado largo se rechazan",async()=>{
 const e=escenario();const c=e.coordinador;const s=await e.abrir();
 const rechazado=await c.enviarTexto({telefono:"34699999888",mensaje:"Prueba"});
 assert.equal(rechazado.estado,"rechazado");
 await assert.rejects(c.enviarTexto({telefono:"abc",mensaje:"Prueba"}),/WA_DESTINATARIO_INVALIDO/);
 await assert.rejects(c.enviarTexto({telefono:"34600111222",mensaje:"x".repeat(4097)}),/WA_MENSAJE_INVALIDO/);
 assert.equal(s.envios.length,0);
 await c.detener();
});

test("Error de proveedor o ausencia de acuse: indeterminado y sin reintento automatico",async()=>{
 const e=escenario();const c=e.coordinador;const s=await e.abrir();
 e.setEnviarFalla(true);
 assert.equal((await c.enviarTexto({telefono:"34600111222",mensaje:"Prueba"})).estado,"indeterminado");
 e.setEnviarFalla(false);e.setRespuestaId(false);
 assert.equal((await c.enviarTexto({telefono:"34600111222",mensaje:"Prueba 2"})).codigo,"WA_SIN_ACUSE_DEL_PROVEEDOR");
 assert.equal(s.envios.length,2);
 assert.equal(e.timers.size,0);
 await c.detener();
});

test("Detener cancela reconexion y prohibe nuevos envios/arranque",async()=>{
 const e=escenario();const c=e.coordinador;const s=await e.abrir();
 s.ev.emit("connection.update",{connection:"close",lastDisconnect:{error:{output:{statusCode:408}}}});
 assert.equal(e.timers.size,1);
 await c.detener();
 assert.equal(e.timers.size,0);
 assert.equal(c.leerEstadoPublico().fase,"detenido");
 assert.equal((await c.enviarTexto({telefono:"34600111222",mensaje:"Prueba"})).estado,"no_iniciado");
 await assert.rejects(c.iniciar(),/WA_COORDINADOR_BLOQUEADO/);
});

test("Fallo de version: nunca crea socket; agenda reconexion",async()=>{
 const e=escenario({consultarVersion:async()=>({isLatest:false,version:[1,2,3]})});
 await e.coordinador.iniciar();
 assert.equal(e.conexiones.length,0);
 assert.equal(e.coordinador.leerEstadoPublico().fase,"reconexion_programada");
 assert.equal(e.timers.size,1);
 await e.coordinador.detener();
});
