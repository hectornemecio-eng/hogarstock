"use strict";
// Telemetría exclusivamente agregada: nunca recibe credenciales, teléfonos ni SQL.
// No altera los resultados del almacén ni persiste estado remoto.
const CODIGOS=new Set(["SQLITE_BUSY","SQLITE_LOCKED","SQLITE_ERROR",
  "LIBSQL_SERVER_ERROR","SERVER_ERROR","TRANSACTION_TIMEOUT","HTTP_TIMEOUT",
  "HS_WA_LEASE_PERDIDO","HS_WA_AUTH_CIFRADO_INVALIDO_O_CLAVE_INCORRECTA"]);
const ETAPAS=new Set(["lectura","escritura","credenciales"]);
function crearMonitorPersistenciaWa({reloj=Date.now,ventanaMs=1800000}={}){
  if(typeof reloj!=="function"||!Number.isSafeInteger(ventanaMs)||ventanaMs<60000)
    throw Error("HS_WA_MONITOR_CONFIG_INVALIDA");
  let eventos=[];
  function limpiar(t){eventos=eventos.filter(e=>e.t<=t&&t-e.t<=ventanaMs);}
  function guardar(etapa,ok,error){
    if(!ETAPAS.has(etapa))return;
    const ahora=reloj();
    if(!Number.isSafeInteger(ahora)||ahora<0)return;
    limpiar(ahora);
    let codigo=null;
    if(!ok){
      // Solo constantes conocidas, nunca error.message libre ni otros campos de Baileys.
      const raw=String(error?.code||"");
      const msg=String(error?.message||"");
      codigo=CODIGOS.has(raw)?raw:CODIGOS.has(msg)?msg:"OTRO";
    }
    eventos.push({t:ahora,etapa,ok:!!ok,codigo});
    if(eventos.length>500)eventos=eventos.slice(-500);
  }
  function registrarError(etapa,error){guardar(etapa,false,error);}
  function registrarExito(etapa){guardar(etapa,true,null);}
  function estado(){
    const t=reloj();limpiar(t);
    const fallos=eventos.filter(e=>!e.ok), correctos=eventos.length-fallos.length;
    const porEtapa={lectura:0,escritura:0,credenciales:0};
    for(const e of fallos)porEtapa[e.etapa]++;
    const ultimo=fallos.at(-1);
    return Object.freeze({
      ventanaMinutos:Math.round(ventanaMs/60000),operacionesCorrectas:correctos,
      fallosRecientes:fallos.length,porEtapa:Object.freeze(porEtapa),
      ultimoFallo:ultimo?Object.freeze({etapa:ultimo.etapa,codigo:ultimo.codigo,
        hora:new Date(ultimo.t).toISOString()}):null
    });
  }
  return Object.freeze({registrarError,registrarExito,estado});
}
module.exports={crearMonitorPersistenciaWa};
