"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {main}=require("../integration/run-turso-stage.js");
const HOST="hogarstock-v3-test-lab-org.turso.io";
function variables(extra={}){
 return {
  HOGARSTOCK_STAGING_TURSO_URL:"libsql://"+HOST,
  HOGARSTOCK_STAGING_TURSO_HOST:HOST,
  HOGARSTOCK_PRODUCTION_TURSO_HOST:"hogarstock-prod-org.turso.io",
  HOGARSTOCK_STAGING_TURSO_TOKEN:"TOKEN_FICTICIO_DE_PRUEBAS_SIN_VALIDEZ",
  ...extra,
 };
}
test("CLI sin confirmación S valida forma local sin iniciar red ni escribir",async()=>{
 const salidas=[];
 const resultado=await main(variables(),msg=>salidas.push(msg));
 assert.deepEqual(resultado,{modo:"sin_red",exito:true});
 assert.equal(salidas.length,1);
 assert.match(salidas[0],/RED_BLOQUEADA/);
 assert.doesNotMatch(JSON.stringify(salidas),/TOKEN_FICTICIO|hogarstock-v3-test-lab/);
});
test("CLI sin permiso de red tampoco abre conexión aunque exista permiso de escritura",async()=>{
 const salidas=[];
 const r=await main(variables({HOGARSTOCK_STAGING_PERMITIR_ESCRITURA:"S"}),
   msg=>salidas.push(msg));
 assert.equal(r.modo,"sin_red");
 assert.match(salidas[0],/RED_BLOQUEADA/);
});
test("CLI con objetivo falso rechaza sin imprimir secretos",async()=>{
 const salidas=[];
 await assert.rejects(main(variables({HOGARSTOCK_STAGING_TURSO_URL:
  "libsql://hogarstock-prod-org.turso.io"}),x=>salidas.push(x)),
  /STAGING_CONFIGURACION_NO_VALIDA/);
 assert.equal(salidas.length,0);
});
