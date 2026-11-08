"use strict";
// Fuente V2 y destino V3: dos SQLite locales ficticias, ningún token remoto.
// Prueba los invariantes de conservación, ausencia de mutación en origen y
// atomicidad de lote de destino. No abrir jamás una BD de producción.
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes,createHash}=require("node:crypto");
const {mkdtempSync,readFileSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {leerCatalogoV2,simularMigracionCatalogo}=
  require("../integration/v3-migracion-catalogo-simulada.js");
const {iniciarModulosV3}=require("../integration/turso-stage-bootstrap.js");

const entorno={
  HOGARSTOCK_V3_SANDBOX:"1",
  HOGARSTOCK_V3_MIGRACION_LAB:"1",
};
const fotos=[
  [3,"Leche ficticia","Lácteos",1],
  [47,"Aguacates","Frutas y Verduras",0],
  [150,"Arroz integral","Despensa",1],
  [1001,"Piñones y ñame","Despensa",0],
];
async function escenario(t,{v2=true,campos=null}={}){
  const dir=mkdtempSync(join(tmpdir(),"hs-v2-v3-mig-fake-"));
  const origen=createClient({url:"file:"+join(dir,"source-v2.sqlite")});
  const destino=createClient({url:"file:"+join(dir,"destino-v3.sqlite")});
  t.after(async()=>{await origen.close();await destino.close();});
  const sql=campos||"id INTEGER PRIMARY KEY AUTOINCREMENT,"+
    "nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0";
  if(v2){
    await origen.execute("CREATE TABLE productos ("+sql+")");
    if(!campos){
      for(const x of fotos)await origen.execute({
        sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES(?,?,?,?)",args:x,
      });
    }
    await origen.execute("CREATE TABLE baileys_auth_v2 (clave TEXT NOT NULL)");
    await origen.execute({
      sql:"INSERT INTO baileys_auth_v2(clave) VALUES(?)",
      args:["CREDENCIAL_FICTICIA_NO_MIGRAR"],
    });
  }
  return {origen,destino,dir};
}
const origenLectura=cliente=>{
  const queries=[];
  return {
    async execute(q) {
      const sql=typeof q==="string"?q:q.sql;
      queries.push(sql);
      assert.match(sql,/^(SELECT|PRAGMA)\b/i);
      return cliente.execute(q);
    },
    queries,
  };
};
async function leer(e,origen=e.origen){
  return leerCatalogoV2(origen);
}
test("V2 -> V3 conserva IDs dispersos, tildes y estado agotado sin cambiar origen",async t=>{
  const e=await escenario(t),proxy=origenLectura(e.origen);
  const antes=await leer(e);
  const r=await simularMigracionCatalogo({
    origen:proxy,destino:e.destino,entorno,confirmacion:true,
    huellaEsperada:antes.reporte.huellaSha256,
  });
  assert.equal(r.operacion,"ENSAYO_SQLITE_AISLADO");
  assert.equal(r.productosMigrados,4);
  assert.equal(r.agotadosPreservados,2);
  assert.equal(r.aptoParaProduccion,false);
  assert.equal(r.credencialesWhatsAppMigradas,false);
  assert.equal(r.historialComprasLegacyMigrado,false);
  assert.deepEqual((await e.destino.execute(
    "SELECT id,nombre,categoria,agotado FROM productos ORDER BY id")).rows
    .map(x=>[Number(x.id),String(x.nombre),String(x.categoria),Number(x.agotado)]),fotos);
  const tablas=(await e.destino.execute(
    "SELECT name FROM sqlite_master WHERE type='table'")).rows.map(x=>x.name);
  assert.equal(tablas.includes("baileys_auth_v2"),false);
  assert.equal(tablas.includes("hogarstock_v3_migration_dryrun_proof"),true);
  const despues=await leer(e);
  assert.equal(despues.reporte.huellaSha256,antes.reporte.huellaSha256);
  assert.equal(despues.reporte.tablasLegacyBaileysPresentes,1);
  assert.ok(proxy.queries.every(q=>/^(SELECT|PRAGMA)/.test(q)));
  assert.ok(proxy.queries.length>=3);
});
test("La copia puede inicializar almacenes V3 sin recuperar secretos V2",async t=>{
  const e=await escenario(t);
  const a=await leer(e);
  await simularMigracionCatalogo({
    origen:e.origen,destino:e.destino,entorno,
    confirmacion:true,huellaEsperada:a.reporte.huellaSha256,
  });
  const claves={auth:randomBytes(32).toString("hex"),
    inbox:randomBytes(32).toString("hex"),
    outbox:randomBytes(32).toString("hex")};
  const v3=await iniciarModulosV3({cliente:e.destino,secretos:claves});
  const compra=await v3.compras.crearCompra({
    lineas:[{productoId:3},{productoId:150}],
  });
  assert.equal(compra.cantidad,2);
  assert.equal((await v3.compras.obtenerCompra({compraId:compra.compraId})).items.length,2);
  assert.equal((await leer(e)).reporte.productos,4);
});
test("Rechaza origen y destino idénticos y destino preexistente",async t=>{
  const e=await escenario(t);
  const a=await leer(e);
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino:e.origen,entorno,confirmacion:true,
    huellaEsperada:a.reporte.huellaSha256,
  }),/DESTINO_NO_SEPARADO/);
  await e.destino.execute("CREATE TABLE datos_ajenos(x TEXT)");
  await e.destino.execute("INSERT INTO datos_ajenos VALUES('NO_TOCAR')");
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino:e.destino,entorno,confirmacion:true,
    huellaEsperada:a.reporte.huellaSha256,
  }),/DESTINO_NO_VACIO/);
  assert.equal((await e.destino.execute(
    "SELECT x FROM datos_ajenos")).rows[0].x,"NO_TOCAR");
});
test("Falta de autorización o banderas correctas bloquea antes de leer",async t=>{
  const e=await escenario(t);
  let queries=0;
  const origen={async execute(){queries++;throw Error("NO_LEER");}};
  const destino={async execute(){throw Error("NO_ESCRIBIR");},async batch(){}};
  for(const v of [
    {},{HOGARSTOCK_V3_SANDBOX:"1"},
    {...entorno,TURSO_DATABASE_URL:"libsql://produccion.turso.io"},
    {...entorno,TURSO_AUTH_TOKEN:"FICTICIO"},
    {...entorno,HOGARSTOCK_STAGING_TURSO_URL:"libsql://staging.turso.io"},
    {...entorno,HOGARSTOCK_STAGING_TURSO_TOKEN:"FICTICIO"},
    {...entorno,HOGARSTOCK_V3_REMOTE_STAGE:"1"},
    {...entorno,WA_MASTER_KEY:"FICTICIA"},
    {...entorno,WA_ALLOWED_NUMBERS:"123"},
    {...entorno,WHATSAPP_ENABLED:"1"},
  ]){
    await assert.rejects(simularMigracionCatalogo({
      origen,destino,confirmacion:true,entorno:v,huellaEsperada:"0".repeat(64),
    }),/SOLO_SANDBOX/);
  }
  await assert.rejects(simularMigracionCatalogo({
    origen,destino,confirmacion:false,entorno,huellaEsperada:"0".repeat(64),
  }),/CONFIRMACION_REQUERIDA/);
  assert.equal(queries,0);
});
test("Huella equivocada, nueva edición o conteo obsoleto bloquean",async t=>{
  const e=await escenario(t);
  const a=await leer(e);
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino:e.destino,entorno,confirmacion:true,
    huellaEsperada:"f".repeat(64),
  }),/HUELLA_NO_COINCIDE/);
  await e.origen.execute("UPDATE productos SET agotado=0 WHERE id=3");
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino:e.destino,entorno,confirmacion:true,
    huellaEsperada:a.reporte.huellaSha256,
  }),/HUELLA_NO_COINCIDE/);
  assert.equal((await e.destino.execute(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")).rows[0].n,0);
});
test("Origen sin productos, con V3 o con esquema incompatible queda intacto",async t=>{
  const e=await escenario(t,{v2:false});
  await assert.rejects(leer(e),/TABLA_PRODUCTOS_AUSENTE/);
  await e.origen.execute(
    "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT)");
  await assert.rejects(leer(e),/ESQUEMA_V2_INCOMPATIBLE/);
  await e.origen.execute(
    "CREATE TABLE hogarstock_compras_v3(id INTEGER PRIMARY KEY)");
  await assert.rejects(leer(e),/ORIGEN_CONTIENE_V3/);
});
test("Estados NULL, ambiguos o nombres vacíos no se silencian",async t=>{
  const e=await escenario(t,{v2:false});
  await e.origen.execute(
    "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
  await e.origen.execute(
    "INSERT INTO productos VALUES(1,'Ficticio','Ensayo',2)");
  await assert.rejects(leer(e),/CATALOGO_NO_VALIDO/);
  await e.origen.execute("UPDATE productos SET agotado=1,nombre='' WHERE id=1");
  await assert.rejects(leer(e),/CATALOGO_NO_VALIDO/);
  await e.origen.execute("UPDATE productos SET nombre='Valido',categoria=NULL WHERE id=1");
  await assert.rejects(leer(e),/CATALOGO_NO_VALIDO/);
});
test("Fallo transaccional simulado sobre destino revierte el lote completo",async t=>{
  const e=await escenario(t);
  const a=await leer(e);
  const destino={
    execute:e.destino.execute.bind(e.destino),
    async batch(sql,modo){
      assert.equal(modo,"write");
      return e.destino.batch([...sql,"INSERT INTO tabla_inexistente VALUES(1)"],modo);
    },
  };
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino,entorno,confirmacion:true,
    huellaEsperada:a.reporte.huellaSha256,
  }),/no such table|SQLITE_ERROR/i);
  const t1=await e.destino.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='productos'");
  assert.equal(t1.rows.length,0);
  assert.equal((await leer(e)).reporte.productos,4);
});
test("Un segundo ensayo no reescribe una copia ya creada",async t=>{
  const e=await escenario(t);
  const a=await leer(e);
  const params={origen:e.origen,destino:e.destino,entorno,
    confirmacion:true,huellaEsperada:a.reporte.huellaSha256};
  await simularMigracionCatalogo(params);
  await assert.rejects(simularMigracionCatalogo(params),/DESTINO_NO_VACIO/);
  assert.equal((await e.destino.execute(
    "SELECT COUNT(*) AS n FROM productos")).rows[0].n,4);
});

