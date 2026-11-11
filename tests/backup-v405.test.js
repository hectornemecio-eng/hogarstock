"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {crearRespaldoCifrado,abrirRespaldo,restaurarAislado}=require("../backup/backup-safe");
const os=require("node:os"),path=require("node:path"),fs=require("node:fs"),crypto=require("node:crypto");

test("v4.05: respaldo aislado incluye archivados, envíos pendientes y claves ficticias",async()=>{
  const fichero=path.join(os.tmpdir(),"hsbk-v405-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+fichero});
  try{
    await db.batch([
      "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)",
      "CREATE TABLE hs_catalogo_archivados(producto_id INTEGER PRIMARY KEY REFERENCES productos(id),fecha INTEGER)",
      "CREATE TABLE hs_v2_admin_password(id INTEGER PRIMARY KEY,salt TEXT,hash TEXT,revision INTEGER,actualizada INTEGER)",
      "CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,token_hash TEXT,telefono TEXT,creada INTEGER,expira INTEGER,estado TEXT)",
      "CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT,PRIMARY KEY(compra_id,producto_id))",
      "CREATE TABLE hs_v2_security_envios(compra_id TEXT,telefono TEXT,enviado INTEGER,PRIMARY KEY(compra_id,telefono))",
      "CREATE TABLE hs_v2_wa_auth_encrypted(id TEXT PRIMARY KEY,payload TEXT,actualizado INTEGER)"
    ],"write");
    const id="a".repeat(48);
    await db.execute({sql:"INSERT INTO productos VALUES(7,'Producto inventado','Prueba',0)",args:[]});
    await db.execute({sql:"INSERT INTO hs_catalogo_archivados VALUES(7,?)",args:[Date.now()]});
    await db.execute({sql:"INSERT INTO hs_v2_admin_password VALUES(1,?,?,1,?)",args:["b".repeat(64),"c".repeat(64),Date.now()]});
    await db.execute({sql:"INSERT INTO hs_v2_security_grants VALUES(?,?,?,?,?,'abierta')",args:[id,"d".repeat(64),"34600000001",Date.now(),Date.now()+60000]});
    await db.execute({sql:"INSERT INTO hs_v2_security_envios VALUES(?,?,0)",args:[id,"34600000001"]});
    await db.execute({sql:"INSERT INTO hs_v2_wa_auth_encrypted VALUES('creds','ficticio',?)",args:[Date.now()]});
    const x=await crearRespaldoCifrado(db,"frase-completamente-ficticia-v405");
    const snapshot=abrirRespaldo(x.archivo,"frase-completamente-ficticia-v405");
    const archived=snapshot.tablas.find(t=>t.nombre==="hs_catalogo_archivados");
    const envios=snapshot.tablas.find(t=>t.nombre==="hs_v2_security_envios");
    assert(archived&&envios);
    assert.equal(archived.total,1);
    assert.equal(envios.total,1);
    assert(envios.filas[0].some(v=>v?.t==="number"&&v.v===0));
    const restored=await restaurarAislado(snapshot);
    assert.deepEqual(restored,{ok:true,tablas:x.tablas,filas:x.filas});
    const original=await db.execute("SELECT count(*) AS n FROM productos");
    assert.equal(Number(original.rows[0].n),1);
  }finally{
    db.close();
    for(const f of [fichero,fichero+"-wal",fichero+"-shm"]){try{fs.unlinkSync(f)}catch(_){}}
  }
});
