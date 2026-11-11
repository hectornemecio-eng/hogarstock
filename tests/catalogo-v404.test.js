"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");
const {crearGrantsV2}=require("../security/v2-grants");

async function laboratorio(fn){
  const nombre=path.join(os.tmpdir(),"hogarstock-v404-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+nombre});
  try{
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY, token_hash TEXT, telefono TEXT, creada INTEGER, expira INTEGER,estado TEXT)");
    await db.execute("CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT)");
    const catalogo=crearGestionCatalogo({db});
    await catalogo.init();
    await fn({db,catalogo});
  }finally{
    db.close();
    for(const f of [nombre,nombre+"-wal",nombre+"-shm"]){try{fs.unlinkSync(f);}catch(_){}}
  }
}
test("v4.04: alta, edicion, deteccion duplicados y validacion estricta",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const primero=await catalogo.crear({nombre:" Leche  sin lactosa ",categoria:"Lácteos"});
    assert.equal(primero.nombre,"Leche sin lactosa");
    assert.equal((await catalogo.listar()).length,1);
    await assert.rejects(catalogo.crear({nombre:"leche sin lactosa",categoria:"lácteos"}),/HS_CATALOGO_DUPLICADO/);
    await assert.rejects(catalogo.crear({nombre:"",categoria:"Lácteos"}),/HS_CATALOGO_NOMBRE_INVALIDO/);
    await assert.rejects(catalogo.crear({nombre:"X",categoria:"\n"}),/HS_CATALOGO_CATEGORIA_INVALIDO/);
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
    await db.execute({sql:"INSERT INTO hs_v2_security_grants(compra_id,estado,expira) VALUES(?,?,?)",
      args:["compra-ficticia","abierta",Date.now()+60000]});
    await db.execute({sql:"INSERT INTO hs_v2_security_items VALUES(?,?,?)",
      args:["compra-ficticia",p.id,"pendiente"]});
    await assert.rejects(catalogo.editar({id:p.id,nombre:"Papas",categoria:"Verduras"}),/HS_CATALOGO_COMPRA_ACTIVA/);
    await assert.rejects(catalogo.archivar({id:p.id}),/HS_CATALOGO_COMPRA_ACTIVA/);
    assert.equal((await catalogo.listar()).length,1);
    await db.execute("UPDATE hs_v2_security_grants SET estado='finalizada'");
    await db.execute({sql:"UPDATE productos SET agotado=1 WHERE id=?",args:[p.id]});
    await catalogo.archivar({id:p.id});
    assert.equal((await catalogo.listar()).length,0);
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos")).rows[0].n),1);
    assert.equal(Number((await db.execute({sql:"SELECT agotado FROM productos WHERE id=?",args:[p.id]})).rows[0].agotado),0);
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM productos WHERE agotado=1")).rows[0].n),0);
    assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM hs_v2_security_items")).rows[0].n),1);
    await assert.rejects(catalogo.archivar({id:p.id}),/HS_CATALOGO_NO_ENCONTRADO/);
  });
});
test("v4.04: las rutas requieren administrador con CSRF y no exponen escrituras a compradores",()=>{
  const server=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  for(const accion of ["crear","editar","archivar","recuperar"]){
    assert(server.includes('app.post("/api/admin/catalogo/'+accion+'",http.adminWrite'));
    assert(ui.includes("/api/admin/catalogo/"+accion));
  }
  assert(server.includes("await catalogo.init()"));
  assert(server.includes('broadcast({type:"update",productos:await catalogo.listar()})'));
  assert(ui.includes('onsubmit="anadirProducto(event)"'));
  assert(ui.includes('onclick="archivarProductoCatalogo()"'));
});

