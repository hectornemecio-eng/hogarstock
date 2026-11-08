"use strict";
// Auditoría de estructura y agregados: no descarga nombres ni mensajes.
// Todo el origen es SQLite local ficticia y nunca hay conexiones Turso.
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {mkdtempSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {auditarV2SoloLectura,SQL_PERMITIDO}=
  require("../integration/v3-auditoria-v2-solo-lectura.js");
async function fixture(t,{crear=true,esquema="normal"}={}) {
  const dir=mkdtempSync(join(tmpdir(),"hs-auditoria-v2-fake-"));
  const db=createClient({url:"file:"+join(dir,"origen-v2.sqlite")});
  t.after(async()=>db.close());
  if(crear){
    const sql=esquema==="malo"
      ? "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,agotado INTEGER)"
      : "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)";
    await db.execute(sql);
  }
  const consultas=[];
  const proxy={
    async execute(q){
      const sentencia=typeof q==="string"?q:q.sql;
      consultas.push(sentencia);
      assert.ok(SQL_PERMITIDO.includes(sentencia),"Solo SQL fijo de lectura");
      assert.match(sentencia,/^(SELECT|PRAGMA)\b/i);
      return db.execute(q);
    },
  };
  return {db,proxy,consultas};
}
test("Audita 150 productos ficticios sin leer nombres ni credenciales",async t=>{
  const f=await fixture(t);
  const instrucciones=[];
  for(let i=1;i<=150;i++) instrucciones.push({
    sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES(?,?,?,?)",
    args:[i,"SECRETO_FICTICIO_NOMBRE_"+i,"Categoría privada",Number(i%3===0)],
  });
  await f.db.batch(instrucciones,"write");
  await f.db.execute("CREATE TABLE baileys_auth_v2(clave TEXT)");
  await f.db.execute({
    sql:"INSERT INTO baileys_auth_v2 VALUES(?)",
    args:["TOKEN_SUPER_PRIVADO_FICTICIO"],
  });
  const r=await auditarV2SoloLectura(f.proxy);
  assert.equal(r.compatible,true);
  assert.equal(r.catalogo.total,150);
  assert.equal(r.catalogo.agotados,50);
  assert.equal(r.catalogo.disponibles,100);
  assert.equal(r.hayTablasAuthBaileys,true);
  assert.equal(r.consultasEjecutadas,3);
  assert.equal(r.autorizaMigracion,false);
  assert.equal(r.respaldoVerificado,false);
  assert.equal(f.consultas.length,3);
  const salida=JSON.stringify(r);
  assert.ok(!salida.includes("SECRETO_FICTICIO_NOMBRE_"));
  assert.ok(!salida.includes("TOKEN_SUPER_PRIVADO_FICTICIO"));
  assert.ok(!salida.includes("Categoría privada"));
});
test("Origen sin productos: informe no autoriza migración y solo una consulta",async t=>{
  const f=await fixture(t,{crear:false});
  const r=await auditarV2SoloLectura(f.proxy);
  assert.equal(r.esquema,"PRODUCTOS_AUSENTE");
  assert.equal(r.compatible,false);
  assert.equal(f.consultas.length,1);
});
test("Esquema incompleto: informa ausencia de categoría sin consultar filas",async t=>{
  const f=await fixture(t,{esquema:"malo"});
  const r=await auditarV2SoloLectura(f.proxy);
  assert.equal(r.esquema,"PRODUCTOS_INCOMPATIBLE");
  assert.deepEqual(r.columnasAusentes,["categoria"]);
  assert.equal(r.compatible,false);
  assert.equal(f.consultas.length,2);
});
test("Valores no válidos se detectan por agregación sin filtrar filas",async t=>{
  const f=await fixture(t);
  await f.db.batch([
    "INSERT INTO productos VALUES (1,'Normal','A',1)",
    "INSERT INTO productos VALUES (2,'', 'B',0)",
    "INSERT INTO productos VALUES (3,'Anómalo','C',9)",
    "INSERT INTO productos VALUES (4,'NULL','D',NULL)",
  ],"write");
  const r=await auditarV2SoloLectura(f.proxy);
  assert.equal(r.catalogo.estadosInvalidos,2);
  assert.equal(r.catalogo.textosInvalidos,1);
  assert.equal(r.compatible,false);
  assert.equal(r.catalogo.total,4);
});
test("Si existen tablas V3, no declara un V2 listo para migración",async t=>{
  const f=await fixture(t);
  await f.db.execute("CREATE TABLE hogarstock_compras_v3(id INTEGER PRIMARY KEY)");
  const r=await auditarV2SoloLectura(f.proxy);
  assert.equal(r.hayTablasV3,true);
  assert.equal(r.esquema,"V3_PREEXISTENTE_REVISAR");
  assert.equal(r.compatible,false);
});
test("Límite de catálogo y cliente inválido se rechazan",async t=>{
  const f=await fixture(t);
  await f.db.batch([
    "INSERT INTO productos VALUES(1,'Uno','A',1)",
    "INSERT INTO productos VALUES(2,'Dos','A',0)",
  ],"write");
  await assert.rejects(auditarV2SoloLectura(f.proxy,{maxProductos:1}),
    /LIMITE_SUPERADO/);
  await assert.rejects(auditarV2SoloLectura({}),/CLIENTE_INVALIDO/);
  await assert.rejects(auditarV2SoloLectura(f.proxy,{maxProductos:0}),
    /LIMITE_INVALIDO/);
});
test("Metadatos falsos y respuestas numéricas incoherentes se rechazan",async()=>{
  let paso=0;
  const f={async execute(q){
    paso++;
    if(paso===1) return {rows:[{name:"productos"},{name:"baileys_auth; DROP TABLE x"}]};
    throw Error("NO_DEBE_CONTINUAR");
  }};
  await assert.rejects(auditarV2SoloLectura(f),/METADATOS_INVALIDOS/);
  const g={async execute(q){
    if(q===SQL_PERMITIDO[0])return {rows:[{name:"productos"}]};
    if(q===SQL_PERMITIDO[1])return {rows:[
      {name:"id",pk:1},{name:"nombre",pk:0},
      {name:"categoria",pk:0},{name:"agotado",pk:0},
    ]};
    return {rows:[{total:2,agotados:0,disponibles:0,estados_invalidos:0,
      textos_invalidos:0,ids_distintos:2,ids_invalidos:0}]};
  }};
  await assert.rejects(auditarV2SoloLectura(g),/CONTEOS_INCONSISTENTES/);
});
