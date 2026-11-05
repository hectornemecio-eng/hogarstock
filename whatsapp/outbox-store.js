"use strict";

// Outbox V3 aislado: mensaje y destinatario cifrados en libSQL.
// No importa Baileys ni expone endpoints. La autorizacion se aplica fuera.
// Si se interrumpe un envio, NUNCA se reintenta automaticamente.

const {randomUUID,randomBytes,createHmac,hkdfSync,
  createCipheriv,createDecipheriv,timingSafeEqual}=require("node:crypto");
const TABLA="hogarstock_wa_outbox_v3";
const COLUMNAS=["id","dedupe_hmac","contenido_hmac","compra_id",
  "contenido_cifrado","estado","creado","actualizado","intento_iniciado",
  "proveedor_hmac","aceptado_en","entregado_en","leido_en","error_codigo","revision"];
const ERRORES=new Set(["WA_NO_CONECTADO","WA_DESTINATARIO_NO_AUTORIZADO",
  "WA_ENVIO_NO_VERIFICABLE","WA_SIN_ACUSE_DEL_PROVEEDOR",
  "WA_CONEXION_CAMBIO_DURANTE_ENVIO","WA_RECUPERADO_TRAS_INTERRUPCION",
  "WA_PROVEEDOR_ACEPTO_SOLICITUD"]);
const SCHEMA="CREATE TABLE IF NOT EXISTS "+TABLA+" ("+
 "id TEXT PRIMARY KEY NOT NULL,dedupe_hmac TEXT UNIQUE NOT NULL,"+
 "contenido_hmac TEXT NOT NULL,compra_id INTEGER,contenido_cifrado TEXT NOT NULL,"+
 "estado TEXT NOT NULL CHECK(estado IN ('pendiente','en_envio','aceptado_proveedor',"+
 "'indeterminado','rechazado','confirmado_entrega','confirmado_lectura')),"+
 "creado INTEGER NOT NULL,actualizado INTEGER NOT NULL,intento_iniciado INTEGER,"+
 "proveedor_hmac TEXT UNIQUE,aceptado_en INTEGER,entregado_en INTEGER,"+
 "leido_en INTEGER,error_codigo TEXT,revision INTEGER NOT NULL DEFAULT 0)";

function claveValida(hex){
 if(typeof hex!=="string"||!/^[0-9a-fA-F]{64}$/.test(hex))throw Error("WA_OUTBOX_CLAVE_INVALIDA");
 const material=Buffer.from(hex,"hex"),salt=Buffer.alloc(0);
 return {
  enc:Buffer.from(hkdfSync("sha256",material,salt,"hogarstock-outbox-v3-encryption",32)),
  mac:Buffer.from(hkdfSync("sha256",material,salt,"hogarstock-outbox-v3-integrity",32)),
 };
}
function textoValido(valor,max,codigo){
 if(typeof valor!=="string"||!valor.trim()||
  Buffer.byteLength(valor,"utf8")>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(valor)){
  throw new TypeError(codigo);
 }
 return valor;
}
function telefonoValido(valor){
 const telefono=textoValido(valor,32,"WA_DESTINATARIO_INVALIDO").replace(/[\s()+-]/g,"");
 if(!/^[0-9]{8,15}$/.test(telefono))throw new TypeError("WA_DESTINATARIO_INVALIDO");
 return telefono;
}
function compraValida(v){
 if(v==null)return null;
 if(!Number.isSafeInteger(v)||v<1)throw new TypeError("WA_COMPRA_INVALIDA");
 return v;
}
function operacionValida(id){
 if(typeof id!=="string"||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){
  throw new TypeError("WA_OPERACION_INVALIDA");
 }
 return id;
}
function proveedorValido(id){
 if(typeof id!=="string"||!/^[a-zA-Z0-9_-]{4,160}$/.test(id)){
  throw new TypeError("WA_PROVEEDOR_ID_INVALIDO");
 }
 return id;
}
function fechaValida(reloj){
 const fecha=reloj();
 if(!Number.isSafeInteger(fecha)||fecha<0)throw Error("WA_RELOJ_INVALIDO");
 return fecha;
}
async function escribir(cliente,accion){
 const tx=await cliente.transaction("write");
 try{const resultado=await accion(tx);await tx.commit();return resultado;}
 catch(error){try{await tx.rollback();}catch(_){}throw error;}
 finally{tx.close();}
}

