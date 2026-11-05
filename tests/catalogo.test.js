"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {crearCatalogoV3}=require("../catalogo/store.js");

function fixture(t){
 const db=new DatabaseSync(":memory:");
 t.after(()=>db.close());
 db.exec("CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT,"+
   "nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0);"+
   "INSERT INTO productos (id,nombre,categoria,agotado) VALUES"+
   "(1,'Leche','Lacteos',1),(2,'Arroz','Despensa',0);");
 let abierta=false;
 function execute(q){
  const sql=typeof q==="string"?q:q.sql;
  const args=typeof q==="string"?[]:q.args||[];
  const statement=db.prepare(sql);
  if(/^\s*(SELECT|PRAGMA)\b/i.test(sql))return {rows:statement.all(...args)};
  const result=statement.run(...args);
  return {rows:[],rowsAffected:result.changes,lastInsertRowid:result.lastInsertRowid};
 }
 const cliente={
  async execute(q){return execute(q);},
  async transaction(type){
   assert.equal(type,"write");assert.equal(abierta,false);
   db.exec("BEGIN IMMEDIATE");abierta=true;let cerrada=false;
   return {
    async execute(q){assert.equal(cerrada,false);return execute(q);},
    async commit(){assert.equal(cerrada,false);db.exec("COMMIT");cerrada=true;abierta=false;},
    async rollback(){if(!cerrada){db.exec("ROLLBACK");cerrada=true;abierta=false;}},
    close(){if(!cerrada){db.exec("ROLLBACK");cerrada=true;abierta=false;}},
   };
  },
 };
 return {db,catalogo:crearCatalogoV3(cliente)};
}
test("Catálogo: lista productos y agrega sin borrar existentes",async(t)=>{
 const {db,catalogo}=fixture(t);
 assert.equal((await catalogo.listarProductos()).length,2);
 const creado=await catalogo.agregarProducto({nombre:"  Manzanas  ",categoria:" Frutas "});
 assert.equal(creado.nombre,"Manzanas");assert.equal(creado.agotado,false);
 assert.equal((await catalogo.listarProductos()).length,3);
 assert.equal(db.prepare("SELECT nombre FROM productos WHERE id=1").get().nombre,"Leche");
});
test("Catálogo: rechaza duplicados y entradas inválidas",async(t)=>{
 const {db,catalogo}=fixture(t);
 await assert.rejects(catalogo.agregarProducto({nombre:" leche ",categoria:"lacteos"}),/PRODUCTO_DUPLICADO/);
 await assert.rejects(catalogo.agregarProducto({nombre:"",categoria:"Otros"}),/invalido/);
 await assert.rejects(catalogo.agregarProducto({nombre:"x".repeat(121),categoria:"Otros"}),/invalido/);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM productos").get().n,2);
});
test("Catálogo: edición no cambia estados ni copias históricas",async(t)=>{
 const {db,catalogo}=fixture(t);
 const cambio=await catalogo.editarProducto({productoId:1,nombre:"Leche entera",categoria:"Bebidas"});
 assert.equal(cambio.agotado,true);
 assert.equal(db.prepare("SELECT agotado FROM productos WHERE id=1").get().agotado,1);
 await assert.rejects(catalogo.editarProducto({productoId:1,nombre:"Arroz",categoria:"Despensa"}),/PRODUCTO_DUPLICADO/);
 assert.equal(db.prepare("SELECT nombre FROM productos WHERE id=1").get().nombre,"Leche entera");
});
test("Catálogo: actualización condicional de agotado evita revisión obsoleta",async(t)=>{
 const {db,catalogo}=fixture(t);
 const x=await catalogo.cambiarNecesidad({productoId:1,agotado:0,agotadoEsperado:1});
 assert.equal(x.agotado,false);
 await assert.rejects(catalogo.cambiarNecesidad({productoId:1,agotado:1,agotadoEsperado:1}),/ESTADO_SIN_CAMBIO/);
 await assert.rejects(catalogo.cambiarNecesidad({productoId:1,agotado:0,agotadoEsperado:1}),
   /CONFLICTO_ESTADO_PRODUCTO/);
 assert.equal(db.prepare("SELECT agotado FROM productos WHERE id=1").get().agotado,0);
});
test("Catálogo: producto inexistente no se crea al editar",async(t)=>{
 const {db,catalogo}=fixture(t);
 await assert.rejects(catalogo.editarProducto({productoId:999,nombre:"Otro",categoria:"Casa"}),/PRODUCTO_INEXISTENTE/);
 await assert.rejects(catalogo.cambiarNecesidad({productoId:999,agotado:1,agotadoEsperado:0}),/PRODUCTO_INEXISTENTE/);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM productos").get().n,2);
});