test("Dos clientes SQL distintos que apuntan al mismo archivo se rechazan",async t=>{
  const e=await escenario(t);
  const misma=createClient({url:"file:"+join(e.dir,"source-v2.sqlite")});
  t.after(async()=>misma.close());
  const a=await leer(e);
  await assert.rejects(simularMigracionCatalogo({
    origen:e.origen,destino:misma,entorno,confirmacion:true,
    huellaEsperada:a.reporte.huellaSha256,
  }),/RUTA_NO_AUTORIZADA|DESTINO_FISICO_NO_AISLADO/);
  assert.equal((await leer(e)).reporte.huellaSha256,a.reporte.huellaSha256);
});
test("Dos clientes no locales que simulan un esquema válido se bloquean antes de escribir",async()=>{
  let llamadas=0;
  const remoto={
    async execute(q){
      llamadas++;
      if(q==="PRAGMA database_list")return {rows:[{name:"main",file:""}]};
      throw Error("NO_DEBE_LEER_DATOS_REMOTOS");
    },
    async batch(){throw Error("NO_DEBE_ESCRIBIR");},
  };
  await assert.rejects(simularMigracionCatalogo({
    origen:remoto,destino:{...remoto},entorno,confirmacion:true,
    huellaEsperada:"0".repeat(64),
  }),/NO_ES_BASE_LOCAL/);
  assert.equal(llamadas,1);
});