function crearRegistroWhatsApp({cliente,claveHex,reloj=Date.now}={}){
 if(!cliente||typeof cliente.execute!=="function"||typeof cliente.transaction!=="function"){
  throw new TypeError("WA_OUTBOX_CLIENTE_INVALIDO");
 }
 if(typeof reloj!=="function")throw new TypeError("WA_RELOJ_INVALIDO");
 const {enc,mac}=claveValida(claveHex);
 const ahora=()=>fechaValida(reloj);
 let inicializado=false;
 function exigirInit(){if(!inicializado)throw Error("WA_OUTBOX_NO_INICIALIZADO");}
 const huella=(dominio,valor)=>createHmac("sha256",mac)
  .update(dominio+"\0"+valor,"utf8").digest("hex");
 const fingerprintProveedor=(telefono,id)=>huella("proveedor",telefono+"\0"+id);
 function cifrar(id,datos){
  const iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",enc,iv);
  cipher.setAAD(Buffer.from("HS:outbox:v3:"+id));
  const cifrado=Buffer.concat([
   cipher.update(Buffer.from(JSON.stringify(datos),"utf8")),cipher.final(),
  ]);
  return JSON.stringify({v:1,iv:iv.toString("base64"),
   tag:cipher.getAuthTag().toString("base64"),data:cifrado.toString("base64")});
 }
 function descifrar(id,valor){
  try{
   const d=JSON.parse(valor);
   if(d?.v!==1)throw Error("formato");
   const iv=Buffer.from(d.iv,"base64"),tag=Buffer.from(d.tag,"base64"),
    texto=Buffer.from(d.data,"base64");
   if(iv.length!==12||tag.length!==16||texto.length===0||texto.length>8192)throw Error("tamano");
   const dec=createDecipheriv("aes-256-gcm",enc,iv);
   dec.setAAD(Buffer.from("HS:outbox:v3:"+id));dec.setAuthTag(tag);
   const resultado=JSON.parse(Buffer.concat([dec.update(texto),dec.final()]).toString("utf8"));
   if(!resultado||typeof resultado.telefono!=="string"||typeof resultado.mensaje!=="string"){
    throw Error("contenido");
   }
   return resultado;
  }catch(_){throw Error("WA_OUTBOX_NO_DESCIFRABLE");}
 }
 function meta(f){
  return Object.freeze({id:String(f.id),compraId:f.compra_id==null?null:Number(f.compra_id),
   estado:String(f.estado),creado:Number(f.creado),actualizado:Number(f.actualizado),
   revision:Number(f.revision),errorCodigo:f.error_codigo==null?null:String(f.error_codigo),
   aceptadoEn:f.aceptado_en==null?null:Number(f.aceptado_en),
   entregadoEn:f.entregado_en==null?null:Number(f.entregado_en),
   leidoEn:f.leido_en==null?null:Number(f.leido_en)});
 }
 async function init(){
  const r=await cliente.execute("PRAGMA table_info("+TABLA+")");
  if(r.rows.length){
   const m=new Map(r.rows.map(f=>[String(f.name),f]));
   if(COLUMNAS.some(c=>!m.has(c))||Number(m.get("id").pk)!==1){
    throw Error("WA_OUTBOX_ESQUEMA_INCOMPATIBLE");
   }
  }
  await cliente.execute(SCHEMA);
  await cliente.execute("CREATE INDEX IF NOT EXISTS idx_wa_outbox_v3_compra ON "+TABLA+"(compra_id,creado)");
  await cliente.execute("CREATE INDEX IF NOT EXISTS idx_wa_outbox_v3_estado ON "+TABLA+"(estado,intento_iniciado)");
  inicializado=true;
 }
 async function obtener(id){
  exigirInit();operacionValida(id);
  const r=await cliente.execute({sql:"SELECT * FROM "+TABLA+" WHERE id=? LIMIT 1",args:[id]});
  return r.rows.length?meta(r.rows[0]):null;
 }
 async function registrarSolicitud({claveIdempotencia,telefono,mensaje,compraId=null}={}){
  exigirInit();
  const key=textoValido(claveIdempotencia,200,"WA_IDEMPOTENCIA_INVALIDA"),
   tel=telefonoValido(telefono),texto=textoValido(mensaje,4096,"WA_MENSAJE_INVALIDO"),
   compra=compraValida(compraId),dedupe=huella("dedupe",key),
   fingerprint=huella("contenido",JSON.stringify([compra,tel,texto]));
  return escribir(cliente,async tx=>{
   const r=await tx.execute({sql:"SELECT * FROM "+TABLA+" WHERE dedupe_hmac=? LIMIT 1",args:[dedupe]});
   if(r.rows.length){
    const f=r.rows[0],actual=String(f.contenido_hmac);
    if(!/^[0-9a-f]{64}$/.test(actual)||
     !timingSafeEqual(Buffer.from(actual,"hex"),Buffer.from(fingerprint,"hex"))){
     throw Error("WA_IDEMPOTENCIA_CONFLICTO");
    }
    return {creada:false,...meta(f)};
   }
   const id=randomUUID(),fecha=ahora();
   await tx.execute({
    sql:"INSERT INTO "+TABLA+
     " (id,dedupe_hmac,contenido_hmac,compra_id,contenido_cifrado,estado,creado,actualizado,revision)"+
     " VALUES (?,?,?,?,?,'pendiente',?,?,0)",
    args:[id,dedupe,fingerprint,compra,cifrar(id,{telefono:tel,mensaje:texto}),fecha,fecha],
   });
   return {creada:true,id,compraId:compra,estado:"pendiente",creado:fecha,
    actualizado:fecha,revision:0,errorCodigo:null,aceptadoEn:null,
    entregadoEn:null,leidoEn:null};
  });
 }
 async function reclamarEnvio(id){
  exigirInit();operacionValida(id);
  // Leer y descifrar ANTES de tocar el estado.
  // La reserva definitiva es UN UNICO UPDATE atomico sin transaccion larga.
  // Dos conexiones podran leer, pero solo una cambiara pendiente -> en_envio.
  for(let intento=0;intento<7;intento++){
   try{
    const r=await cliente.execute({
     sql:"SELECT estado,contenido_cifrado FROM "+TABLA+" WHERE id=? LIMIT 1",
     args:[id],
    });
    if(!r.rows.length)return {adquirido:false,estado:"inexistente"};
    const fila=r.rows[0];
    if(fila.estado!=="pendiente")return {
     adquirido:false,estado:String(fila.estado),
    };
    const cifrado=String(fila.contenido_cifrado);
    const datos=descifrar(id,cifrado),fecha=ahora();
    const cambio=await cliente.execute({
     sql:"UPDATE "+TABLA+" SET estado='en_envio',intento_iniciado=?,"+
      "actualizado=?,revision=revision+1"+
      " WHERE id=? AND estado='pendiente' AND contenido_cifrado=?",
     args:[fecha,fecha,id,cifrado],
    });
    if(Number(cambio.rowsAffected)===1){
     return {adquirido:true,id,telefono:datos.telefono,mensaje:datos.mensaje};
    }
    // El competidor obtuvo la reserva; JAMAS enviar en esta rama.
    return {adquirido:false,estado:"reservado_por_otro"};
   }catch(error){
    if(error?.code!=="SQLITE_BUSY"||intento===6)throw error;
    await new Promise(resolve=>setTimeout(resolve,10*(intento+1)));
   }
  }
 }
 async function registrarResultado({id,estado,codigo=null,proveedorId=null}={}){
  exigirInit();operacionValida(id);
  if(!["aceptado_por_proveedor","indeterminado","no_iniciado","rechazado"].includes(estado)){
   throw new TypeError("WA_RESULTADO_INVALIDO");
  }
  if(codigo!==null&&!ERRORES.has(codigo))throw new TypeError("WA_CODIGO_NO_PERMITIDO");
  if(estado==="aceptado_por_proveedor")proveedorValido(proveedorId);
  else if(proveedorId!==null)throw new TypeError("WA_PROVEEDOR_ID_NO_PERMITIDO");
  return escribir(cliente,async tx=>{
   const r=await tx.execute({sql:"SELECT * FROM "+TABLA+" WHERE id=? LIMIT 1",args:[id]});
   if(!r.rows.length)throw Error("WA_OPERACION_INEXISTENTE");
   const f=r.rows[0];
   if(f.estado!=="en_envio")throw Error("WA_TRANSICION_INVALIDA");
   const fecha=ahora();
   const siguiente=estado==="aceptado_por_proveedor"?"aceptado_proveedor":
    estado==="no_iniciado"?"pendiente":estado==="rechazado"?"rechazado":"indeterminado";
   const proveedorHash=proveedorId===null?null:fingerprintProveedor(
    descifrar(id,String(f.contenido_cifrado)).telefono,proveedorId);
   await tx.execute({
    sql:"UPDATE "+TABLA+" SET estado=?,actualizado=?,revision=revision+1,"+
     "error_codigo=?,proveedor_hmac=?,aceptado_en=?,"+
     "intento_iniciado=CASE WHEN ?='pendiente' THEN NULL ELSE intento_iniciado END"+
     " WHERE id=? AND estado='en_envio'",
    args:[siguiente,fecha,codigo,proveedorHash,
     siguiente==="aceptado_proveedor"?fecha:null,siguiente,id],
   });
   return {id,estado:siguiente};
  });
 }
 // Llamada reservada a un adaptador interno de eventos de acuse verificados.
 async function registrarAcuse({telefono,proveedorId,tipo}={}){
  exigirInit();
  const tel=telefonoValido(telefono),mid=proveedorValido(proveedorId);
  if(!["entregado","leido"].includes(tipo))throw new TypeError("WA_ACUSE_INVALIDO");
  return escribir(cliente,async tx=>{
   const r=await tx.execute({
    sql:"SELECT * FROM "+TABLA+" WHERE proveedor_hmac=? LIMIT 1",
    args:[fingerprintProveedor(tel,mid)],
   });
   if(!r.rows.length)return {actualizado:false};
   const f=r.rows[0];
   if(!["aceptado_proveedor","confirmado_entrega","confirmado_lectura"].includes(f.estado)){
    return {actualizado:false};
   }
   const siguiente=tipo==="leido"?"confirmado_lectura":"confirmado_entrega";
   if(f.estado==="confirmado_lectura"||
    (f.estado==="confirmado_entrega"&&siguiente==="confirmado_entrega")){
    return {actualizado:false};
   }
   const fecha=ahora();
   const cambio=await tx.execute({
    sql:"UPDATE "+TABLA+" SET estado=?,actualizado=?,revision=revision+1,"+
     "entregado_en=COALESCE(entregado_en,?),"+
     "leido_en=CASE WHEN ?='confirmado_lectura' THEN ? ELSE leido_en END"+
     " WHERE id=? AND estado=?",
    args:[siguiente,fecha,fecha,siguiente,fecha,String(f.id),String(f.estado)],
   });
   return {actualizado:Number(cambio.rowsAffected)===1,estado:siguiente};
  });
 }
 // Solo se invoca en una recuperacion EXPLICITA, nunca en init().
 async function recuperarIntentosInterrumpidos({antiguedadMs=60000}={}){
  exigirInit();
  if(!Number.isSafeInteger(antiguedadMs)||antiguedadMs<60000||
   antiguedadMs>30*24*3600*1000)throw new RangeError("WA_ANTIGUEDAD_INVALIDA");
  const fecha=ahora();
  const r=await cliente.execute({
   sql:"UPDATE "+TABLA+" SET estado='indeterminado',"+
    "error_codigo='WA_RECUPERADO_TRAS_INTERRUPCION',"+
    "actualizado=?,revision=revision+1 WHERE estado='en_envio' AND intento_iniciado<=?",
   args:[fecha,fecha-antiguedadMs],
  });
  return {marcadasIndeterminadas:Number(r.rowsAffected)};
 }
 async function listarPorCompra({compraId,limite=50}={}){
  exigirInit();const id=compraValida(compraId);
  if(id===null)throw new TypeError("WA_COMPRA_INVALIDA");
  if(!Number.isSafeInteger(limite)||limite<1||limite>100)throw new TypeError("WA_LIMITE_INVALIDO");
  const r=await cliente.execute({
   sql:"SELECT * FROM "+TABLA+" WHERE compra_id=? ORDER BY creado DESC,id DESC LIMIT ?",
   args:[id,limite],
  });
  return r.rows.map(meta);
 }
 return Object.freeze({init,obtener,registrarSolicitud,reclamarEnvio,registrarResultado,
  registrarAcuse,recuperarIntentosInterrumpidos,listarPorCompra});
}
module.exports={crearRegistroWhatsApp};
