"use strict";
// Respaldo integral SOLO LECTURA: un archivo cifrado, sin SQL ni datos en disco.
// No se puede usar este módulo para escribir o restaurar en Turso.
const crypto=require("node:crypto");
const zlib=require("node:zlib");
const MAGIC=Buffer.from("HSBK01","ascii");
const REQUERIDAS=Object.freeze([
  "productos","hs_v2_admin_password","hs_v2_security_grants",
  "hs_v2_security_items","hs_v2_security_envios",
  "hs_v2_wa_auth_encrypted"
]);
const MAX_TABLAS=80;
const MAX_FILAS=300000;
const MAX_SNAPSHOT=64*1024*1024;
const MAX_ARCHIVO=50*1024*1024;
function qId(s){
  if(typeof s!=="string"||s.length===0||s.length>256||s.includes("\u0000"))
    throw Error("HS_BACKUP_IDENTIFICADOR_INVALIDO");
  return '"'+s.replace(/"/g,'""')+'"';
}
function claveValida(s){
  return typeof s==="string" && s.length>=12 && s.length<=200;
}
function encValor(v){
  if(v===null||v===undefined)return null;
  if(typeof v==="string")return {t:"text",v};
  if(typeof v==="number"){
    if(!Number.isFinite(v))throw Error("HS_BACKUP_NUMERO_INVALIDO");
    return {t:"number",v};
  }
  if(typeof v==="bigint")return {t:"integer",v:v.toString()};
  if(v instanceof Uint8Array || Buffer.isBuffer(v))
    return {t:"blob",v:Buffer.from(v).toString("base64")};
  throw Error("HS_BACKUP_TIPO_INVALIDO");
}
function decValor(v){
  if(v===null)return null;
  if(!v||typeof v!=="object")throw Error("HS_BACKUP_VALOR_INVALIDO");
  if(v.t==="text"&&typeof v.v==="string")return v.v;
  if(v.t==="number"&&typeof v.v==="number"&&Number.isFinite(v.v))return v.v;
  if(v.t==="integer"&&typeof v.v==="string"&&/^-?[0-9]+$/.test(v.v))return BigInt(v.v);
  if(v.t==="blob"&&typeof v.v==="string"&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.v))
    return Buffer.from(v.v,"base64");
  throw Error("HS_BACKUP_VALOR_INVALIDO");
}
function firma(filas){
  return crypto.createHash("sha256").update(
    JSON.stringify(filas.map(x=>JSON.stringify(x)).sort())
  ).digest("hex");
}
async function obtenerSnapshot(db){
  if(!db||typeof db.transaction!=="function")
    throw Error("HS_BACKUP_BASE_INVALIDA");
  let tx;
  try{
    tx=await db.transaction("read");
    const resultado=await tx.execute(
      "SELECT type,name,tbl_name,sql FROM sqlite_master "+
      "WHERE type IN ('table','index','view','trigger') "+
      "AND name NOT LIKE 'sqlite_%' ORDER BY type,name"
    );
    const esquema=resultado.rows.map(row=>({
      type:String(row.type),name:String(row.name),
      tbl_name:String(row.tbl_name),
      sql:row.sql===null?null:String(row.sql)
    }));
    const nombres=esquema.filter(x=>x.type==="table").map(x=>x.name);
    if(nombres.length>MAX_TABLAS || !REQUERIDAS.every(t=>nombres.includes(t)))
      throw Error("HS_BACKUP_TABLAS_OBLIGATORIAS_AUSENTES");
    const tablas=[];
    let total=0;
    for(const nombre of nombres){
      const datos=await tx.execute("SELECT * FROM "+qId(nombre));
      const columnas=[...datos.columns].map(String);
      if(columnas.length<1||columnas.length>160||
        columnas.some(c=>c.length>256))throw Error("HS_BACKUP_COLUMNAS_INVALIDAS");
      total+=datos.rows.length;
      if(total>MAX_FILAS)throw Error("HS_BACKUP_DEMASIADAS_FILAS");
      const filas=datos.rows.map(row=>columnas.map(c=>encValor(row[c])));
      tablas.push({nombre,columnas,filas,total:filas.length,sha256:firma(filas)});
    }
    // Conservar el siguiente AUTOINCREMENT si existe; no restaurar leases en vivo.
    const sequence=await tx.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence' LIMIT 1");
    const secuencia=sequence.rows.length?
      (await tx.execute("SELECT name,seq FROM sqlite_sequence")).rows.map(r=>({
        name:String(r.name),seq:encValor(r.seq)
      })):[];
    const snapshot={
      formato:"HOGARSTOCK_SNAPSHOT_V1",creado:new Date().toISOString(),
      tablas,esquema,secuencia,totalFilas:total
    };
    const bytes=Buffer.from(JSON.stringify(snapshot),"utf8");
    if(bytes.length>MAX_SNAPSHOT)throw Error("HS_BACKUP_TAMANO_EXCESIVO");
    return snapshot;
  }finally{
    if(tx){
      try{await tx.rollback();}catch(_){}
      try{tx.close();}catch(_){}
    }
  }
}
function abrirRespaldo(buffer,contrasena){
  if(!claveValida(contrasena)||!Buffer.isBuffer(buffer)||
    buffer.length<50||buffer.length>MAX_ARCHIVO||
    !buffer.subarray(0,6).equals(MAGIC))
    throw Error("HS_BACKUP_ARCHIVO_INVALIDO");
  try{
    const salt=buffer.subarray(6,22);
    const iv=buffer.subarray(22,34);
    const tag=buffer.subarray(34,50);
    const cifrado=buffer.subarray(50);
    const clave=crypto.scryptSync(contrasena,salt,32,{N:32768,r:8,p:1,maxmem:128*1024*1024});
    const desc=crypto.createDecipheriv("aes-256-gcm",clave,iv);
    desc.setAuthTag(tag);
    const comprimido=Buffer.concat([desc.update(cifrado),desc.final()]);
    const bruto=zlib.gunzipSync(comprimido,{maxOutputLength:MAX_SNAPSHOT});
    const snapshot=JSON.parse(bruto.toString("utf8"));
    if(snapshot?.formato!=="HOGARSTOCK_SNAPSHOT_V1"||
      !Array.isArray(snapshot.tablas)||!Array.isArray(snapshot.esquema)||
      !Array.isArray(snapshot.secuencia))throw Error();
    const nombres=snapshot.tablas.map(t=>t.nombre);
    if(nombres.length>MAX_TABLAS||!REQUERIDAS.every(n=>nombres.includes(n))||
      new Set(nombres).size!==nombres.length)throw Error();
    for(const t of snapshot.tablas){
      qId(t.nombre);
      if(!Array.isArray(t.columnas)||!Array.isArray(t.filas)||
        !Number.isSafeInteger(t.total)||t.total!==t.filas.length||
        firma(t.filas)!==t.sha256)throw Error();
      for(const c of t.columnas)qId(c);
    }
    return snapshot;
  }catch(_){
    throw Error("HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA");
  }
}
async function crearRespaldoCifrado(db,contrasena){
  if(!claveValida(contrasena))throw Error("HS_BACKUP_CLAVE_MINIMO_12");
  const snapshot=await obtenerSnapshot(db);
  const claro=Buffer.from(JSON.stringify(snapshot),"utf8");
  const comprimido=zlib.gzipSync(claro,{level:6});
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const clave=crypto.scryptSync(contrasena,salt,32,{N:32768,r:8,p:1,maxmem:128*1024*1024});
  const cifrador=crypto.createCipheriv("aes-256-gcm",clave,iv);
  const payload=Buffer.concat([cifrador.update(comprimido),cifrador.final()]);
  const archivo=Buffer.concat([MAGIC,salt,iv,cifrador.getAuthTag(),payload]);
  if(archivo.length>MAX_ARCHIVO)throw Error("HS_BACKUP_ARCHIVO_DEMASIADO_GRANDE");
  // Verificación automática de autenticidad ANTES de enviar el único archivo.
  const comprobado=abrirRespaldo(archivo,contrasena);
  if(comprobado.totalFilas!==snapshot.totalFilas)
    throw Error("HS_BACKUP_VERIFICACION_FALLIDA");
  return {archivo,tablas:snapshot.tablas.length,filas:snapshot.totalFilas};
}
// SOLO laboratorio: restaurar en una base local explícitamente suministrada;
// jamás exponer esto en rutas web ni conectar la restauración a Turso real.
async function restaurarAislado(dbLocal,snapshot){
  if(!dbLocal||typeof dbLocal.execute!=="function"||
    !dbLocal.protocol?.startsWith("file:") && dbLocal.protocol!=="memory:")
    throw Error("HS_BACKUP_RESTAURACION_SOLO_LOCAL");
  if(!snapshot||snapshot.formato!=="HOGARSTOCK_SNAPSHOT_V1")
    throw Error("HS_BACKUP_SNAPSHOT_INVALIDO");
  await dbLocal.execute("PRAGMA foreign_keys=OFF");
  const bases=snapshot.esquema.filter(x=>x.type==="table"&&x.sql);
  for(const item of bases)await dbLocal.execute(item.sql);
  for(const t of snapshot.tablas){
    const columnas=t.columnas.map(qId);
    const sql="INSERT INTO "+qId(t.nombre)+" ("+columnas.join(",")+") VALUES ("+
      columnas.map(()=>"?").join(",")+")";
    for(const fila of t.filas){
      if(fila.length!==columnas.length)throw Error("HS_BACKUP_FILA_INCOMPATIBLE");
      await dbLocal.execute({sql,args:fila.map(decValor)});
    }
  }
  if(snapshot.secuencia.length){
    await dbLocal.execute("DELETE FROM sqlite_sequence");
    for(const x of snapshot.secuencia){
      await dbLocal.execute({sql:"INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)",
        args:[x.name,decValor(x.seq)]});
    }
  }
  // Índices, vistas y disparadores solo después de insertar los datos.
  for(const tipo of ["index","view","trigger"]){
    for(const item of snapshot.esquema.filter(x=>x.type===tipo&&x.sql))
      await dbLocal.execute(item.sql);
  }
  const integridad=await dbLocal.execute("PRAGMA integrity_check");
  if(String(integridad.rows[0]?.integrity_check)!=="ok")
    throw Error("HS_BACKUP_INTEGRIDAD_SQLITE_ERROR");
  await dbLocal.execute("PRAGMA foreign_keys=ON");
  const claves=await dbLocal.execute("PRAGMA foreign_key_check");
  if(claves.rows.length)throw Error("HS_BACKUP_CLAVES_FORANEAS_INVALIDAS");
  for(const t of snapshot.tablas){
    const resultado=await dbLocal.execute("SELECT * FROM "+qId(t.nombre));
    const filas=resultado.rows.map(row=>t.columnas.map(c=>encValor(row[c])));
    if(filas.length!==t.total||firma(filas)!==t.sha256)
      throw Error("HS_BACKUP_RESTAURACION_DISTINTA");
  }
  return {ok:true,tablas:snapshot.tablas.length,filas:snapshot.totalFilas};
}
module.exports={crearRespaldoCifrado,abrirRespaldo,obtenerSnapshot,restaurarAislado};
