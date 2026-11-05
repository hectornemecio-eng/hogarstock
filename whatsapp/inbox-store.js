"use strict";

// Bandeja de recepcion V3 (aislada). No conecta a WhatsApp, no expone rutas HTTP
// y NO modifica el inventario ni los estados de compra.
// Vinculos: solo una llamada administrativa autenticada debe crearlos.
// La autenticidad de los eventos entrantes debe validarla el adaptador Baileys.
// Datos personales y contenido libre NO se almacenan: solo huellas HMAC.

const {createHmac,randomUUID}=require("node:crypto");
const TABLA_VINCULOS="hogarstock_wa_links_v3";
const TABLA_INBOX="hogarstock_wa_inbox_v3";
const ESTADOS=new Set(["pendiente_revision","ambigua","no_interpretable","revisada","descartada"]);
const ACCIONES=new Set(["comprado","no_disponible","pendiente"]);

function idPositivo(id,nombre){
  if(!Number.isSafeInteger(id)||id<1)throw new TypeError(nombre+"_INVALIDO");
  return id;
}
function normalizarTelefono(telefono){
  if(typeof telefono!=="string"||telefono.length>32)throw new TypeError("WA_REMITENTE_INVALIDO");
  const n=telefono.replace(/[\s()+-]/g,"");
  if(!/^[0-9]{8,15}$/.test(n))throw new TypeError("WA_REMITENTE_INVALIDO");
  return n;
}
function validarIdMensaje(id){
  if(typeof id!=="string"||!/^[A-Za-z0-9_-]{4,160}$/.test(id)){
    throw new TypeError("WA_MENSAJE_ID_INVALIDO");
  }
  return id;
}
function analizar(texto){
  if(typeof texto!=="string"||Buffer.byteLength(texto,"utf8")>4096)return null;
  const m=/^\s*(COMPRADO|NO DISPONIBLE|PENDIENTE)\s+([1-9][0-9]{0,15})\s*$/i.exec(texto);
  if(!m)return null;
  const id=Number(m[2]);
  if(!Number.isSafeInteger(id)||id<1)return null;
  const estado=m[1].toUpperCase()==="COMPRADO"?"comprado":
    m[1].toUpperCase()==="NO DISPONIBLE"?"no_disponible":"pendiente";
  return {itemId:id,accion:estado};
}
function crearBandejaWhatsApp({cliente,compras,claveHmacHex,reloj=Date.now}={}){
  if(!cliente||typeof cliente.execute!=="function"||typeof cliente.batch!=="function"||
     !compras||typeof compras.obtenerCompra!=="function"){
    throw new TypeError("WA_INBOX_DEPENDENCIAS_INVALIDAS");
  }
  if(typeof claveHmacHex!=="string"||!/^[0-9a-fA-F]{64}$/.test(claveHmacHex)){
    throw new Error("WA_INBOX_CLAVE_INVALIDA");
  }
  if(typeof reloj!=="function")throw new TypeError("WA_INBOX_RELOJ_INVALIDO");
  const clave=Buffer.from(claveHmacHex,"hex");
  const huella=(dominio,texto)=>createHmac("sha256",clave)
    .update(dominio+"\0"+texto,"utf8").digest("hex");
  const ahora=()=>{
    const instante=reloj();
    if(!Number.isSafeInteger(instante)||instante<0)throw new Error("WA_INBOX_RELOJ_INVALIDO");
    return instante;
  };
  let lista=false;
  function exigirInit(){if(!lista)throw new Error("WA_INBOX_NO_INICIALIZADA");}

  async function tablaCompatible(nombre,columnas,primaria){
    const r=await cliente.execute("PRAGMA table_info("+nombre+")");
    if(!r.rows.length)return;
    const m=new Map(r.rows.map(x=>[String(x.name),x]));
    if(columnas.some(c=>!m.has(c))||Number(m.get(primaria)?.pk)!==1){
      throw new Error("WA_INBOX_ESQUEMA_INCOMPATIBLE:"+nombre);
    }
  }
  async function init(){
    await tablaCompatible(TABLA_VINCULOS,
      ["id","compra_id","remitente_hmac","creado","expira","revocado"],"id");
    await tablaCompatible(TABLA_INBOX,
      ["id","mensaje_hmac","compra_id","item_id","accion","estado","creado","revisado"],"id");
    await cliente.batch([
      "CREATE TABLE IF NOT EXISTS "+TABLA_VINCULOS+" ("+
       "id INTEGER PRIMARY KEY AUTOINCREMENT, compra_id INTEGER NOT NULL,"+
       "remitente_hmac TEXT NOT NULL, creado INTEGER NOT NULL,expira INTEGER NOT NULL,"+
       "revocado INTEGER,UNIQUE(compra_id,remitente_hmac))",
      "CREATE TABLE IF NOT EXISTS "+TABLA_INBOX+" ("+
       "id TEXT PRIMARY KEY NOT NULL,mensaje_hmac TEXT UNIQUE NOT NULL,"+
       "compra_id INTEGER,item_id INTEGER,accion TEXT,"+
       "estado TEXT NOT NULL CHECK(estado IN ("+
       "'pendiente_revision','ambigua','no_interpretable','revisada','descartada')),"+
       "creado INTEGER NOT NULL,revisado INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_wa_inbox_v3_compra ON "+TABLA_INBOX+
       "(compra_id,creado)",
      "CREATE INDEX IF NOT EXISTS idx_wa_links_v3_remitente ON "+TABLA_VINCULOS+
       "(remitente_hmac,expira)",
    ],"write");
    lista=true;
  }
  async function vincularRemitente({compraId,telefono,duracionMs=24*60*60*1000}={}){
    exigirInit();idPositivo(compraId,"WA_COMPRA");
    const remitente=huella("remitente",normalizarTelefono(telefono));
    if(!Number.isSafeInteger(duracionMs)||duracionMs<60000||
       duracionMs>7*24*60*60*1000)throw new RangeError("WA_VINCULO_DURACION_INVALIDA");
    const compra=await compras.obtenerCompra({compraId});
    if(!compra||compra.estado!=="abierta")throw new Error("WA_COMPRA_NO_ABIERTA");
    const fecha=ahora();
    await cliente.execute({
      sql:"INSERT INTO "+TABLA_VINCULOS+
        " (compra_id,remitente_hmac,creado,expira,revocado) VALUES (?,?,?,?,NULL)"+
        " ON CONFLICT(compra_id,remitente_hmac) DO UPDATE SET"+
        " creado=excluded.creado,expira=excluded.expira,revocado=NULL",
      args:[compraId,remitente,fecha,fecha+duracionMs],
    });
    return {vinculado:true,compraId,expira:fecha+duracionMs};
  }
  async function revocarVinculo({compraId,telefono}={}){
    exigirInit();idPositivo(compraId,"WA_COMPRA");
    const remitente=huella("remitente",normalizarTelefono(telefono));
    const r=await cliente.execute({
      sql:"UPDATE "+TABLA_VINCULOS+
        " SET revocado=? WHERE compra_id=? AND remitente_hmac=? AND revocado IS NULL",
      args:[ahora(),compraId,remitente],
    });
    return {revocado:Number(r.rowsAffected)===1};
  }
  // Invocar SOLO para un mensaje entrante verificado por el adaptador interno.
  // NO fiarse de compraId, teléfono ni 'fromMe' enviados por una solicitud HTTP.
  async function recibir({telefono,mensajeId,texto}={}){
    exigirInit();
    const remitente=huella("remitente",normalizarTelefono(telefono));
    const idMensaje=validarIdMensaje(mensajeId);
    const fecha=ahora();
    const vinculaciones=await cliente.execute({
      sql:"SELECT v.compra_id FROM "+TABLA_VINCULOS+" v"+
       " JOIN hogarstock_compras_v3 c ON c.id=v.compra_id"+
       " WHERE v.remitente_hmac=? AND v.revocado IS NULL AND v.expira>?"+
       " AND c.estado='abierta' ORDER BY v.compra_id LIMIT 2",
      args:[remitente,fecha],
    });
    if(!vinculaciones.rows.length)return {estado:"remitente_no_vinculado"};
    const asociacionUnica=vinculaciones.rows.length===1;
    const compraId=asociacionUnica?Number(vinculaciones.rows[0].compra_id):null;
    const comando=analizar(texto);
    let estado,accion=null,itemId=null;
    if(!asociacionUnica){
      estado="ambigua";
    }else if(!comando){
      estado="no_interpretable";
    }else{
      const compra=await compras.obtenerCompra({compraId});
      if(compra?.estado==="abierta"&&compra.items.some(x=>x.id===comando.itemId)){
        estado="pendiente_revision";
        itemId=comando.itemId;
        accion=comando.accion;
      }else{
        estado="no_interpretable";
      }
    }
    const id=randomUUID();
    const mensajeHmac=huella("mensaje",remitente+"\0"+idMensaje);
    const insertado=await cliente.execute({
      sql:"INSERT INTO "+TABLA_INBOX+
       " (id,mensaje_hmac,compra_id,item_id,accion,estado,creado,revisado)"+
       " VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(mensaje_hmac) DO NOTHING",
      args:[id,mensajeHmac,compraId,itemId,accion,estado,fecha],
    });
    if(Number(insertado.rowsAffected)===0)return {estado:"duplicado"};
    return {id,estado,compraId,itemId,accion};
  }
  async function listarPorCompra({compraId,limite=50}={}){
    exigirInit();idPositivo(compraId,"WA_COMPRA");
    if(!Number.isSafeInteger(limite)||limite<1||limite>100){
      throw new TypeError("WA_INBOX_LIMITE_INVALIDO");
    }
    const r=await cliente.execute({
      sql:"SELECT id,compra_id,item_id,accion,estado,creado,revisado"+
       " FROM "+TABLA_INBOX+" WHERE compra_id=? ORDER BY creado DESC,id DESC LIMIT ?",
      args:[compraId,limite],
    });
    return r.rows.map(f=>({
      id:String(f.id),compraId:Number(f.compra_id),
      itemId:f.item_id==null?null:Number(f.item_id),
      accion:f.accion==null?null:String(f.accion),estado:String(f.estado),
      creado:Number(f.creado),revisado:f.revisado==null?null:Number(f.revisado),
    }));
  }
  async function revisar({id,decision}={}){
    exigirInit();
    if(typeof id!=="string"||!/^[0-9a-f-]{36}$/i.test(id)){
      throw new TypeError("WA_INBOX_ID_INVALIDO");
    }
    if(decision!=="revisada"&&decision!=="descartada"){
      throw new TypeError("WA_INBOX_DECISION_INVALIDA");
    }
    // Revisar significa clasificar la propuesta; NUNCA cambia la compra.
    const cambio=await cliente.execute({
      sql:"UPDATE "+TABLA_INBOX+
       " SET estado=?,revisado=? WHERE id=? AND estado IN"+
       " ('pendiente_revision','no_interpretable','ambigua')",
      args:[decision,ahora(),id],
    });
    return {actualizado:Number(cambio.rowsAffected)===1};
  }
  return Object.freeze({init,vincularRemitente,revocarVinculo,recibir,
    listarPorCompra,revisar});
}
module.exports={crearBandejaWhatsApp};