test("v4.04: el endpoint de marcado no puede reactivar un producto archivado",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const grants=crearGrantsV2({db,contactos:[],
      identidad:{emitirComprador(){throw Error("SIN_COMPRAS_EN_TEST");}}});
    await grants.init();
    const p=await catalogo.crear({nombre:"Aceite de prueba",categoria:"Despensa"});
    const primera=await grants.alternarProducto({
      productoId:p.id,verificarActivo:catalogo.verificarActivo
    });
    assert.equal(primera.nuevoEstado,1);
    await catalogo.archivar({id:p.id});
    await assert.rejects(
      grants.alternarProducto({productoId:p.id,verificarActivo:catalogo.verificarActivo}),
      /HS_CATALOGO_NO_ENCONTRADO/
    );
    assert.equal(Number((await db.execute({sql:"SELECT agotado FROM productos WHERE id=?",args:[p.id]})).rows[0].agotado),0);
    assert.equal((await catalogo.listar()).length,0);
    const ok=await catalogo.crear({nombre:"Arroz de prueba",categoria:"Despensa"});
    const segunda=await grants.alternarProducto({
      productoId:ok.id,verificarActivo:catalogo.verificarActivo
    });
    assert.equal(segunda.nuevoEstado,1);
  });
});
test("v4.04: escritura confirmada tiene respuesta de exito aunque falle notificacion",()=>{
  const src=fs.readFileSync("server.js","utf8");
  const a=src.indexOf("async function ejecutarCambioCatalogo(");
  const b=src.indexOf('app.post("/api/admin/catalogo/crear"',a);
  assert(a>0&&b>a);
  const procedimiento=src.slice(a,b);
  assert(procedimiento.includes("resultado=await accion()"));
  assert(procedimiento.includes("catch(error){return errorCatalogo(res,error);}"));
  assert(procedimiento.includes("return res.json({ok:true,...resultado})"));
});

test("v4.04: archivar y recuperar conserva identificador e historial, vuelve disponible",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const p=await catalogo.crear({nombre:"Arroz integral",categoria:"Despensa"});
    await db.execute({sql:"UPDATE productos SET agotado=1 WHERE id=?",args:[p.id]});
    await catalogo.archivar({id:p.id});
    const archivados=await catalogo.listarArchivados();
    assert.equal(archivados.length,1);
    assert.equal(archivados[0].id,p.id);
    assert.equal((await catalogo.listar()).length,0);
    const restaurado=await catalogo.recuperar({id:p.id});
    assert.equal(restaurado.recuperado,true);
    assert.equal(restaurado.agotado,0);
    assert.equal((await catalogo.listarArchivados()).length,0);
    const listado=await catalogo.listar();
    assert.equal(listado.length,1);
    assert.equal(listado[0].id,p.id);
    assert.equal(listado[0].agotado,0);
    await assert.rejects(catalogo.recuperar({id:p.id}),/HS_CATALOGO_NO_ARCHIVADO/);
  });
});
test("v4.04: si se reutilizó nombre y categoría de archivado, restauración no duplica",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const original=await catalogo.crear({nombre:"Café",categoria:"Despensa"});
    await catalogo.archivar({id:original.id});
    const nuevo=await catalogo.crear({nombre:"Café",categoria:"Despensa"});
    await assert.rejects(catalogo.recuperar({id:original.id}),/HS_CATALOGO_DUPLICADO/);
    assert.equal((await catalogo.listarArchivados()).length,1);
    assert.equal((await catalogo.listar()).length,1);
    assert.equal((await catalogo.listar())[0].id,nuevo.id);
    await catalogo.editar({id:nuevo.id,nombre:"Café molido",categoria:"Despensa"});
    await catalogo.recuperar({id:original.id});
    assert.equal((await catalogo.listar()).length,2);
  });
});
test("v4.04: ver archivados solo para administrador y recuperar requiere CSRF",()=>{
  const server=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  assert(server.includes('app.get("/api/admin/catalogo/archivados",http.admin'));
  assert(server.includes('app.post("/api/admin/catalogo/recuperar",http.adminWrite'));
  assert(ui.includes('onclick="consultarArchivadosCatalogo()"'));
  assert(ui.includes('onclick="recuperarProductoCatalogo()"'));
});
