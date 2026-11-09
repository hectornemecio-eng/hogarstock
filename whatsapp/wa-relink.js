"use strict";
// Recuperacion EXPLICITA de un inicio de WhatsApp rechazado (401).
// Archiva cifrados todos los registros existentes y atomiza el reemplazo
// con una identidad nueva. No accede a productos ni a compras.
const crypto = require("node:crypto");
const AUTH = "hs_v2_wa_auth_encrypted";
const ARCHIVE = "hs_v2_wa_auth_archive";
async function prepararNuevaVinculacion({db, lease, claveHex, initAuthCreds, BufferJSON, reloj=Date.now}={}) {
  if (!db || typeof db.execute!=="function" || typeof db.batch!=="function" ||
      !lease || typeof lease.verificar!=="function" || typeof lease.condicion!=="function" ||
      typeof initAuthCreds!=="function" || typeof BufferJSON?.replacer!=="function" ||
      !/^[0-9a-f]{64}$/i.test(String(claveHex||""))) throw Error("HS_WA_RELINK_CONFIG_INVALIDA");

  await lease.verificar();
  const check=await db.execute({sql:`SELECT COUNT(*) AS n FROM ${AUTH} WHERE id='creds'`,args:[]});
  if(Number(check.rows?.[0]?.n)!==1)throw Error("HS_WA_RELINK_CREDENCIALES_NO_EXISTEN");
  const n=await db.execute({sql:`SELECT COUNT(*) AS n FROM ${AUTH}`,args:[]});
  const total=Number(n.rows?.[0]?.n);
  if(!Number.isSafeInteger(total)||total<1||total>100000)throw Error("HS_WA_RELINK_CONTEO_INVALIDO");

  const value=JSON.stringify(initAuthCreds(),BufferJSON.replacer);
  if(typeof value!=="string"||Buffer.byteLength(value,"utf8")>1024*1024)
    throw Error("HS_WA_RELINK_CREDENCIALES_INVALIDAS");
  const iv=crypto.randomBytes(12);
  const enc=crypto.createCipheriv("aes-256-gcm",Buffer.from(claveHex,"hex"),iv);
  enc.setAAD(Buffer.from("creds"));
  const blob=Buffer.concat([enc.update(Buffer.from(value,"utf8")),enc.final()]);
  const payload=["v1",iv.toString("base64url"),enc.getAuthTag().toString("base64url"),blob.toString("base64url")].join(".");

  // El archivo queda cifrado con la misma clave de Render; no se exporta ni se registra.
  await db.execute(`CREATE TABLE IF NOT EXISTS ${ARCHIVE} (
    snapshot TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
    actualizado INTEGER NOT NULL, archivado INTEGER NOT NULL,
    PRIMARY KEY(snapshot,id))`);
  const snapshot=crypto.randomUUID();
  const now=reloj();
  const guard=lease.condicion();
  // Si la exclusión se pierde, no se sustituyen claves. Los tres cambios
  // están dentro de una única transacción write: fallo => rollback.
  const results=await db.batch([
    {sql:`INSERT INTO ${ARCHIVE}(snapshot,id,payload,actualizado,archivado)
      SELECT ?,id,payload,actualizado,? FROM ${AUTH} WHERE ${guard.sql}`,
     args:[snapshot,now,...guard.args]},
    {sql:`DELETE FROM ${AUTH} WHERE ${guard.sql}`,args:guard.args},
    {sql:`INSERT INTO ${AUTH}(id,payload,actualizado)
      SELECT 'creds',?,? WHERE ${guard.sql}`,args:[payload,now,...guard.args]},
  ],"write");
  if(!Array.isArray(results)||Number(results[0]?.rowsAffected)!==total||
     Number(results[1]?.rowsAffected)!==total||Number(results[2]?.rowsAffected)!==1)
    throw Error("HS_WA_RELINK_RESULTADO_INCONSISTENTE");
  await lease.verificar();
  return Object.freeze({archivados:total,restablecido:true});
}
module.exports={prepararNuevaVinculacion};
