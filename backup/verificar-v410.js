"use strict";
// v4.10. Verificación de archivos descargados, con simulacro de restauración
// en SQLite en memoria. No escribe jamás en Turso ni registra datos cifrados.
const crypto=require("node:crypto");
const {abrirRespaldo,restaurarAislado}=require("./backup-safe");
const LIMITE_WEB=8*1024*1024;
function extraerSolicitud(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<55||buffer.length>LIMITE_WEB)
    throw Error("HS_VERIFY_ARCHIVO_INVALIDO");
  const len=buffer.readUInt32BE(0);
  // El texto UTF-8 puede ocupar más bytes que los caracteres de la frase.
  if(len<12||len>800||buffer.length<=4+len+50)
    throw Error("HS_VERIFY_SOLICITUD_INVALIDA");
  const claveBytes=buffer.subarray(4,4+len);
  const clave=claveBytes.toString("utf8");
  if(Buffer.byteLength(clave,"utf8")!==len||clave.length<12||clave.length>200)
    throw Error("HS_VERIFY_CLAVE_INVALIDA");
  const archivo=buffer.subarray(4+len);
  if(archivo.length<51||archivo.subarray(0,6).toString("ascii")!=="HSBK01")
    throw Error("HS_VERIFY_ARCHIVO_INVALIDO");
  return {clave,archivo};
}
async function verificarArchivoDescargado(buffer){
  const {clave,archivo}=extraerSolicitud(buffer);
  const hash=crypto.createHash("sha256").update(archivo).digest("hex");
  const snapshot=abrirRespaldo(archivo,clave);
  const restaurado=await restaurarAislado(snapshot);
  const tabla=nombre=>snapshot.tablas.find(t=>t.nombre===nombre);
  const productos=tabla("productos")?.total??0;
  const eliminados=tabla("hs_catalogo_archivados")?.total??0;
  if(!Number.isSafeInteger(productos)||!Number.isSafeInteger(eliminados)||
     eliminados>productos||!Number.isSafeInteger(snapshot.totalFilas))
    throw Error("HS_VERIFY_CANTIDADES_INVALIDAS");
  return Object.freeze({
    verificado:true, restauracionAislada:restaurado.ok===true,
    fecha:typeof snapshot.creado==="string" && /^\d{4}-\d\d-\d\dT/.test(snapshot.creado)?
      snapshot.creado:null,
    tablas:restaurado.tablas, filas:restaurado.filas,
    productos,productosActivos:productos-eliminados,productosEliminados:eliminados,
    compras:tabla("hs_v2_security_grants")?.total??0,
    contieneCredencialesWhatsApp:Boolean(tabla("hs_v2_wa_auth_encrypted")),
    contieneAuditoriaV407:Boolean(tabla("hs_catalogo_revision_v407")),
    sha256:hash
  });
}
module.exports={LIMITE_WEB,extraerSolicitud,verificarArchivoDescargado};
