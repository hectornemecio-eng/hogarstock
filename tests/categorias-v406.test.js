"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const {createClient}=require("@libsql/client");
const crypto=require("node:crypto"),os=require("node:os"),path=require("node:path");
const {CATEGORIAS,categoriaVisible,ordenarProductos}=require("../catalogo/categorias-v406");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");
const {crearGrantsV2}=require("../security/v2-grants");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const original=[...fs.readFileSync("db.js","utf8").matchAll(/\{ n: "([^"]+)", c: "([^"]+)" \}/g)]
  .map(m=>({nombre:m[1],categoria:m[2]}));

async function dbFicticia(fn){
  const file=path.join(os.tmpdir(),"hs-v406-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
    await fn(db);
  }finally{
    db.close();
    for(const p of [file,file+"-wal",file+"-shm"]){try{fs.unlinkSync(p)}catch(_){}}
  }
}
test("v4.06: los 150 productos iniciales se distribuyen exactamente en diez grupos",()=>{
  assert.equal(original.length,150);
  assert.equal(CATEGORIAS.length,10);
  const items=ordenarProductos(original.map((p,i)=>({...p,id:i+1,agotado:0})));
  const conteo=Object.fromEntries(CATEGORIAS.map(c=>[c,items.filter(p=>p.categoria===c).length]));
  assert.deepEqual(conteo,{
    "Frutas":10,"Verduras y tubérculos":16,"Carnes, pescados y embutidos":14,
    "Lácteos y huevos":12,"Despensa y cocina":27,"Desayunos, snacks y bebidas":17,
    "Limpieza y lavandería":12,"Papel y artículos del hogar":10,
    "Higiene personal":18,"Cosmética y belleza":14
  });
  assert.deepEqual(items.map(x=>x.id).sort((a,b)=>a-b),Array.from({length:150},(_,i)=>i+1));
  assert.equal(categoriaVisible("Producto a medida","Categoría especial"),"Categoría especial");
  assert.equal(categoriaVisible("Aguacates","Frutas"),"Frutas");
  assert.equal(categoriaVisible("Alcohol","Despensa"),"Despensa y cocina");
});
test("v4.06: catálogo consulta proyectada sin alterar el estado ni categoría de Turso",async()=>{
  await dbFicticia(async db=>{
    await db.batch(original.map((p,i)=>({
      sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[i+1,p.nombre,p.categoria,i%2]
    })),"write");
    const cat=crearGestionCatalogo({db});
    await cat.init();
    const items=await cat.listar();
    assert.equal(items.length,150);
    assert.equal(items.filter(p=>p.agotado).length,75);
    assert.equal(new Set(items.map(p=>p.categoria)).size,10);
    const raw=await db.execute("SELECT count(DISTINCT categoria) AS n,sum(agotado) AS pendientes FROM productos");
    assert.equal(Number(raw.rows[0].n),6);
    assert.equal(Number(raw.rows[0].pendientes),75);
    assert.equal(items.find(x=>x.nombre==="Aguacates").categoria,"Frutas");
    const archive=await cat.archivar;
    assert.equal(typeof archive,"function");
  });
});
test("v4.06: el comprador recibe la misma clasificación sin perder IDs ni pendientes",async()=>{
  await dbFicticia(async db=>{
    await db.batch([
      {sql:"INSERT INTO productos VALUES(?,?,?,1)",args:[1,"Manzanas rojas dulces","Frutas y Verduras"]},
      {sql:"INSERT INTO productos VALUES(?,?,?,1)",args:[2,"Papas","Frutas y Verduras"]},
      {sql:"INSERT INTO productos VALUES(?,?,?,1)",args:[3,"Rimel","Higiene Personal"]}
    ],"write");
    const identidad=crearIdentidadV2({entorno:generarMaterial("prueba-v406-comprador-ficticio")});
    const grants=crearGrantsV2({db,identidad,contactos:["34600000001"]});
    await grants.init();
    const c=await grants.crearCompra({telefono:"34600000001"});
    const grant=identidad.leerComprador("Bearer "+c.token);
    const items=await grants.listar({grant});
    assert.deepEqual(items.map(x=>x.categoria),["Frutas","Verduras y tubérculos","Cosmética y belleza"]);
    assert.deepEqual(items.map(x=>x.id),[1,2,3]);
    assert(items.every(x=>x.agotado));
  });
});
test("v4.06: interfaz, iconos, mobile y selección siguen operativos",()=>{
  const admin=fs.readFileSync("public/index.html","utf8");
  const buyer=fs.readFileSync("public/comprador.html","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  for(const c of CATEGORIAS)assert(admin.includes(c)&&buyer.includes(c),c);
  for(const id of ["metricTotal","metricPending","metricAvailable","inventoryTotal",
    "catalogoCategoriaEdit","nuevaCategoria","btnEnviar","contactosSeleccionados"])
    assert(admin.includes('id="'+id+'"'),id);
  assert.equal((admin.match(/<select id="nuevaCategoria"/g)||[]).length,1);
  assert.equal((admin.match(/<select id="catalogoCategoriaEdit"/g)||[]).length,1);
  assert(css.includes(".page-admin .category-label"));
  assert(css.includes(".page-buyer .buyer-category-icon"));
  assert(css.includes("@media(max-width:650px)"));
  for(const html of [admin,buyer]){
    for(const m of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)){
      if(m[1].trim())new vm.Script(m[1]);
    }
  }
});
