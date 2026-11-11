"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {createClient}=require("@libsql/client");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");

async function laboratorio(fn){
  const db=createClient({url:"file::memory:"});
  try{
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,estado TEXT,expira INTEGER)");
    await db.execute("CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT)");
    const catalogo=crearGestionCatalogo({db});
    await catalogo.init();
    await fn({db,catalogo});
  }finally{db.close();}
}
test("v4.04: alta, edicion, deteccion duplicados y validacion estricta",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const primero=await catalogo.crear({nombre:" Leche  sin lactosa ",categoria:"Lácteos"});
    assert.equal(primero.nombre,"Leche sin lactosa");
    assert.equal((await catalogo.listar()).length,1);
    await assert.rejects(catalogo.crear({nombre:"leche sin lactosa",categoria:"lácteos"}),/HS_CATALOGO_DUPLICADO/);
    await assert.rejects(catalogo.crear({nombre:"",categoria:"Lácteos"}),/HS_CATALOGO_NOMBRE_INVALIDO/);
    await assert.rejects(catalogo.crear({nombre:"X",categoria:"\\n"}),/HS_CATALOGO_CATEGORIA_INVALIDO/);
    await catalogo.editar({id:primero.id,nombre:"Leche",categoria:"Despensa"});
    const p=(await catalogo.listar())[0];
    assert.equal(p.nombre,"Leche");
    assert.equal(p.categoria,"Despensa");
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n),1);
  });
});
test("v4.04: archivado logico preserva filas y bloquea editar/archivar activo",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const p=await catalogo.crear({nombre:"Patatas",categoria:"Verduras"});
    await db.execute({sql:"INSERT INTO hs_v2_security_grants VALUES(?,?,?)",
      args:["compra-ficticia","abierta",Date.now()+60000]});
    await db.execute({sql:"INSERT INTO hs_v2_security_items VALUES(?,?,?)",
      args:["compra-ficticia",p.id,"pendiente"]});
    await assert.rejects(catalogo.editar({id:p.id,nombre:"Papas",categoria:"Verduras"}),/HS_CATALOGO_COMPRA_ACTIVA/);
    await assert.rejects(catalogo.archivar({id:p.id}),/HS_CATALOGO_COMPRA_ACTIVA/);
    assert.equal((await catalogo.listar()).length,1);
    await db.execute("UPDATE hs_v2_security_grants SET estado='finalizada'");
    await catalogo.archivar({id:p.id});
    assert.equal((await catalogo.listar()).length,0);
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n),1);
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM hs_v2_security_items")).rows[0].n),1);
    await assert.rejects(catalogo.archivar({id:p.id}),/HS_CATALOGO_NO_ENCONTRADO/);
  });
});
test("v4.04: las rutas requieren administrador con CSRF y no exponen escrituras a compradores",()=>{
  const server=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  for(const accion of ["crear","editar","archivar"]){
    assert(server.includes('app.post("/api/admin/catalogo/'+accion+'",http.adminWrite'));
    assert(ui.includes("/api/admin/catalogo/"+accion));
  }
  assert(server.includes("await catalogo.init()"));
  assert(server.includes('broadcast({type:"update",productos:await catalogo.listar()})'));
  assert(ui.includes('onsubmit="anadirProducto(event)"'));
  assert(ui.includes('onclick="archivarProductoCatalogo()"'));
});
