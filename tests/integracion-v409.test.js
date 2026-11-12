"use strict";
/**
 * v4.09 - Simulacro integral con datos 100% ficticios:
 * catálogo (161), eliminación/recuperación, compra abierta y respaldo/restauración.
 * No llama a Render/Turso remoto ni emite mensajes de WhatsApp.
 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");
const {crearRespaldoCifrado,abrirRespaldo,restaurarAislado,obtenerSnapshot}=require("../backup/backup-safe");
const CLAVE="CLAVE_FICTICIA_INTEGRACION_2026_NO_REAL";

async function preparar(run) {
  const file=path.join(os.tmpdir(),"hs-v409-"+process.pid+"-"+crypto.randomBytes(7).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    await db.batch([
      "CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
      "CREATE TABLE hs_v2_admin_password(id INTEGER PRIMARY KEY,salt TEXT,hash TEXT,revision INTEGER,actualizada INTEGER)",
      "CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,token_hash TEXT,telefono TEXT,creada INTEGER,expira INTEGER,estado TEXT)",
      "CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT,PRIMARY KEY(compra_id,producto_id))",
      "CREATE TABLE hs_v2_security_envios(compra_id TEXT,telefono TEXT,enviado INTEGER,PRIMARY KEY(compra_id,telefono))",
      "CREATE TABLE hs_v2_wa_auth_encrypted(id TEXT PRIMARY KEY,payload TEXT NOT NULL,actualizado INTEGER NOT NULL)",
      "CREATE TABLE hs_catalogo_revision_v407(version TEXT PRIMARY KEY,fecha INTEGER,antes INTEGER,despues INTEGER,detalle TEXT)"
    ],"write");
    const catalogo=crearGestionCatalogo({db});
    await catalogo.init();
    const filas=Array.from({length:161},(_,i)=>({
      sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES (?,?,?,?)",
      args:[i+1,"Producto FICTICIO "+(i+1),"Despensa y cocina",i===0?1:0]
    }));
    await db.batch(filas,"write");
    const id="compra_ficticia_no_real";
    await db.batch([
      {sql:"INSERT INTO hs_v2_admin_password VALUES(1,?,?,2,?)",
       args:["a".repeat(64),"b".repeat(64),Date.now()]},
      {sql:"INSERT INTO hs_v2_security_grants VALUES(?,?,?,?,?,'abierta')",
       args:[id,"c".repeat(64),"34600000001",Date.now(),Date.now()+300000]},
      {sql:"INSERT INTO hs_v2_security_items VALUES(?,1,'pendiente')",args:[id]},
      {sql:"INSERT INTO hs_v2_security_envios VALUES(?,?,0)",args:[id,"34600000001"]},
      {sql:"INSERT INTO hs_v2_wa_auth_encrypted VALUES('creds',?,?)",
       args:["v1.FICTICIO_NO_CREDENCIAL_WA",Date.now()]},
      {sql:"INSERT INTO hs_catalogo_revision_v407 VALUES(?,?,?,?,?)",
       args:["catalogo_v407_20261111",Date.now(),150,161,"[]"]}
    ],"write");
    await run({db,catalogo});
  } finally {
    db.close();
    for(const p of [file,file+"-wal",file+"-shm"])try{fs.unlinkSync(p);}catch(_){}
  }
}
test("v4.09: eliminar y recuperar sin tocar los 161 IDs y protegiendo la compra abierta",async()=>{
  await preparar(async({db,catalogo})=>{
    const antes=await catalogo.listar();
    assert.equal(antes.length,161);
    assert.equal(antes.find(x=>x.id===1).agotado,1);
    await assert.rejects(catalogo.archivar({id:1}),/HS_CATALOGO_COMPRA_ACTIVA/);
    assert.equal((await catalogo.listar()).length,161);
    assert.equal((await db.execute("SELECT COUNT(*) n FROM hs_v2_security_items")).rows[0].n,1);
    const borrado=await catalogo.archivar({id:161});
    assert.equal(borrado.archivado,true);
    const visibles=await catalogo.listar();
    assert.equal(visibles.length,160);
    assert.equal(visibles.some(x=>x.id===161),false);
    const ocultos=await catalogo.listarArchivados();
    assert.equal(ocultos.length,1);
    assert.equal(ocultos[0].id,161);
    assert.equal((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n,161);
    const recuperado=await catalogo.recuperar({id:161});
    assert.equal(recuperado.id,161);
    assert.equal((await catalogo.listar()).length,161);
    // Se mantiene el ID y la compra pendiente.
    assert.equal((await db.execute("SELECT COUNT(*) n FROM hs_v2_security_items")).rows[0].n,1);
    assert.equal((await db.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado,1);
    assert.equal((await catalogo.listarArchivados()).length,0);
  });
});
test("v4.09: respaldo cifrado incluye 161 productos, archivados, compra, WA ficticio y auditoría v4.07",async()=>{
  await preparar(async({db,catalogo})=>{
    await catalogo.archivar({id:161});
    const original=await obtenerSnapshot(db);
    const bruto=await crearRespaldoCifrado(db,CLAVE);
    const desc=abrirRespaldo(bruto.archivo,CLAVE);
    const porNombre=Object.fromEntries(desc.tablas.map(t=>[t.nombre,t]));
    assert.equal(porNombre.productos.total,161);
    assert.equal(porNombre.hs_catalogo_archivados.total,1);
    assert.equal(porNombre.hs_v2_security_grants.total,1);
    assert.equal(porNombre.hs_v2_security_items.total,1);
    assert.equal(porNombre.hs_v2_security_envios.total,1);
    assert.equal(porNombre.hs_v2_wa_auth_encrypted.total,1);
    assert.equal(porNombre.hs_v2_admin_password.total,1);
    assert.equal(porNombre.hs_catalogo_revision_v407.total,1);
    assert.equal(desc.totalFilas,original.totalFilas);
    for(const nombre of Object.keys(porNombre)){
      assert.equal(porNombre[nombre].sha256,original.tablas.find(t=>t.nombre===nombre).sha256);
    }
    assert(!bruto.archivo.includes(Buffer.from("Producto FICTICIO 161")));
    assert(!bruto.archivo.includes(Buffer.from("34600000001")));
    assert(!bruto.archivo.includes(Buffer.from("FICTICIO_NO_CREDENCIAL_WA")));
    assert.deepEqual(await restaurarAislado(desc),{ok:true,tablas:bruto.tablas,filas:bruto.filas});
    // La restauración no modifica el origen.
    assert.equal((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n,161);
    assert.equal((await db.execute("SELECT COUNT(*) n FROM hs_catalogo_archivados")).rows[0].n,1);
    assert.equal((await db.execute("SELECT COUNT(*) n FROM hs_v2_security_grants WHERE estado='abierta'")).rows[0].n,1);
    const corrupto=Buffer.from(bruto.archivo);
    corrupto[corrupto.length-1]^=1;
    assert.throws(()=>abrirRespaldo(corrupto,CLAVE),/HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
    assert.throws(()=>abrirRespaldo(bruto.archivo,"clave-incorrecta-ficticia"),/HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
  });
});
test("v4.09: seguridad operativa no envía WhatsApp ni restaura en producción",()=>{
  const srv=fs.readFileSync("server.js","utf8");
  const lib=fs.readFileSync("backup/backup-safe.js","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  const html=fs.readFileSync("public/index.html","utf8");
  assert(srv.includes('app.post("/api/admin/catalogo/archivar",http.adminWrite'));
  assert(srv.includes('app.post("/api/admin/catalogo/recuperar",http.adminWrite'));
  assert(srv.includes('app.post("/api/admin/respaldo",http.adminWrite'));
  assert(!srv.includes("restaurarAislado("));
  assert(lib.includes('createClient({url:"file::memory:"})'));
  assert(html.includes('class="product-delete"'));
  assert(html.includes('Productos eliminados'));
  assert(css.includes(".page-admin .product-delete"));
});
