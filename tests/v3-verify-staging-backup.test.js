"use strict";

// Todos los ensayos usan DB SQLite ficticia, sin red ni credenciales reales.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("@libsql/client");
const { inicializarEnsayoV3 } = require("../integration/turso-stage-bootstrap.js");
const { verificarRespaldoStaging } =
  require("../integration/v3-verify-staging-backup.js");

const HOST = "hogarstock-v3-test-backup.turso.io";
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-v3-proof-fixture-"));
  const archivo = path.join(dir, "snapshot.sqlite");
  const cliente = createClient({url:"file:" + path.join(dir,"source.sqlite")});
  const keys = {
    auth: crypto.randomBytes(32).toString("hex"),
    outbox: crypto.randomBytes(32).toString("hex"),
    inbox: crypto.randomBytes(32).toString("hex"),
  };
  const stage = await inicializarEnsayoV3({
    cliente, secretos:keys, confirmacion:true,
    destino:{host:HOST,verificado:true},
  });
  await cliente.execute({sql:"VACUUM INTO ?",args:[archivo]});
  await cliente.close();
  const sha = crypto.createHash("sha256")
    .update(fs.readFileSync(archivo)).digest("hex");
  return {
    archivo, sha256Esperado:sha, hostEsperado:HOST,
    proofIdEsperado:stage.comprobante, directorioTemporal:dir,
  };
}
test("Respaldo real de ensayo: verifica copia, integridad, esquema e identidad",async()=>{
  const cfg=await fixture();
  const antes=fs.readFileSync(cfg.archivo);
  const r=await verificarRespaldoStaging(cfg);
  assert.equal(r.restauracionLocalVerificada,true);
  assert.equal(r.sha256,cfg.sha256Esperado);
  assert.equal(r.productos,3);
  assert.ok(r.tablasV3>=5);
  assert.ok(fs.existsSync(path.join(r.carpetaCopia,"recuperado.sqlite")));
  assert.deepEqual(fs.readFileSync(cfg.archivo),antes);
  assert.equal("proof_id" in r,false);
  assert.equal("token" in r,false);
});
test("Un SHA-256 inventado no acredita respaldo",async()=>{
  const cfg=await fixture();
  await assert.rejects(verificarRespaldoStaging({
    ...cfg,sha256Esperado:"0".repeat(64),
  }),/V3_BACKUP_SHA_NO_COINCIDE/);
});
test("No acepta identidad de base equivocada aun con copia e integridad correctas",async()=>{
  const cfg=await fixture();
  await assert.rejects(verificarRespaldoStaging({
    ...cfg, proofIdEsperado:"a".repeat(32),
  }),/V3_BACKUP_IDENTIDAD_NO_COINCIDE/);
  await assert.rejects(verificarRespaldoStaging({
    ...cfg,hostEsperado:"hogarstock-v3-test-otra.turso.io",
  }),/V3_BACKUP_IDENTIDAD_NO_COINCIDE/);
});
test("Rechaza archivo inexistente y falso formato SQLite",async()=>{
  const cfg=await fixture();
  await assert.rejects(verificarRespaldoStaging({
    ...cfg, archivo:path.join(cfg.directorioTemporal,"no-existe.sqlite"),
  }),/V3_BACKUP_ARCHIVO_INVALIDO/);
  const fake=path.join(cfg.directorioTemporal,"fake.sqlite");
  fs.writeFileSync(fake,"ESTO NO ES SQLITE");
  const sha=crypto.createHash("sha256").update(fs.readFileSync(fake)).digest("hex");
  await assert.rejects(verificarRespaldoStaging({
    ...cfg,archivo:fake,sha256Esperado:sha,
  }),/V3_BACKUP_NO_ES_SQLITE/);
});
test("No abre copias sin directorio temporal seguro",async()=>{
  const cfg=await fixture();
  await assert.rejects(verificarRespaldoStaging({
    ...cfg,directorioTemporal:path.join(cfg.directorioTemporal,"inexistente"),
  }),/V3_BACKUP_TEMPORAL_INVALIDO/);
  await assert.rejects(verificarRespaldoStaging({
    ...cfg,directorioTemporal:path.resolve(__dirname,".."),
  }),/V3_BACKUP_TEMPORAL_DENTRO_REPO/);
});
test("Rechaza etiquetas, hashes y rutas no validas antes de abrir archivos",async()=>{
  const cfg=await fixture();
  for(const mod of [
    {hostEsperado:"produccion.turso.io"},
    {proofIdEsperado:"invalida"},
    {sha256Esperado:"no-hash"},
  ]){
    await assert.rejects(verificarRespaldoStaging({...cfg,...mod}),
      /V3_BACKUP_(IDENTIDAD_CONFIG_INVALIDA|SHA_CONFIG_INVALIDO)/);
  }
});
