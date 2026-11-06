"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {auditarEsquemaSinEscritura}=require("../integration/v3-readonly-schema-audit.js");
function simular({tablas=["productos"],columnas=["id","nombre","categoria","agotado"],pk=1}={}){
  const consultas=[];
  const cliente={async execute(sql){
    consultas.push(sql);
    assert.match(sql,/^(SELECT name FROM sqlite_master|PRAGMA table_info\(productos\))/);
    if(sql.startsWith("SELECT"))return {rows:tablas.map(name=>({name}))};
    return {rows:columnas.map(name=>({name,pk:name==="id"?pk:0}))};
  }};
  return {cliente,consultas};
}
test("Auditoria de solo lectura: catalogo V2 compatible nunca autoriza despliegue",async()=>{
  const {cliente,consultas}=simular();
  const x=await auditarEsquemaSinEscritura(cliente);
  assert.equal(x.estado,"CATALOGO_V2_COMPATIBLE_EN_ESTRUCTURA");
  assert.equal(x.catalogoCompatible,true);
  assert.equal(x.aptoParaDespliegue,false);
  assert.equal(x.respaldoVerificado,false);
  assert.equal(x.operacion,"SOLO_LECTURA");
  assert.equal(consultas.length,2);
});
test("Falla cerrado cuando falta productos y no consulta columnas",async()=>{
  const {cliente,consultas}=simular({tablas:["compras"]});
  const x=await auditarEsquemaSinEscritura(cliente);
  assert.equal(x.estado,"SIN_TABLA_PRODUCTOS");
  assert.equal(consultas.length,1);
});
test("Incompatibilidad de columnas o clave primaria es detectada",async()=>{
  let x=await auditarEsquemaSinEscritura(simular({columnas:["id","nombre"]}).cliente);
  assert.equal(x.estado,"CATALOGO_INCOMPATIBLE");
  assert.deepEqual(x.columnasRequeridasAusentes,["categoria","agotado"]);
  x=await auditarEsquemaSinEscritura(simular({pk:0}).cliente);
  assert.equal(x.catalogoCompatible,false);
});
test("Tablas V3 previas obligan a revision y no se eliminan",async()=>{
  const x=await auditarEsquemaSinEscritura(simular({
    tablas:["productos","hogarstock_admin_sessions_v3","hogarstock_wa_outbox_v3"],
  }).cliente);
  assert.equal(x.estado,"V3_PREEXISTENTE_A_REVISAR");
  assert.equal(x.tablasV3Detectadas.length,2);
});
test("Metadatos inválidos o cliente incompleto: rechazo",async()=>{
  await assert.rejects(auditarEsquemaSinEscritura({}),/CLIENTE_INVALIDO/);
  await assert.rejects(auditarEsquemaSinEscritura(simular({tablas:["productos; DROP TABLE x"]}).cliente),/METADATOS_INVALIDOS/);
  await assert.rejects(auditarEsquemaSinEscritura(simular({tablas:["productos","productos"]}).cliente),/METADATOS_DUPLICADOS/);
});
