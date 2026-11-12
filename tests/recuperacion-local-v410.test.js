"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearRespaldoCifrado}=require("../backup/backup-safe");
const {restaurarComoNuevaSqlite}=require("../backup/recuperacion-local-v410");

async function resguardo(run){
 const base=path.join(os.tmpdir(),"hs-restore-v410-"+crypto.randomBytes(6).toString("hex")+".sqlite");
 const dest=path.join(os.tmpdir(),"hs-restore-v410-staging-"+crypto.randomBytes(6).toString("hex")+".sqlite");
 const db=createClient({url:"file:"+base});
 try{
  await db.batch([
    "CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT,categoria TEXT,agotado INTEGER DEFAULT 0)",
    "CREATE TABLE hs_v2_admin_password(id INTEGER PRIMARY KEY,salt TEXT,hash TEXT,revision INTEGER,actualizada INTEGER)",
    "CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,token_hash TEXT,telefono TEXT,creada INTEGER,expira INTEGER,estado TEXT)",
    "CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT,PRIMARY KEY(compra_id,producto_id))",
    "CREATE TABLE hs_v2_security_envios(compra_id TEXT,telefono TEXT,enviado INTEGER,PRIMARY KEY(compra_id,telefono))",
    "CREATE TABLE hs_v2_wa_auth_encrypted(id TEXT PRIMARY KEY,payload TEXT,actualizado INTEGER)",
    "CREATE TABLE hs_catalogo_archivados(producto_id INTEGER PRIMARY KEY REFERENCES productos(id),fecha INTEGER)"
  ],"write");
  await db.batch(Array.from({length:161},(_,i)=>({
   sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[i+1,"Producto de ensayo "+(i+1),"Laboratorio",0]
  })),"write");
  await db.batch([
    {sql:"INSERT INTO hs_v2_admin_password VALUES(1,?,?,1,?)",args:["a".repeat(64),"b".repeat(64),Date.now()]},
    {sql:"INSERT INTO hs_v2_security_grants VALUES('prueba',?,?,?,?,'finalizada')",args:["c".repeat(64),"34600000001",Date.now(),Date.now()]},
    {sql:"INSERT INTO hs_v2_security_items VALUES('prueba',1,'comprado')",args:[]},
    {sql:"INSERT INTO hs_v2_security_envios VALUES('prueba','34600000001',1)",args:[]},
    {sql:"INSERT INTO hs_v2_wa_auth_encrypted VALUES('creds','FICTICIO_CIFRADO',?)",args:[Date.now()]},
    {sql:"INSERT INTO hs_catalogo_archivados VALUES(161,?)",args:[Date.now()]}
  ],"write");
  const backup=(await crearRespaldoCifrado(db,"CLAVE FICTICIA SEGURA PARA ENSAYO v410")).archivo;
  await run({backup,base,dest,db});
 }finally{
  db.close();
  for(const p of [base,base+"-wal",base+"-shm",dest,dest+"-wal",dest+"-shm"])
   try{fs.unlinkSync(p)}catch(_){}
 }
}
test("v4.10: reconstrucción persistente nueva y aislada de 161 filas con historial y WA ficticio",async()=>{
 await resguardo(async({backup,base,dest,db})=>{
  const result=await restaurarComoNuevaSqlite({archivo:backup,clave:"CLAVE FICTICIA SEGURA PARA ENSAYO v410",destino:dest});
  assert.equal(result.ok,true);
  assert.equal(result.productos,161);
  assert.equal(fs.existsSync(dest),true);
  const check=createClient({url:"file:"+dest});
  try{
   const c=await check.execute("SELECT count(*) n FROM productos");
   assert.equal(Number(c.rows[0].n),161);
   const arch=await check.execute("SELECT count(*) n FROM hs_catalogo_archivados");
   assert.equal(Number(arch.rows[0].n),1);
   const fk=await check.execute("PRAGMA foreign_key_check");
   assert.equal(fk.rows.length,0);
  }finally{check.close()}
  // DB original no se sobrescribió.
  assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n),161);
  assert.notEqual(base,dest);
  await assert.rejects(restaurarComoNuevaSqlite({
   archivo:backup,clave:"CLAVE FICTICIA SEGURA PARA ENSAYO v410",destino:dest
  }),/EEXIST/);
  assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n),161);
 });
});
test("v4.10: fallo de clave o ubicación no crea/sobrescribe ficheros",async()=>{
 await resguardo(async({backup,dest})=>{
  await assert.rejects(restaurarComoNuevaSqlite({archivo:backup,clave:"clave errónea",destino:dest}),
    /HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
  assert.equal(fs.existsSync(dest),false);
  await assert.rejects(restaurarComoNuevaSqlite({archivo:backup,clave:"CLAVE FICTICIA SEGURA PARA ENSAYO v410",destino:"file:https://turso"}),/HS_STAGING_RUTA_ABSOLUTA_SQLITE_REQUERIDA/);
  assert.equal(fs.existsSync(dest),false);
 });
});
