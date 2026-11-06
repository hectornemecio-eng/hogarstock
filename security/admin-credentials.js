"use strict";
// Persistencia independiente de la credencial admin V3: nunca guarda texto plano.
// El cambio y la invalidación de TODAS las sesiones admin son atómicos.
// No instala rutas ni altera la configuración de la V2.
const TABLA="hogarstock_admin_credentials_v3";
const SESIONES="hogarstock_admin_sessions_v3";
const {verificarContrasena}=require("./access.js");

function crearCredencialesAdmin({cliente,reloj=Date.now}={}){
 if(!cliente||typeof cliente.execute!=="function"||
    typeof cliente.transaction!=="function"||typeof reloj!=="function"){
  throw new TypeError("ADMIN_CREDENCIALES_DEPENDENCIAS_INVALIDAS");
 }
 let listo=false;
 const instante=()=>{const v=reloj();if(!Number.isSafeInteger(v)||v<0)throw new Error("ADMIN_RELOJ_INVALIDO");return v;};
 async function init({hashInicial}={}){
  if(typeof hashInicial!=="string"||!hashInicial.startsWith("scrypt:"))throw new Error("ADMIN_HASH_INICIAL_INVALIDO");
  const columnas=await cliente.execute("PRAGMA table_info("+TABLA+")");
  if(columnas.rows.length){
   const mapa=new Map(columnas.rows.map(x=>[String(x.name),x]));
   if(["id","hash","actualizado"].some(x=>!mapa.has(x))||
      Number(mapa.get("id").pk)!==1){
    throw new Error("ADMIN_CREDENCIALES_ESQUEMA_INCOMPATIBLE");
   }
  }
  const sesiones=await cliente.execute("PRAGMA table_info("+SESIONES+")");
  if(!sesiones.rows.some(x=>x.name==="huella")||
     !sesiones.rows.some(x=>x.name==="revocado"))throw new Error("ADMIN_SESIONES_SIN_INICIALIZAR");
  await cliente.execute("CREATE TABLE IF NOT EXISTS "+TABLA+
   " (id INTEGER PRIMARY KEY CHECK (id=1),hash TEXT NOT NULL,actualizado INTEGER NOT NULL)");
  await cliente.execute({sql:"INSERT INTO "+TABLA+
   " (id,hash,actualizado) VALUES (1,?,?) ON CONFLICT(id) DO NOTHING",
   args:[hashInicial,instante()]});
  listo=true;
 }
 function exigirInit(){if(!listo)throw new Error("ADMIN_CREDENCIALES_NO_INICIALIZADAS");}
 async function leerHash(){
  exigirInit();
  const r=await cliente.execute("SELECT hash FROM "+TABLA+" WHERE id=1 LIMIT 1");
  if(!r.rows[0]?.hash)throw new Error("ADMIN_CREDENCIALES_AUSENTES");
  return String(r.rows[0].hash);
 }
 async function cambiar({huellaSesion,contrasenaActual,nuevoHash}={}){
  exigirInit();
  if(typeof huellaSesion!=="string"||!/^[a-f0-9]{64}$/.test(huellaSesion)||
     typeof contrasenaActual!=="string"||typeof nuevoHash!=="string"||
     !nuevoHash.startsWith("scrypt:"))throw new TypeError("ADMIN_CAMBIO_ARGUMENTOS_INVALIDOS");
  const fecha=instante();
  const tx=await cliente.transaction("write");
  try{
   const r=await tx.execute({sql:"SELECT hash FROM "+TABLA+" WHERE id=1 LIMIT 1"});
   const actual=r.rows[0]?.hash;
   const sesion=await tx.execute({sql:"SELECT expira,revocado FROM "+SESIONES+
    " WHERE huella=? LIMIT 1",args:[huellaSesion]});
   const valid=sesion.rows[0]&&sesion.rows[0].revocado==null&&Number(sesion.rows[0].expira)>fecha;
   if(!valid){await tx.rollback();return {estado:"sesion_no_valida"};}
   if(!verificarContrasena(contrasenaActual,String(actual||""))){
    await tx.rollback();return {estado:"contrasena_incorrecta"};
   }
   // La nueva contraseña se valida y genera en el servicio de acceso.
   await tx.execute({sql:"UPDATE "+TABLA+" SET hash=?,actualizado=? WHERE id=1",
    args:[nuevoHash,fecha]});
   await tx.execute({sql:"UPDATE "+SESIONES+
    " SET revocado=? WHERE revocado IS NULL",args:[fecha]});
   await tx.commit();
   return {estado:"cambiada",sesionesInvalidadas:true};
  }catch(error){try{await tx.rollback();}catch(_){}throw error;}
  finally{tx.close();}
 }
 return Object.freeze({init,leerHash,cambiar});
}
module.exports={crearCredencialesAdmin};
