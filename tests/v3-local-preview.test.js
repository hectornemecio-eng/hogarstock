"use strict";

// Demo local: se verifica el mismo lanzador que utilizará el operador,
// sin red externa, sin acceso a WhatsApp y sin Turso real.
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { iniciarVistaLocal } = require("../integration/launch-v3-local.js");

async function pedir(url) {
  return new Promise((resolve,reject) => {
    https.get(url,{rejectUnauthorized:false},res => {
      let body="";
      res.on("data",chunk => {body+=chunk;});
      res.on("end",()=>resolve({status:res.statusCode,body}));
    }).on("error",reject);
  });
}

test("Vista local bloquea credenciales de Turso o conexión real de WhatsApp",async()=>{
  for(const overrides of [
    {TURSO_DATABASE_URL:"libsql://produccion.turso.io"},
    {TURSO_AUTH_TOKEN:"token-ficticio"},
    {WA_MASTER_KEY:"nunca-usar-esto"},
    {HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
  ]){
    await assert.rejects(iniciarVistaLocal({
      entorno:{HOGARSTOCK_V3_SANDBOX:"1",...overrides},
      mostrar:()=>{},
    }),/V3_DEMO_ENTORNO_NO_AISLADO/);
  }
});
test("Vista local solo abre interfaz V3 HTTPS y rechaza API V2",async t=>{
  const salida=[];
  const vista=await iniciarVistaLocal({
    entorno:process.env, mostrar:x=>salida.push(x),
  });
  t.after(()=>vista.cerrar());
  assert.match(vista.origen,/^https:\/\/127\.0\.0\.1:\d+$/);
  const health=await pedir(vista.origen+"/health");
  assert.equal(health.status,200);
  assert.equal(JSON.parse(health.body).entorno,"pruebas_aisladas");
  assert.equal((await pedir(vista.origen+"/admin-v3.html")).status,200);
  assert.equal((await pedir(vista.origen+"/comprador-v3.html")).status,200);
  assert.equal((await pedir(vista.origen+"/api/productos")).status,410);
  assert.equal((await pedir(vista.origen+"/api/whatsapp-status")).status,410);
  assert.equal((await pedir(vista.origen+"/api/v3/admin/productos")).status,401);
  assert.ok(salida.some(x=>x.includes("TEMPORALES")));
  assert.ok(salida.some(x=>x.includes("DESHABILITADO")));
});
test("Vista local rechaza certificado ausente antes de abrir servidor",async()=>{
  await assert.rejects(iniciarVistaLocal({
    entorno:{HOGARSTOCK_V3_SANDBOX:"1"},
    mostrar:()=>{},
  }),/V3_DEMO_CERTIFICADO_AUSENTE/);
});
