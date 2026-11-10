"use strict";
// Contraseña administrativa en Turso: nunca almacenar ni imprimir texto claro.
// El hash inicial de Render sigue siendo válido hasta el primer cambio confirmado.
const crypto=require("node:crypto");
const {adminHash}=require("./v2-identity");
const TABLA="hs_v2_admin_password";
const HEX64=/^[a-f0-9]{64}$/i;
function crearAlmacenClaveAdmin({db,identidad,entorno,reloj=Date.now}={}){
  if(!db || typeof db.execute!=="function" || typeof db.transaction!=="function" ||
    typeof identidad?.validarPassword!=="function" ||
    typeof identidad?.aplicarCredencialesAdmin!=="function" ||
    typeof identidad?.obtenerRevisionAdmin!=="function" ||
    !HEX64.test(entorno?.HS_V2_ADMIN_PASSWORD_SALT||"") ||
    !HEX64.test(entorno?.HS_V2_ADMIN_PASSWORD_HASH||"")){
    throw Error("HS_ADMIN_ALMACEN_CONFIG_INVALIDA");
  }
  let iniciado=false;
  function exigirInicio(){if(!iniciado)throw Error("HS_ADMIN_ALMACEN_NO_INICIADO");}
  function comprobarFila(fila){
    if(!HEX64.test(String(fila.salt||"")) ||
      !HEX64.test(String(fila.hash||"")) ||
      !Number.isSafeInteger(Number(fila.revision)) || Number(fila.revision)<1)
      throw Error("HS_ADMIN_ALMACEN_DATOS_INVALIDOS");
    return {salt:String(fila.salt),hash:String(fila.hash),revision:Number(fila.revision)};
  }
  function comprobarClave(clave,salt,hash){
    if(typeof clave!=="string"||clave.length<8||clave.length>200)return false;
    const obtenido=Buffer.from(adminHash(clave,salt),"hex");
    return crypto.timingSafeEqual(obtenido,Buffer.from(hash,"hex"));
  }
  async function init(){
    const r=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",args:[TABLA]});
    if(r.rows.length){
      try{await db.execute("SELECT id,salt,hash,revision,actualizada FROM "+TABLA+" LIMIT 0");}
      catch(_){throw Error("HS_ADMIN_ALMACEN_ESQUEMA_INCOMPATIBLE");}
    }
    await db.execute(
      "CREATE TABLE IF NOT EXISTS "+TABLA+" ("+
      "id INTEGER PRIMARY KEY CHECK(id=1),"+
      "salt TEXT NOT NULL, hash TEXT NOT NULL,"+
      "revision INTEGER NOT NULL CHECK(revision>=1), actualizada INTEGER NOT NULL)"
    );
    iniciado=true;
    await sincronizar();
  }
  async function sincronizar(){
    exigirInicio();
    const r=await db.execute("SELECT salt,hash,revision FROM "+TABLA+" WHERE id=1 LIMIT 1");
    if(r.rows.length===0){
      if(identidad.obtenerRevisionAdmin()>0)throw Error("HS_ADMIN_CREDENCIALES_NO_DISPONIBLES");
      return 0;
    }
    const fila=comprobarFila(r.rows[0]);
    if(fila.revision<identidad.obtenerRevisionAdmin())
      throw Error("HS_ADMIN_REVISION_OBSOLETA");
    identidad.aplicarCredencialesAdmin(fila);
    return fila.revision;
  }
  async function cambiar({actual,nueva}={}){
    exigirInicio();
    if(typeof nueva!=="string" || nueva.length<8 || nueva.length>200)
      throw Error("HS_ADMIN_CLAVE_NUEVA_LONGITUD");
    if(typeof actual!=="string" || actual.length<8 || actual.length>200)
      throw Error("HS_ADMIN_CLAVE_ACTUAL_INCORRECTA");
    if(actual===nueva)throw Error("HS_ADMIN_CLAVE_SIN_CAMBIOS");
    const tx=await db.transaction("write");
    let terminado=false;
    try{
      const r=await tx.execute("SELECT salt,hash,revision FROM "+TABLA+" WHERE id=1 LIMIT 1");
      const anterior=r.rows.length?comprobarFila(r.rows[0]):{
        salt:entorno.HS_V2_ADMIN_PASSWORD_SALT,
        hash:entorno.HS_V2_ADMIN_PASSWORD_HASH,
        revision:0
      };
      if(!comprobarClave(actual,anterior.salt,anterior.hash))
        throw Error("HS_ADMIN_CLAVE_ACTUAL_INCORRECTA");
      const nuevaRevision=anterior.revision+1;
      const salt=crypto.randomBytes(32).toString("hex");
      const hash=adminHash(nueva,salt);
      const actualizada=reloj();
      if(!Number.isSafeInteger(actualizada)||actualizada<=0)
        throw Error("HS_ADMIN_RELOJ_INVALIDO");
      await tx.execute({sql:"INSERT INTO "+TABLA+
        "(id,salt,hash,revision,actualizada) VALUES(1,?,?,?,?) "+
        "ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,"+
        "revision=excluded.revision,actualizada=excluded.actualizada",
        args:[salt,hash,nuevaRevision,actualizada]});
      await tx.commit();terminado=true;
      identidad.aplicarCredencialesAdmin({salt,hash,revision:nuevaRevision});
      return Object.freeze({ok:true});
    }catch(error){
      if(!terminado){try{await tx.rollback();}catch(_){}}
      throw error;
    }finally{tx.close();}
  }
  return Object.freeze({init,sincronizar,cambiar});
}
module.exports={crearAlmacenClaveAdmin};
