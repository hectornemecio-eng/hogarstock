"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const vm=require("node:vm");
const {createClient}=require("@libsql/client");
const {crearRespaldoCifrado,abrirRespaldo,restaurarAislado,obtenerSnapshot}=
  require("../backup/backup-safe");
const PASO="frase-de-prueba-laboratorio-2026";
async function baseFicticia(run,{sinClave=false}={}){
  // Solo SQLite EN MEMORIA: no abrir el Turso externo ni usar teléfonos reales.
  const db=createClient({url:"file::memory:"});
  try{
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, categoria TEXT, agotado INTEGER)");
    await db.execute("CREATE UNIQUE INDEX test_product_name ON productos(nombre)");
    await db.execute("CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY, token_hash TEXT,telefono TEXT, creada INTEGER, expira INTEGER,estado TEXT)");
    await db.execute("CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT,PRIMARY KEY(compra_id,producto_id),FOREIGN KEY(compra_id) REFERENCES hs_v2_security_grants(compra_id))");
    await db.execute("CREATE TABLE hs_v2_security_envios(compra_id TEXT, telefono TEXT,enviado INTEGER,PRIMARY KEY(compra_id,telefono))");
    await db.execute("CREATE TABLE hs_v2_wa_auth_encrypted(id TEXT PRIMARY KEY,payload TEXT NOT NULL,actualizado INTEGER NOT NULL)");
    await db.execute("CREATE TABLE hs_v2_wa_lease(slot INTEGER PRIMARY KEY, owner TEXT,generation INTEGER,hasta INTEGER)");
    await db.execute("CREATE TABLE baileys_auth_v2(id TEXT PRIMARY KEY, payload BLOB)");
    if(!sinClave){
      await db.execute("CREATE TABLE hs_v2_admin_password(id INTEGER PRIMARY KEY,salt TEXT,hash TEXT,revision INTEGER,actualizada INTEGER)");
      await db.execute({sql:"INSERT INTO hs_v2_admin_password VALUES(1,?,?,?,?)",
        args:["a".repeat(64),"b".repeat(64),2,Date.now()]});
    }
    const add=[];
    for(let id=1;id<=150;id++){
      add.push({sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES(?,?,?,?)",
        args:[id,"Producto ficticio "+id,"Sección de prueba",id%3===0?1:0]});
    }
    await db.batch(add,"write");
    await db.execute({sql:"INSERT INTO hs_v2_security_grants VALUES (?,?,?,?,?,?)",
      args:["a".repeat(48),"b".repeat(64),"34600000001",Date.now(),Date.now()+3600000,"abierta"]});
    await db.execute({sql:"INSERT INTO hs_v2_security_items VALUES (?,?,?)",
      args:["a".repeat(48),1,"pendiente"]});
    await db.execute({sql:"INSERT INTO hs_v2_security_envios VALUES (?,?,?)",
      args:["a".repeat(48),"34600000001",Date.now()]});
    await db.execute({sql:"INSERT INTO hs_v2_wa_auth_encrypted VALUES (?,?,?)",
      args:["creds","v1.ESTO_ES_DATOS_FICTICIOS_CIFRADOS",Date.now()]});
    await db.execute({sql:"INSERT INTO hs_v2_wa_lease VALUES (1,?,?,?)",
      args:["propietario-ficticio",3,Date.now()+60000]});
    await db.execute({sql:"INSERT INTO baileys_auth_v2 VALUES (?,?)",
      args:["ejemplo",Buffer.from([0,1,254,255])]});
    await run(db);
  }finally{db.close();}
}
test("v4.03: respaldo cifrado integral con tabla administrativa, WhatsApp, grants y tablas heredadas",async()=>{
  await baseFicticia(async db=>{
    const before=await db.execute("SELECT COUNT(*) AS n FROM productos");
    const result=await crearRespaldoCifrado(db,PASO);
    assert(Buffer.isBuffer(result.archivo));
    assert.equal(result.archivo.subarray(0,6).toString("ascii"),"HSBK01");
    assert(result.tablas>=8);
    assert(result.filas>=156);
    const snap=abrirRespaldo(result.archivo,PASO);
    for(const name of [
      "productos","hs_v2_security_grants","hs_v2_security_items",
      "hs_v2_security_envios","hs_v2_wa_auth_encrypted",
      "hs_v2_admin_password","baileys_auth_v2","hs_v2_wa_lease"
    ])assert(snap.tablas.some(t=>t.nombre===name),name);
    const productos=snap.tablas.find(t=>t.nombre==="productos");
    assert.equal(productos.total,150);
    const admin=snap.tablas.find(t=>t.nombre==="hs_v2_admin_password");
    assert.equal(admin.total,1);
    assert(snap.esquema.some(x=>x.type==="index"&&x.name==="test_product_name"));
    const copy=await restaurarAislado(snap);
    assert.deepEqual(copy,{ok:true,tablas:result.tablas,filas:result.filas});
    const after=await db.execute("SELECT COUNT(*) AS n FROM productos");
    assert.equal(Number(before.rows[0].n),150);
    assert.equal(Number(after.rows[0].n),150);
    // El fichero no contiene datos en claro: ni nombres, ni números, ni hashes.
    for(const secreto of ["Producto ficticio 1","34600000001","b".repeat(64)]){
      assert.equal(result.archivo.includes(Buffer.from(secreto)),false);
    }
    assert(result.archivo.length<10*1024*1024);
  });
});
test("v4.03: archivo ilegible con clave incorrecta o cuando se modifica un byte",async()=>{
  await baseFicticia(async db=>{
    const {archivo}=await crearRespaldoCifrado(db,PASO);
    assert.throws(()=>abrirRespaldo(archivo,"frase-incorrecta-de-prueba"),
      /HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
    const alterado=Buffer.from(archivo);
    alterado[alterado.length-1]^=0x01;
    assert.throws(()=>abrirRespaldo(alterado,PASO),/HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
    await assert.rejects(crearRespaldoCifrado(db,"12345678901"),/HS_BACKUP_CLAVE_MINIMO_12/);
    assert.throws(()=>abrirRespaldo(Buffer.from("falso"),PASO),/HS_BACKUP_ARCHIVO_INVALIDO/);
  });
});
test("v4.03: falla en lugar de exportar una copia que omite contraseña vigente",async()=>{
  await baseFicticia(async db=>{
    await assert.rejects(obtenerSnapshot(db),/HS_BACKUP_TABLAS_OBLIGATORIAS_AUSENTES/);
  },{sinClave:true});
});
test("v4.03: solo lectura y exportación con contraseña actual + CSRF sin restauración de producción",()=>{
  const server=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  const module=fs.readFileSync("backup/backup-safe.js","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  assert(server.includes('app.post("/api/admin/respaldo",http.adminWrite'));
  assert(server.includes("identidad.validarPassword(actual)"));
  assert(server.includes('res.setHeader("Content-Type","application/octet-stream")'));
  assert(server.includes("await crearRespaldoCifrado(db,frase)"));
  assert(!server.includes("restaurarAislado("));
  assert(module.includes('db.transaction("read")'));
  const take=module.slice(module.indexOf("async function obtenerSnapshot("),
    module.indexOf("function abrirRespaldo(",module.indexOf("async function obtenerSnapshot(")));
  assert(!/INSERT\s|UPDATE\s|DELETE\s|CREATE\s|DROP\s|REPLACE\s/i.test(take),
    "El código de exportación NO puede contener sentencias de escritura");
  assert(module.includes('createClient({url:"file::memory:"})'),
    "Las restauraciones de ensayo solo pueden realizarse en memoria");
  for(const id of ["formRespaldo","backupAdminPassword","backupPass","backupConfirm",
    "btnRespaldo","backupEstado"])
    assert(ui.includes('id="'+id+'"'));
  assert(ui.includes('fetch("/api/admin/respaldo"'));
  assert(ui.includes("URL.createObjectURL(blob)"));
  assert(css.includes(".page-admin .backup-panel"));
  const scripts=[...ui.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  for(const x of scripts)if(x[1].trim())new vm.Script(x[1]);
});
