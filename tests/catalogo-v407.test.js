"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearRevisionCatalogo,SPLITS,NUEVOS,VERSION}=require("../catalogo/ajustes-v407");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");
const {CATEGORIAS}=require("../catalogo/categorias-v406");
const seed=[...fs.readFileSync("db.js","utf8").matchAll(/\{ n: "([^"]+)", c: "([^"]+)" \}/g)]
  .map(m=>({nombre:m[1],categoria:m[2]}));
async function laboratorio(fn){
  const file=path.join(os.tmpdir(),"hs-catalog-v407-"+process.pid+"-"+crypto.randomBytes(7).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    await db.execute("CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE hs_v2_security_grants (compra_id TEXT PRIMARY KEY, estado TEXT, expira INTEGER)");
    const cat=crearGestionCatalogo({db});
    await cat.init();
    await db.batch(seed.map((p,i)=>({sql:"INSERT INTO productos (id,nombre,categoria,agotado) VALUES(?,?,?,?)",
      args:[i+1,p.nombre,p.categoria,(SPLITS.some(s=>s.origen===p.nombre)?1:0)]})),"write");
    await fn({db,cat,revision:crearRevisionCatalogo({db})});
  }finally{
    db.close();
    for(const f of [file,file+"-wal",file+"-shm"]){try{fs.unlinkSync(f)}catch(_){}}
  }
}
test("v4.07: 4 reemplazos y 7 altas: 150→161, sin perder IDs, estados ni categorías",async()=>{
  assert.equal(seed.length,150);
  await laboratorio(async({db,cat,revision})=>{
    const ids=new Map((await db.execute("SELECT id,nombre,agotado,categoria FROM productos")).rows.map(p=>[String(p.nombre),{
      id:Number(p.id),agotado:Number(p.agotado),categoria:String(p.categoria)
    }]));
    const resultado=await revision.aplicar();
    assert.deepEqual({...resultado},{aplicado:true,antes:150,despues:161,renombrados:4,creados:11,origenesAusentes:0});
    const productos=await cat.listar();
    assert.equal(productos.length,161);
    for(const {origen,destinos} of SPLITS){
      const p=productos.find(x=>x.nombre===destinos[0]);
      assert(p,origen);
      assert.equal(p.id,ids.get(origen).id);
      assert.equal(p.agotado,ids.get(origen).agotado);
      assert(productos.some(x=>x.nombre===destinos[1]&&x.agotado===0));
      assert(!productos.some(x=>x.nombre===origen));
    }
    for(const {nombre,categoria} of NUEVOS){
      const p=productos.filter(x=>x.nombre===nombre);
      assert.equal(p.length,1,nombre);
      assert.equal(p[0].categoria,categoria);
      assert.equal(p[0].agotado,0);
    }
    assert.equal(new Set(productos.map(x=>x.categoria)).size,10);
    const total=Number((await db.execute("SELECT count(*) n FROM productos")).rows[0].n);
    assert.equal(total,161);
    const audit=await db.execute("SELECT * FROM hs_catalogo_revision_v407");
    assert.equal(audit.rows.length,1);
    assert.equal(String(audit.rows[0].version),VERSION);
    assert.equal(JSON.parse(String(audit.rows[0].detalle)).filter(x=>x.tipo==="renombrado").length,4);
  });
});
test("v4.07: segunda ejecución no duplica ni reescribe registros",async()=>{
  await laboratorio(async({db,revision})=>{
    const x=await revision.aplicar();
    assert.equal(x.creados,11);
    const y=await revision.aplicar();
    assert.deepEqual(y,{yaAplicado:true,antes:150,despues:161});
    assert.equal(Number((await db.execute("SELECT count(*) n FROM productos")).rows[0].n),161);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM hs_catalogo_revision_v407")).rows[0].n),1);
  });
});
test("v4.07: no modifica productos durante compra compartida abierta",async()=>{
  await laboratorio(async({db,revision})=>{
    await db.execute({sql:"INSERT INTO hs_v2_security_grants VALUES(?, 'abierta', ?)",
      args:["compra-ficticia",Date.now()+120000]});
    const r=await revision.aplicar();
    assert.deepEqual(r,{aplazado:true,razon:"COMPRA_ACTIVA"});
    assert.equal(Number((await db.execute("SELECT count(*) n FROM productos")).rows[0].n),150);
    await db.execute("UPDATE hs_v2_security_grants SET estado='finalizada'");
    assert.equal((await revision.aplicar()).despues,161);
  });
});
test("v4.07: conflicto de nombres revierte todas las modificaciones atómicamente",async()=>{
  await laboratorio(async({db,revision})=>{
    await db.execute({sql:"INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,0)",
      args:["Yogurt griego grande","Lácteos y Huevos"]});
    await assert.rejects(revision.aplicar(),/HS_CATALOGO_V407_CONFLICTO_RENOMBRE/);
    const r=await db.execute("SELECT nombre FROM productos");
    const names=r.rows.map(x=>String(x.nombre));
    assert(names.includes("Panecillos mercadona e integral"));
    assert(names.includes("Yogurt grande"));
    assert(!names.includes("Panecillos mercadona integral"));
    assert.equal(names.length,151);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM hs_catalogo_revision_v407")).rows[0].n),0);
  });
});
test("v4.07: una alta ya existente no genera duplicados",async()=>{
  await laboratorio(async({db,revision})=>{
    await db.execute({sql:"INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,0)",
      args:["Chuleta","Carnes, pescados y embutidos"]});
    const r=await revision.aplicar();
    assert.equal(r.renombrados,4);
    assert.equal(r.creados,10);
    assert.equal(r.despues,161);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM productos WHERE nombre='Chuleta'")).rows[0].n),1);
  });
});
test("v4.07: productos archivados no se resucitan",async()=>{
  await laboratorio(async({db,revision})=>{
    const r=await db.execute("SELECT id FROM productos WHERE nombre='Yogurt grande'");
    await db.execute({sql:"INSERT INTO hs_catalogo_archivados(producto_id,fecha) VALUES(?,?)",
      args:[r.rows[0].id,Date.now()]});
    const hecho=await revision.aplicar();
    assert.equal(hecho.origenesAusentes,1);
    assert.equal(hecho.renombrados,3);
    assert.equal(hecho.creados,10);
    assert.equal(hecho.despues,160);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM productos WHERE nombre='Yogurt griego grande'")).rows[0].n),0);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM hs_catalogo_archivados")).rows[0].n),1);
  });
});
