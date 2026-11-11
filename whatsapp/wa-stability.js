"use strict";
// Estado observacional de la conexión WhatsApp; no accede a credenciales, mensajes ni contactos.
function crearEstabilidadWA({reloj=Date.now, estableTrasMs=120000, ventanaMs=1800000}={}){
  if(typeof reloj!=="function"||!Number.isSafeInteger(estableTrasMs)||estableTrasMs<1000||
    !Number.isSafeInteger(ventanaMs)||ventanaMs<estableTrasMs)throw Error("HS_WA_ESTABILIDAD_CONFIG_INVALIDA");
  let abiertaDesde=null,ultimoCierre=null,caidas=[];
  function purgar(ahora){caidas=caidas.filter(x=>ahora-x.t<=ventanaMs && ahora>=x.t);}
  function abierta(){
    const ahora=reloj();if(!Number.isSafeInteger(ahora))throw Error("HS_WA_RELOJ_INVALIDO");
    abiertaDesde=ahora;
  }
  function cerrada(codigo){
    const ahora=reloj();if(!Number.isSafeInteger(ahora))throw Error("HS_WA_RELOJ_INVALIDO");
    const estable=abiertaDesde!==null && ahora-abiertaDesde>=estableTrasMs;
    abiertaDesde=null;
    const cod=Number.isInteger(codigo)&&codigo>=100&&codigo<1000?codigo:null;
    ultimoCierre={t:ahora,codigo:cod};
    purgar(ahora);caidas.push(ultimoCierre);
    return Object.freeze({estable});
  }
  function estado({conectado=false}={}){
    const ahora=reloj();purgar(ahora);
    const errores500=caidas.filter(x=>x.codigo===500).length;
    return Object.freeze({
      // Observaciones del socket, no una garantía de sincronización Signal ni entrega.
      conectado:Boolean(conectado),
      caidasRecientes:caidas.length,
      errores500Recientes:errores500,
      inestable:errores500>=2,
      ultimaCaida:ultimoCierre?new Date(ultimoCierre.t).toISOString():null,
      ultimoCodigo:ultimoCierre?.codigo??null,
      ultimoInicio:abiertaDesde!==null?new Date(abiertaDesde).toISOString():null
    });
  }
  return Object.freeze({abierta,cerrada,estado});
}
module.exports={crearEstabilidadWA};
