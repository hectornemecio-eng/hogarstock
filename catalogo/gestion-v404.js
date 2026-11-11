"use strict";
// v4.04: gestion del catalogo. Nunca elimina productos fisicamente.
const TABLA = "hs_catalogo_archivados";
const LISTA = "SELECT p.id,p.nombre,p.categoria,p.agotado FROM productos p " +
  "WHERE NOT EXISTS (SELECT 1 FROM "+TABLA+" a WHERE a.producto_id=p.id) " +
  "ORDER BY p.categoria,p.nombre,p.id";

function crearGestionCatalogo({db,reloj=Date.now}={}) {
  if (!db || typeof db.execute!=="function" || typeof db.transaction!=="function")
    throw Error("HS_CATALOGO_CONFIG_INVALIDA");
  let inicializado=false;
  function exigirInit(){if(!inicializado)throw Error("HS_CATALOGO_NO_INICIALIZADO");}
  function texto(valor,max,etiqueta) {
    if(typeof valor!=="string")throw Error("HS_CATALOGO_"+etiqueta+"_INVALIDO");
    const limpio=valor.trim().replace(/\s+/g," ");
    if(!limpio || limpio.length>max || /[\u0000-\u001f\u007f]/.test(limpio))
      throw Error("HS_CATALOGO_"+etiqueta+"_INVALIDO");
    return limpio;
  }
  function idValido(valor) {
    const n=Number(valor);
    if(!Number.isSafeInteger(n)||n<1)throw Error("HS_CATALOGO_ID_INVALIDO");
    return n;
  }
  async function init(){
    // Tabla auxiliar: sin ALTER TABLE ni cambios en las filas existentes.
    await db.execute("CREATE TABLE IF NOT EXISTS "+TABLA+
      " (producto_id INTEGER PRIMARY KEY REFERENCES productos(id), fecha INTEGER NOT NULL)");
    inicializado=true;
  }
  async function listar() {
    exigirInit();
    const r=await db.execute(LISTA);
    return r.rows.map(x=>({id:Number(x.id),nombre:String(x.nombre),
      categoria:String(x.categoria),agotado:Number(x.agotado)}));
  }
  async function txWrite(fn) {
    exigirInit();
    const tx=await db.transaction("write");
    try{
      const resultado=await fn(tx);
      await tx.commit();
      return resultado;
    }catch(error){
      try{await tx.rollback();}catch(_){}
      throw error;
    }finally{tx.close();}
  }
  async function duplicado(tx,nombre,categoria,excepto=0) {
    const r=await tx.execute({sql:
      "SELECT p.id FROM productos p WHERE lower(p.nombre)=lower(?) "+
      "AND lower(p.categoria)=lower(?) AND p.id<>? "+
      "AND NOT EXISTS(SELECT 1 FROM "+TABLA+" a WHERE a.producto_id=p.id) LIMIT 1",
      args:[nombre,categoria,excepto]});
    if(r.rows.length)throw Error("HS_CATALOGO_DUPLICADO");
  }
  async function activo(tx,id) {
    const r=await tx.execute({sql:
      "SELECT p.id FROM productos p WHERE p.id=? "+
      "AND NOT EXISTS(SELECT 1 FROM "+TABLA+" a WHERE a.producto_id=p.id) LIMIT 1",
      args:[id]});
    if(!r.rows.length)throw Error("HS_CATALOGO_NO_ENCONTRADO");
  }
  async function vinculadoACompraActiva(tx,id) {
    const r=await tx.execute({sql:
      "SELECT 1 FROM hs_v2_security_items i "+
      "JOIN hs_v2_security_grants g ON g.compra_id=i.compra_id "+
      "WHERE i.producto_id=? AND g.estado='abierta' AND g.expira>? LIMIT 1",
      args:[id,reloj()]});
    if(r.rows.length)throw Error("HS_CATALOGO_COMPRA_ACTIVA");
  }
  async function crear({nombre,categoria}={}){
    nombre=texto(nombre,120,"NOMBRE");
    categoria=texto(categoria,60,"CATEGORIA");
    return txWrite(async tx=>{
      await duplicado(tx,nombre,categoria);
      const r=await tx.execute({sql:
        "INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,0)",
        args:[nombre,categoria]});
      return {id:Number(r.lastInsertRowid),nombre,categoria,agotado:0};
    });
  }
  async function editar({id,nombre,categoria}={}){
    id=idValido(id);
    nombre=texto(nombre,120,"NOMBRE");
    categoria=texto(categoria,60,"CATEGORIA");
    return txWrite(async tx=>{
      await activo(tx,id);
      // No cambia nombres visibles de una compra en curso.
      await vinculadoACompraActiva(tx,id);
      await duplicado(tx,nombre,categoria,id);
      await tx.execute({sql:"UPDATE productos SET nombre=?,categoria=? WHERE id=?",
        args:[nombre,categoria,id]});
      return {id,nombre,categoria};
    });
  }
  async function archivar({id}={}){
    id=idValido(id);
    return txWrite(async tx=>{
      await activo(tx,id);
      await vinculadoACompraActiva(tx,id);
      // Si estaba agotado, no debe entrar en ninguna compra nueva.
      await tx.execute({sql:"UPDATE productos SET agotado=0 WHERE id=?",args:[id]});
      await tx.execute({sql:
        "INSERT INTO "+TABLA+"(producto_id,fecha) VALUES(?,?)",args:[id,reloj()]});
      return {id,archivado:true};
    });
  }
  async function verificarActivo(tx,id) {
    exigirInit();
    await activo(tx,id);
  }
  return Object.freeze({init,listar,crear,editar,archivar,verificarActivo});
}
module.exports={crearGestionCatalogo};
