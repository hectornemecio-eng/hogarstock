"use strict";

// Integramente offline: hostname remoto ficticio; factory de cliente inyectada
// devuelve SQLite local. Sin llamadas a Turso, WhatsApp ni Render.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes, createHash } = require("node:crypto");
const { createClient } = require("@libsql/client");
const { crearHashContrasena } = require("../security/access.js");
const { inicializarEnsayoV3 } = require("../integration/turso-stage-bootstrap.js");
const {
  validarPerfilRemoto, comprobarIdentidadRemota, iniciarStagingRemoto,
} = require("../integration/v3-remote-staging-entrypoint.js");

const host = "hogarstock-v3-test-integracion.turso.io";
const origen = "https://hogarstock-v3-stage.onrender.com";
const password = "SOLO-STAGING-FICTICIO-REMOTE-2026!";
const claves = () => ({
  auth:randomBytes(32).toString("hex"),
  outbox:randomBytes(32).toString("hex"),
  inbox:randomBytes(32).toString("hex"),
});

function perfil(extra = {}) {
  return {
    HOGARSTOCK_V3_REMOTE_STAGE:"1",
    HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:origen,
    HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"render",
    HOGARSTOCK_V3_REMOTE_STAGE_HOST:"hogarstock-v3-stage.onrender.com",
    HOGARSTOCK_STAGING_TURSO_URL:"libsql://" + host,
    HOGARSTOCK_STAGING_TURSO_HOST:host,
    HOGARSTOCK_PRODUCTION_TURSO_HOST:"hogarstock-production.turso.io",
    HOGARSTOCK_STAGING_TURSO_TOKEN:"TOKEN_FICTICIO_SIN_ACCESO_A_RED_NUNCA",
    HOGARSTOCK_STAGING_ADMIN_HASH:crearHashContrasena(password),
    HOGARSTOCK_STAGING_INBOX_KEY:"f".repeat(64),
    HOGARSTOCK_STAGING_PROOF_ID:"a".repeat(32),
    HOGARSTOCK_STAGING_BACKUP_SHA256:"b".repeat(64),
    HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT:"N",
    HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_WRITE:"N",
    HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED:"N",
    PORT:"0",
    ...extra,
  };
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"hs-remote-offline-"));
  const original = path.join(dir,"stage.sqlite");
  const copia = path.join(dir,"snapshot.sqlite");
  const client = createClient({url:"file:"+original});
  const k = claves();
  const init = await inicializarEnsayoV3({
    cliente:client, secretos:k,confirmacion:true,
    destino:{host,verificado:true},
  });
  await client.execute({sql:"VACUUM INTO ?",args:[copia]});
  const hash = createHash("sha256").update(fs.readFileSync(copia)).digest("hex");
  return { client, comprobante:init.comprobante, hash, k };
}

