"use strict";
// v4.10: solo DB locales, números ficticios y restauración 100% en memoria.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),vm=require("node:vm");
const {createClient}=require("@libsql/client");
const {crearRespaldoCifrado}=require("../backup/backup-safe");
const {LIMITE_WEB,extraerSolicitud,verificarArchivoDescargado}=require("../backup/verificar-v410");

function empaquetar(archivo,clave){
  const k=Buffer.from(clave,"utf8"),b=Buffer.alloc(4+k.length+archivo.length);
  b.writeUInt32BE(k.length,0);k.copy(b,4);archivo.copy(b,4+k.length);
  return b;
}
async function crearArchivoPrueba(){
  const file=path.join(os.tmpdir(),"hs-v410-"+process.pid+"-"+crypto.randomBytes(5).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    await db.batch([
      "CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT,categoria TEXT,agotado INTEGER)",
      "CREATE TABLE hs_catalogo_archivados(producto_id INTEGER PRIMARY KEY REFERENCES productos(id),fecha INTEGER)",
      "CREATE TABLE hs_v2_admin_password(id INTEGER PRIMARY KEY,salt TEXT,hash TEXT,revision INTEGER,actualizada INTEGER)",
      "CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,token_hash TEXT,telefono TEXT,creada INTEGER,expira INTEGER,estado TEXT)",
      "CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT,PRIMARY KEY(compra_id,producto_id),FOREIGN KEY(compra_id) REFERENCES hs_v2_security_grants(compra_id))",
      "CREATE TABLE hs_v2_security_envios(compra_id TEXT,telefono TEXT,enviado INTEGER,PRIMARY KEY(compra_id,telefono))",
      "CREATE TABLE hs_v2_wa_auth_encrypted(id TEXT PRIMARY KEY,payload TEXT,actualizado INTEGER)",
      "CREATE TABLE hs_catalogo_revision_v407(version TEXT PRIMARY KEY,fecha INTEGER,antes INTEGER,despues INTEGER,detalle TEXT)"
    ],"write");
    await db.batch(Array.from({length:161},(_,i)=>({
      sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES(?,?,?,?)",
      args:[i+1,"Inventario inventado "+(i+1),"Categoría de prueba",0]
    })),"write");
    await db.batch([
      {sql:"INSERT INTO hs_catalogo_archivados VALUES(161,?)",args:[Date.now()]},
      {sql:"INSERT INTO hs_v2_admin_password VALUES (1,?,?,1,?)",args:["a".repeat(64),"b".repeat(64),Date.now()]},
      {sql:"INSERT INTO hs_v2_security_grants VALUES(?,?,?,?,?,'finalizada')",args:["ficticia_410","c".repeat(64),"34600000001",Date.now(),Date.now()+120000]},
      {sql:"INSERT INTO hs_v2_security_items VALUES('ficticia_410',1,'comprado')",args:[]},
      {sql:"INSERT INTO hs_v2_security_envios VALUES('ficticia_410','34600000001',1)",args:[]},
      {sql:"INSERT INTO hs_v2_wa_auth_encrypted VALUES('creds',?,?)",args:["VALOR_CIFRADO_FICTICIO",Date.now()]},
      {sql:"INSERT INTO hs_catalogo_revision_v407 VALUES(?,?,?,?,?)",args:["catalogo_v407_20261111",Date.now(),150,161,"[]"]}
    ],"write");
    return (await crearRespaldoCifrado(db,"clave-ficticia-para-test-v410")).archivo;
  }finally{
    db.close();
    for(const f of [file,file+"-wal",file+"-shm"])try{fs.unlinkSync(f)}catch(_){}
  }
}
test("v4.10: copia descargada se descifra, verifica y restaura completamente solo en memoria",async()=>{
  const archivo=await crearArchivoPrueba();
  const datos=await verificarArchivoDescargado(empaquetar(archivo,"clave-ficticia-para-test-v410"));
  assert.equal(datos.verificado,true);
  assert.equal(datos.restauracionAislada,true);
  assert.equal(datos.productos,161);
  assert.equal(datos.productosActivos,160);
  assert.equal(datos.productosEliminados,1);
  assert.equal(datos.compras,1);
  assert.equal(datos.contieneCredencialesWhatsApp,true);
  assert.equal(datos.contieneAuditoriaV407,true);
  assert.equal(datos.sha256,crypto.createHash("sha256").update(archivo).digest("hex"));
  assert.equal(datos.tablas>=8,true);
  assert.equal(/^[a-f0-9]{64}$/.test(datos.sha256),true);
  const exposicion=JSON.stringify(datos);
  for(const secreto of ["ficticia_410","Inventario inventado","34600000001","VALOR_CIFRADO_FICTICIO"])
    assert.equal(exposicion.includes(secreto),false);
});
test("v4.10: clave errónea, manipulación del .hsbk y errores de formato fallan en cerrado",async()=>{
  const archivo=await crearArchivoPrueba();
  await assert.rejects(verificarArchivoDescargado(empaquetar(archivo,"clave-incorrecta-de-prueba")),/HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
  const roto=Buffer.from(archivo);roto[roto.length-1]^=1;
  await assert.rejects(verificarArchivoDescargado(empaquetar(roto,"clave-ficticia-para-test-v410")),/HS_BACKUP_CLAVE_O_INTEGRIDAD_INVALIDA/);
  assert.throws(()=>extraerSolicitud(Buffer.alloc(30)),/HS_VERIFY_ARCHIVO_INVALIDO/);
  assert.throws(()=>extraerSolicitud(Buffer.alloc(LIMITE_WEB+1)),/HS_VERIFY_ARCHIVO_INVALIDO/);
  const raro=Buffer.alloc(80);raro.writeUInt32BE(900,0);
  assert.throws(()=>extraerSolicitud(raro),/HS_VERIFY_SOLICITUD_INVALIDA/);
  const noHSBK=empaquetar(Buffer.alloc(100),"clave-ficticia-para-test-v410");
  assert.throws(()=>extraerSolicitud(noHSBK),/HS_VERIFY_ARCHIVO_INVALIDO/);
});
test("v4.10: múltiples caracteres UTF-8 en frase compatible con el empaquetado binario",()=>{
  const clave="contraseña segura con ñ y 漢字 2026";
  const archivo=Buffer.concat([Buffer.from("HSBK01"),Buffer.alloc(66)]);
  const extraido=extraerSolicitud(empaquetar(archivo,clave));
  assert.equal(extraido.clave,clave);
  assert(extraido.archivo.equals(archivo));
});
test("v4.10: solo administrador con sesión, origen y CSRF; sin ruta REST de restauración productiva",()=>{
  const srv=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  const styles=fs.readFileSync("public/hogarstock-ui.css","utf8");
  const route=srv.indexOf('app.post("/api/admin/respaldo/verificar",http.adminWrite');
  assert(route>0);
  const fragment=srv.slice(route,srv.indexOf('app.get("/api/admin/contactos"',route));
  assert(fragment.includes('express.raw({type:"application/octet-stream",limit:"8mb"})'));
  assert(fragment.includes('await verificarArchivoDescargado(req.body)'));
  assert(fragment.includes("req.body.fill(0)"));
  assert(!/INSERT\s+INTO|UPDATE\s+productos|DELETE\s+FROM|DROP\s+TABLE/i.test(fragment));
  assert(!/app\.post\("\/api\/admin\/restaurar"/.test(srv));
  assert(ui.includes('onsubmit="verificarRespaldoDescargado(event)"'));
  assert(ui.includes('id="backupVerifyFile"'));
  assert(ui.includes('id="backupVerifyPassword"'));
  assert(ui.includes("X-HS-CSRF")); // inyectado por la capa común del panel
  assert(ui.includes("No se guarda una copia subida ni se modifica Turso"));
  assert(ui.includes("conserva también tu archivo de configuración cifrada .hskeys"));
  assert(styles.includes(".page-admin .backup-verify-form"));
  for(const match of ui.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g))
    if(match[1].trim())new vm.Script(match[1]);
});
