"use strict";

// Auditor remoto OPCIONAL y exclusivamente de lectura. No importa db.js,
// dotenv ni server.js. No se ejecuta en CI contra Turso. Nunca imprimir
// tokens, URL de conexión, nombres, teléfonos o SQL crudo del SDK.
const {auditarV2SoloLectura}=require("../integration/v3-auditoria-v2-solo-lectura.js");

function validarPerfilAuditoria(entorno={}) {
  if(entorno.HOGARSTOCK_V2_AUDIT_READONLY!=="S") {
    throw Error("V2_AUDIT_NO_AUTORIZADA");
  }
  if(entorno.HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA!=="S") {
    throw Error("V2_AUDIT_CUOTA_NO_VERIFICADA");
  }
  if(entorno.HOGARSTOCK_V3_SANDBOX ||
     entorno.HOGARSTOCK_V3_REMOTE_STAGE ||
     entorno.HOGARSTOCK_STAGING_TURSO_URL ||
     entorno.HOGARSTOCK_V3_WHATSAPP_LIVE) {
    throw Error("V2_AUDIT_ENTORNO_MEZCLADO");
  }
  const raw=entorno.TURSO_DATABASE_URL, token=entorno.TURSO_AUTH_TOKEN;
  const expected=entorno.HOGARSTOCK_V2_PRODUCTION_HOST;
  if(typeof raw!=="string"||typeof token!=="string"||
     token.length<20||token.length>16384||typeof expected!=="string") {
    throw Error("V2_AUDIT_CONFIG_INCOMPLETA");
  }
  let url;
  try {url=new URL(raw);} catch(_){throw Error("V2_AUDIT_URL_INVALIDA");}
  const host=url.hostname.toLowerCase();
  if(!["libsql:","https:"].includes(url.protocol)||
     url.username||url.password||url.port||url.search||url.hash||
     !["","/"].includes(url.pathname)||
     !/^[a-z0-9-]+\.turso\.io$/.test(host) ||
     /(?:^|-)(?:v3|stage|staging|test)(?:-|\.)/.test(host) ||
     host!==expected.toLowerCase()) {
    throw Error("V2_AUDIT_HOST_NO_CONFIRMADO");
  }
  return Object.freeze({url:raw,token,host});
}
async function ejecutarAuditoriaRemota({
  entorno=process.env,fabricaCliente,
}={}) {
  const cfg=validarPerfilAuditoria(entorno);
  const crear=fabricaCliente ||
    require("@libsql/client").createClient;
  if(typeof crear!=="function")throw Error("V2_AUDIT_FABRICA_INVALIDA");
  let cliente;
  try {
    cliente=crear({url:cfg.url,authToken:cfg.token});
    const resultado=await auditarV2SoloLectura(cliente);
    return resultado;
  } finally {
    if(cliente&&typeof cliente.close==="function")await cliente.close();
  }
}
if(require.main===module) {
  ejecutarAuditoriaRemota().then(reporte=>{
    process.stdout.write(JSON.stringify(reporte,null,2)+"\n");
  }).catch(error=>{
    const msg=typeof error?.message==="string"&&
      /^V2_AUDIT_[A-Z_]+$|^V2_AUDITORIA_[A-Z_]+$/.test(error.message)
      ?error.message:"V2_AUDIT_FALLO_SIN_DETALLE";
    process.stderr.write(msg+"\n");
    process.exitCode=1;
  });
}
module.exports={validarPerfilAuditoria,ejecutarAuditoriaRemota};
