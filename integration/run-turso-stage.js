"use strict";

// Ejecución MANUAL; JAMÁS importada por server.js o CI.
// Modo por defecto: no conecta ni escribe.
// S para permitir conexión, S adicional para inicializar una base VACÍA.
// No imprimir variables secretas, URLs, errores remotos ni contenidos.

const { createClient } = require("@libsql/client");
const {
 validarDestinoEnsayo, crearClienteRemotoEnsayo, inspeccionarBaseSoloLectura,
} = require("./turso-stage-guard.js");
const { inicializarEnsayoV3 } = require("./turso-stage-bootstrap.js");

async function main(entorno=process.env, salida=console.log) {
 const config={
  url:entorno.HOGARSTOCK_STAGING_TURSO_URL,
  authToken:entorno.HOGARSTOCK_STAGING_TURSO_TOKEN,
  hostEsperado:entorno.HOGARSTOCK_STAGING_TURSO_HOST,
  hostProduccion:entorno.HOGARSTOCK_PRODUCTION_TURSO_HOST,
 };
 let verificado;
 try{
  verificado=validarDestinoEnsayo(config);
 }catch(_){
  throw new Error("STAGING_CONFIGURACION_NO_VALIDA");
 }
 if(entorno.HOGARSTOCK_STAGING_PERMITIR_RED!=="S"){
  salida("VALIDACION_LOCAL_OK: destino con etiqueta de ensayo. RED_BLOQUEADA; sin escrituras.");
  return {modo:"sin_red",exito:true};
 }
 let cliente;
 try{
  ({cliente}=crearClienteRemotoEnsayo({
   ...config,permitirRed:true,crearCliente:createClient,
  }));
  const previo=await inspeccionarBaseSoloLectura(cliente);
  salida("CONSULTA_SOLO_LECTURA_OK: "+
    (previo.vacia?"base sin tablas de usuario":"base con tablas existentes"));
  if(entorno.HOGARSTOCK_STAGING_PERMITIR_ESCRITURA!=="S"){
   salida("ESCRITURA_BLOQUEADA: no se crearon ni modificaron tablas.");
   return {modo:"solo_lectura",exito:true,vacia:previo.vacia};
  }
  if(!previo.vacia)throw Error("STAGING_BASE_NO_VACIA_NO_MODIFICADA");
  const secretos={
   auth:entorno.HOGARSTOCK_STAGING_AUTH_KEY,
   outbox:entorno.HOGARSTOCK_STAGING_OUTBOX_KEY,
   inbox:entorno.HOGARSTOCK_STAGING_INBOX_KEY,
  };
  // Revalidar ANTES de cualquier sentencia de escritura.
  const resultado=await inicializarEnsayoV3({
   cliente,secretos,confirmacion:true,destino:verificado,
  });
  salida("INICIALIZACION_OK: productos_ficticios="+
   resultado.productosFicticios+", tablas="+resultado.tablas.length);
  return {modo:"inicializado",exito:true};
 }catch(error){
  // El SDK remoto puede incluir URL, token o detalles sensibles en los
  // errores. Por ese motivo NO se muestra su mensaje ni stack.
  if(error?.message==="STAGING_BASE_NO_VACIA_NO_MODIFICADA"){
   throw Error("STAGING_BASE_NO_VACIA_NO_MODIFICADA");
  }
  throw Error("STAGING_OPERACION_NO_CONFIRMADA");
 }finally{
  if(cliente && typeof cliente.close==="function")cliente.close();
 }
}
if(require.main===module){
 main().catch(error=>{
  process.stderr.write(error.message+"\n");
  process.exitCode=1;
 });
}
module.exports={main};
