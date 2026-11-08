"use strict";
// Nunca conecta red. El cliente "remoto" se sustituye por una fábrica ficticia.
const test=require("node:test");
const assert=require("node:assert/strict");
const {validarPerfilAuditoria,ejecutarAuditoriaRemota}=
  require("../scripts/v3-auditar-turso-v2-solo-lectura.js");
const perfil=extra=>({
  HOGARSTOCK_V2_AUDIT_READONLY:"S",
  HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA:"S",
  HOGARSTOCK_V2_PRODUCTION_HOST:"hogarstock-prod-ficticio.turso.io",
  TURSO_DATABASE_URL:"libsql://hogarstock-prod-ficticio.turso.io",
  TURSO_AUTH_TOKEN:"TOKEN_FICTICIO_SIN_ACCESO_REAL_123",
  ...extra,
});
test("Sin autorización y cuota confirmada rechaza ANTES de crear conexión",async()=>{
  let intentos=0;
  const fabrica=()=>{intentos++;throw Error("NO_PERMITIR");};
  for(const alteracion of [
    {HOGARSTOCK_V2_AUDIT_READONLY:""},
    {HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA:""},
  ]) {
    await assert.rejects(ejecutarAuditoriaRemota({
      entorno:perfil(alteracion),fabricaCliente:fabrica,
    }),/V2_AUDIT_(NO_AUTORIZADA|CUOTA_NO_VERIFICADA)/);
  }
  assert.equal(intentos,0);
});
test("Host productivo debe coincidir literalmente; staging y destinos falsos bloqueados",()=>{
  for(const extra of [
    {HOGARSTOCK_V2_PRODUCTION_HOST:"otro.turso.io"},
    {TURSO_DATABASE_URL:"libsql://hogarstock-v3-test.turso.io",
      HOGARSTOCK_V2_PRODUCTION_HOST:"hogarstock-v3-test.turso.io"},
    {TURSO_DATABASE_URL:"libsql://hogarstock-prod-ficticio.turso.io.evil.tld"},
    {TURSO_DATABASE_URL:"https://hogarstock-prod-ficticio.turso.io:8443"},
    {TURSO_DATABASE_URL:"libsql://usuario@hogarstock-prod-ficticio.turso.io"},
    {TURSO_DATABASE_URL:"file:/tmp/produccion.sqlite"},
    {TURSO_DATABASE_URL:"libsql://hogarstock-prod-ficticio.turso.io/?token=secreto"},
  ]) {
    assert.throws(()=>validarPerfilAuditoria(perfil(extra)),
      /V2_AUDIT_(HOST_NO_CONFIRMADO|URL_INVALIDA)/);
  }
});
test("No permite mezcla con entorno V3, credenciales incompletas ni WhatsApp live",()=>{
  for(const extra of [
    {HOGARSTOCK_V3_SANDBOX:"1"},
    {HOGARSTOCK_V3_REMOTE_STAGE:"1"},
    {HOGARSTOCK_STAGING_TURSO_URL:"libsql://ensayo.turso.io"},
    {HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
  ])assert.throws(()=>validarPerfilAuditoria(perfil(extra)),/ENTORNO_MEZCLADO/);
  assert.throws(()=>validarPerfilAuditoria(perfil({TURSO_AUTH_TOKEN:""})),
    /CONFIG_INCOMPLETA/);
});
test("Solo tres SELECT/PRAGMA: devuelve agregados y cierra cliente",async()=>{
  const queries=[];
  let closed=0,started=0;
  const cliente={
    async execute(query){
      queries.push(query);
      assert.match(query,/^(SELECT|PRAGMA)\b/);
      if(query.startsWith("SELECT name FROM"))return {rows:[
        {name:"productos"},{name:"baileys_auth_v2"},
      ]};
      if(query.startsWith("PRAGMA"))return {rows:[
        {name:"id",pk:1},{name:"nombre"},{name:"categoria"},{name:"agotado"},
      ]};
      return {rows:[{
        total:150,agotados:23,disponibles:127,
        estados_invalidos:0,textos_invalidos:0,
        ids_distintos:150,ids_invalidos:0,
      }]};
    },
    async close(){closed++;},
  };
  const r=await ejecutarAuditoriaRemota({
    entorno:perfil(),fabricaCliente:({url,authToken})=>{
      started++;
      assert.equal(url,"libsql://hogarstock-prod-ficticio.turso.io");
      assert.equal(authToken,"TOKEN_FICTICIO_SIN_ACCESO_REAL_123");
      return cliente;
    },
  });
  assert.equal(started,1);
  assert.equal(closed,1);
  assert.equal(queries.length,3);
  assert.equal(r.catalogo.total,150);
  assert.equal(r.catalogo.agotados,23);
  assert.equal(r.soloLectura,true);
  assert.equal(r.autorizaMigracion,false);
  const result=JSON.stringify(r);
  assert.ok(!result.includes("TOKEN_FICTICIO"));
  assert.ok(!result.includes("libsql://"));
});
test("Error SQL se propaga al llamante pero cierra conexión",async()=>{
  let closed=0;
  await assert.rejects(ejecutarAuditoriaRemota({
    entorno:perfil(),fabricaCliente:()=>({
      async execute(){throw Error("SIMULACION_DE_FALLO_SQL");},
      async close(){closed++;},
    }),
  }),/SIMULACION_DE_FALLO_SQL/);
  assert.equal(closed,1);
});