test("El arranque remoto exige habilitacion explicita",()=>{
  assert.throws(()=>validarPerfilRemoto(
    perfil({HOGARSTOCK_V3_REMOTE_STAGE:"0"})
  ),/NO_HABILITADO/);
});
test("Rechaza origen de produccion, HTTP y host Render no separado",()=>{
  for(const url of [
    "https://hogarstock.onrender.com",
    "http://hogarstock-v3-stage.onrender.com",
    "https://otro.onrender.com",
    "https://hogarstock-v3-stage.onrender.com/otra",
    "https://hogarstock-v3-stage.invalid"
  ]){
    assert.throws(()=>validarPerfilRemoto(
      perfil({HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:url})
    ),/ORIGEN_/);
  }
});
test("Acepta alojamiento V3 aislado con DNS de proveedor y host exactos",()=>{
  const destinos=[
    {url:"https://hogarstock-v3-stage.onrender.com",tipo:"render",host:"hogarstock-v3-stage.onrender.com"},
    {url:"https://web--hogarstock-v3-stage--abcd1234.code.run",tipo:"northflank",host:"web--hogarstock-v3-stage--abcd1234.code.run"},
    {url:"https://p01--hogarstock-v3-stage--abcd1234.salvo.code.run",tipo:"northflank",host:"p01--hogarstock-v3-stage--abcd1234.salvo.code.run"},
    {url:"https://hogarstock-v3-stage.spain.free.enzonic.com",tipo:"enzonic",host:"hogarstock-v3-stage.spain.free.enzonic.com"},
    {url:"https://hogarstock-v3-stage.us.free.enzonic.com",tipo:"enzonic",host:"hogarstock-v3-stage.us.free.enzonic.com"},
  ];
  for(const d of destinos) {
    const validado=validarPerfilRemoto(perfil({
      HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:d.url,
      HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:d.tipo,
      HOGARSTOCK_V3_REMOTE_STAGE_HOST:d.host,
      HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER:"S",
    }));
    assert.equal(validado.proveedor,d.tipo);
    assert.equal(validado.hostWeb,d.host);
    assert.equal(validado.permitirConexion,false);
  }
});
test("Rechaza dominios ajenos, producción, hosts confusos y puertos",()=>{
  for(const url of [
    "https://hogarstock.onrender.com",
    "https://hogarstock-v3-stage.onrender.com.evil.tld",
    "https://evil--hogarstock-v3-stage--abc.code.run.evil.tld",
    "https://web--hogarstock-v3-prod--abc.code.run",
    "https://hogarstock-v3-stage.spain.free.enzonic.com.evil.tld",
    "https://hogarstock-v3-stage.spain.free.enzonic.com:8443",
    "https://hogarstock-v3-stage.northflank.app",
    "https://hogarstock-v3-stage.spain.free.enzonic.com@evil.tld",
  ]) {
    assert.throws(()=>validarPerfilRemoto(perfil({
      HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:url,
    })),/V3_REMOTO_ORIGEN_/);
  }
});
test("Proveedor y host deben coincidir literalmente con la configuración auditada",()=>{
  for(const extra of [
    {HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"enzonic"},
    {HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"desconocido"},
    {HOGARSTOCK_V3_REMOTE_STAGE_HOST:"hogarstock.onrender.com"},
    {HOGARSTOCK_V3_REMOTE_STAGE_HOST:"hogarstock-v3-stage.onrender.com.evil.tld"},
  ]) {
    assert.throws(()=>validarPerfilRemoto(perfil(extra)),
      /V3_REMOTO_(PROVEEDOR|HOST)_NO_COINCIDE/);
  }
});
test("Decisión vigente: Render permitido y otros proveedores pausados por defecto",()=>{
  const actual=validarPerfilRemoto(perfil());
  assert.equal(actual.proveedor,"render");
  for(const perfilHost of [
    {HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:"https://web--hogarstock-v3-stage--abc.code.run",
     HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"northflank",
     HOGARSTOCK_V3_REMOTE_STAGE_HOST:"web--hogarstock-v3-stage--abc.code.run"},
    {HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:"https://hogarstock-v3-stage.spain.free.enzonic.com",
     HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"enzonic",
     HOGARSTOCK_V3_REMOTE_STAGE_HOST:"hogarstock-v3-stage.spain.free.enzonic.com",
     HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER:"S"},
  ]) {
    assert.throws(()=>validarPerfilRemoto(perfil(perfilHost)),
      /V3_REMOTO_ALTERNATIVAS_PAUSADAS/);
  }
});
test("Solo autorización explícita futura desbloquea prueba de DNS alternativo",()=>{
  const optIn=perfil({
    HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:"https://web--hogarstock-v3-stage--abc.code.run",
    HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"northflank",
    HOGARSTOCK_V3_REMOTE_STAGE_HOST:"web--hogarstock-v3-stage--abc.code.run",
    HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER:"S",
  });
  const cfg=validarPerfilRemoto(optIn);
  assert.equal(cfg.proveedor,"northflank");
  assert.equal(cfg.permitirConexion,false);
  assert.equal(cfg.permitirEscritura,false);
});
test("En proveedores alternativos se mantiene el bloqueo de red por defecto",async()=>{
  let llamadas=0;
  for(const extra of [
    {HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:"https://p01--hogarstock-v3-stage--abc.salvo.code.run",
     HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"northflank",
     HOGARSTOCK_V3_REMOTE_STAGE_HOST:"p01--hogarstock-v3-stage--abc.salvo.code.run",
     HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER:"S"},
    {HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN:"https://hogarstock-v3-stage.spain.free.enzonic.com",
     HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER:"enzonic",
     HOGARSTOCK_V3_REMOTE_STAGE_HOST:"hogarstock-v3-stage.spain.free.enzonic.com"},
  ]) {
    await assert.rejects(iniciarStagingRemoto({
      entorno:perfil(extra),
      fabricaCliente:()=>{llamadas++;throw Error("no");},
    }),/V3_REMOTO_RED_BLOQUEADA/);
  }
  assert.equal(llamadas,0);
});
test("La identidad de Turso debe ser de staging y distinta de produccion",()=>{
  for(const values of [
    {HOGARSTOCK_STAGING_TURSO_URL:"libsql://hogarstock-production.turso.io"},
    {HOGARSTOCK_PRODUCTION_TURSO_HOST:host},
    {HOGARSTOCK_STAGING_TURSO_HOST:"hogarstock-production.turso.io"},
    {HOGARSTOCK_STAGING_TURSO_URL:"file:/tmp/test.sqlite"},
  ]){
    assert.throws(()=>validarPerfilRemoto(perfil(values)),/BASE_NO_VERIFICADA/);
  }
});
test("No acepta variables de produccion o puente WhatsApp",()=>{
  for(const v of [
    {TURSO_DATABASE_URL:"libsql://produccion.turso.io"},
    {TURSO_AUTH_TOKEN:"token-ficticio"},
    {HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
    {WA_ALLOWED_NUMBERS:"000"},
    {WA_EXPERIMENTAL:"1"},
    {HOGARSTOCK_V3_SANDBOX:"1"},
  ]){
    assert.throws(()=>validarPerfilRemoto(perfil(v)),/ENTORNO_MIXTO/);
  }
});
test("Sin respaldo, prueba de identidad o hash admin se bloquea",()=>{
  for(const [extra,expected] of [
    [{HOGARSTOCK_STAGING_BACKUP_SHA256:""},/RESPALDO_NO_DECLARADO/],
    [{HOGARSTOCK_STAGING_PROOF_ID:""},/IDENTIDAD_AUSENTE/],
    [{HOGARSTOCK_STAGING_ADMIN_HASH:""},/HASH_ADMIN_INVALIDO/],
    [{HOGARSTOCK_STAGING_INBOX_KEY:"abc"},/HMAC_INVALIDA/],
    [{PORT:"65536"},/PUERTO_INVALIDO/],
  ]){
    assert.throws(()=>validarPerfilRemoto(perfil(extra)),expected);
  }
});
test("Sin permisos S el constructor de red ni siquiera se invoca",async()=>{
  let intentos=0;
  const fabrica=()=>{intentos++;throw new Error("NO_DEBE_EJECUTARSE");};
  const opciones = [
    {},
    {HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT:"S"},
    {HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT:"S",
      HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED:"S"},
  ];
  for(const extra of opciones){
    await assert.rejects(iniciarStagingRemoto({
      entorno:perfil(extra), fabricaCliente:fabrica,
    }),/V3_REMOTO_(RED_BLOQUEADA|RESPALDO_PENDIENTE|ESCRITURA_BLOQUEADA)/);
  }
  assert.equal(intentos,0);
});
test("Preflight de BD verifica tabla de prueba, host y comprobante",async()=>{
  const e=await fixture();
  try{
    const cfg=validarPerfilRemoto(perfil({
      HOGARSTOCK_STAGING_PROOF_ID:e.comprobante,
      HOGARSTOCK_STAGING_INBOX_KEY:e.k.inbox,
      HOGARSTOCK_STAGING_BACKUP_SHA256:e.hash,
    }));
    const valido=await comprobarIdentidadRemota(e.client,cfg);
    assert.equal(valido.identidadVerificada,true);
    await assert.rejects(comprobarIdentidadRemota(e.client,{
      ...cfg,comprobante:"0".repeat(32),
    }),/IDENTIDAD_NO_COINCIDE/);
    await assert.rejects(comprobarIdentidadRemota(e.client,{
      ...cfg,hostBase:"hogarstock-v3-test-otra.turso.io",
    }),/IDENTIDAD_NO_COINCIDE/);
  }finally{await e.client.close();}
});
test("Servidor V3 con BD de ensayo inyectada: HTTP autentica y rechaza V2",async()=>{
  const e=await fixture();
  const config=perfil({
    HOGARSTOCK_STAGING_PROOF_ID:e.comprobante,
    HOGARSTOCK_STAGING_INBOX_KEY:e.k.inbox,
    HOGARSTOCK_STAGING_BACKUP_SHA256:e.hash,
    HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT:"S",
    HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_WRITE:"S",
    HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED:"S",
  });
  let fabricas=0;
  let servidor;
  try{
    servidor=await iniciarStagingRemoto({
      entorno:config,
      fabricaCliente:(_args)=>{fabricas++;return e.client;},
    });
    assert.equal(fabricas,1);
    const base="http://127.0.0.1:"+servidor.puerto;
    const health=await fetch(base+"/health");
    assert.equal((await health.json()).version,3);
    assert.equal((await fetch(base+"/api/productos")).status,410);
    assert.equal((await fetch(base+"/api/v3/admin/productos")).status,401);
    const login=await fetch(base+"/api/v3/auth/login",{
      method:"POST",headers:{
        Origin:origen,"Content-Type":"application/json",
      },body:JSON.stringify({contrasena:password}),
    });
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("hs_admin_v3="));
    const productos=await fetch(base+"/api/v3/admin/productos",{
      headers:{Cookie:cookie},
    });
    assert.equal(productos.status,200);
    assert.equal((await productos.json()).productos.length,3);
  }finally{
    if(servidor)await servidor.cerrar();
    else await e.client.close();
  }
});
