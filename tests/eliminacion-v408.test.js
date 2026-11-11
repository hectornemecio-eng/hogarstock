"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const vm=require("node:vm");
const {createClient}=require("@libsql/client");
const {crearGestionCatalogo}=require("../catalogo/gestion-v404");
async function laboratorio(fn){
  const f=path.join(os.tmpdir(),"hogarstock-v408-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+f});
  try {
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)");
    await db.execute("CREATE TABLE hs_v2_security_grants(compra_id TEXT PRIMARY KEY,estado TEXT,expira INTEGER)");
    await db.execute("CREATE TABLE hs_v2_security_items(compra_id TEXT,producto_id INTEGER,estado TEXT)");
    const catalogo=crearGestionCatalogo({db});
    await catalogo.init();
    await fn({db,catalogo});
  } finally {
    db.close();
    for(const x of [f,f+"-wal",f+"-shm"])try{fs.unlinkSync(x);}catch(_){}
  }
}
test("v4.08: eliminar oculta del inventario sin borrar físicamente ni perder ID y permite recuperar",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const antiguo=await catalogo.crear({nombre:"Arroz integral extra",categoria:"Despensa y cocina"});
    await db.execute({sql:"UPDATE productos SET agotado=1 WHERE id=?",args:[antiguo.id]});
    assert.equal((await catalogo.listar()).length,1);
    const eliminado=await catalogo.archivar({id:antiguo.id});
    assert.deepEqual(eliminado,{id:antiguo.id,archivado:true});
    assert.equal((await catalogo.listar()).length,0);
    assert.equal((await catalogo.listarArchivados()).length,1);
    const fila=await db.execute({sql:"SELECT id,nombre,categoria,agotado FROM productos WHERE id=?",args:[antiguo.id]});
    assert.equal(fila.rows.length,1);
    assert.equal(String(fila.rows[0].nombre),"Arroz integral extra");
    assert.equal(Number(fila.rows[0].agotado),0);
    const vuelta=await catalogo.recuperar({id:antiguo.id});
    assert.equal(vuelta.recuperado,true);
    assert.equal(vuelta.id,antiguo.id);
    assert.equal((await catalogo.listar()).length,1);
    assert.equal((await catalogo.listarArchivados()).length,0);
  });
});
test("v4.08: no permite eliminar un producto vinculado a compra activa y mantiene pendientes",async()=>{
  await laboratorio(async({db,catalogo})=>{
    const item=await catalogo.crear({nombre:"Leche para compra",categoria:"Lácteos y huevos"});
    await db.execute({sql:"UPDATE productos SET agotado=1 WHERE id=?",args:[item.id]});
    await db.execute({sql:"INSERT INTO hs_v2_security_grants VALUES(?,?,?)",
      args:["compra-prueba","abierta",Date.now()+120000]});
    await db.execute({sql:"INSERT INTO hs_v2_security_items VALUES(?,?,?)",
      args:["compra-prueba",item.id,"pendiente"]});
    await assert.rejects(catalogo.archivar({id:item.id}),/HS_CATALOGO_COMPRA_ACTIVA/);
    assert.equal((await catalogo.listar()).length,1);
    const resultado=await db.execute("SELECT count(*) AS n FROM hs_v2_security_items WHERE estado='pendiente'");
    assert.equal(Number(resultado.rows[0].n),1);
    await db.execute("UPDATE hs_v2_security_grants SET estado='finalizada'");
    await catalogo.archivar({id:item.id});
    assert.equal((await catalogo.listar()).length,0);
  });
});
test("v4.08: interfaz con botón individual de eliminación accesible y separado del marcado",()=>{
  const html=fs.readFileSync("public/index.html","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  assert(html.includes('class="product-row"'));
  assert(html.includes('class="product-delete"'));
  assert(html.includes('onclick="eliminarProductoCatalogo('));
  assert(html.includes('aria-label="Eliminar '));
  assert(html.includes('onclick="toggleAgotado('));
  assert(html.includes('🗑️ Eliminar del inventario'));
  assert(html.includes('Productos eliminados'));
  assert(html.includes('↩ Recuperar producto eliminado'));
  assert(html.includes('id="inventarioAviso"'));
  assert(html.includes("HS_CATALOGO_COMPRA_ACTIVA"));
  assert(html.includes('confirm("¿Eliminar «"+p.nombre+'));
  assert(css.includes("@media(max-width:650px)"));
  assert(css.includes(".page-admin .product-row"));
  assert(css.includes(".page-admin .product-delete:focus-visible"));
  assert(css.includes(".inventory-action-status[hidden]"));
  assert(html.includes("\${escapar(p.nombre)}")); // HTML-escaping nombre en fila
  for(const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g))
    if(match[1].trim())new vm.Script(match[1]);
});
test("v4.08: administración protegida; ninguna ruta pública de borrado físico",()=>{
  const backend=fs.readFileSync("server.js","utf8");
  assert(backend.includes('app.post("/api/admin/catalogo/archivar",http.adminWrite'));
  assert(backend.includes('app.post("/api/admin/catalogo/recuperar",http.adminWrite'));
  assert(backend.includes('app.get("/api/admin/catalogo/archivados",http.admin'));
  const model=fs.readFileSync("catalogo/gestion-v404.js","utf8");
  assert(model.includes("INSERT INTO "+'"+TABLA+'));
  assert(!/DELETE FROM productos\b/i.test(model));
});
test("v4.08: ping re-registrado con cron válido, sin credenciales ni efectos en datos",()=>{
  const yml=fs.readFileSync(".github/workflows/keepalive-render.yml","utf8");
  assert(yml.includes('cron: "9,19,29,39,49,59 * * * *"'));
  assert(yml.includes("runs-on: ubuntu-latest"));
  assert(yml.includes("https://hogarstock.onrender.com/admin-login.html"));
  assert(yml.includes("permissions: {}"));
  assert(!yml.includes("TURSO_AUTH_TOKEN"));
  assert(!yml.includes("GH_TOKEN"));
});
