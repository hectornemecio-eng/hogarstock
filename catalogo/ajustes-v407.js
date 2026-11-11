"use strict";
// v4.07: ajuste transaccional e idempotente del catálogo solicitado por el propietario.
// Nunca modifica claves WhatsApp, productos archivados ni compras en curso.
const VERSION="catalogo_v407_20261111";
const AUDIT="hs_catalogo_revision_v407";
const SPLITS=Object.freeze([
  {origen:"Panecillos mercadona e integral",
   destinos:["Panecillos mercadona","Panecillos mercadona integral"]},
  {origen:"Pan de molde 100% integral sin corteza Hacendado 0% azúcares añadidos",
   destinos:["Pan de molde 100% integral","Pan de molde sin corteza blanco"]},
  {origen:"Yogurt grande",
   destinos:["Yogurt griego grande","Yogurt griego pequeño"]},
  {origen:"Queso Mozarella Rebanado y rallado",
   destinos:["Queso Mozzarella Rebanado","Queso Mozzarella rallado"]}
]);
const NUEVOS=Object.freeze([
  {nombre:"Chuleta",categoria:"Carnes, pescados y embutidos"},
  {nombre:"Leche de almendra",categoria:"Lácteos y huevos"},
  {nombre:"Leche entera",categoria:"Lácteos y huevos"},
  {nombre:"Harina de Trigo",categoria:"Despensa y cocina"},
  {nombre:"Harina de pizzas",categoria:"Despensa y cocina"},
  {nombre:"Muslos de pollo deshuesado",categoria:"Carnes, pescados y embutidos"},
  {nombre:"Contramuslos de pollo deshuesado",categoria:"Carnes, pescados y embutidos"}
]);
function crearRevisionCatalogo({db,reloj=Date.now}={}){
  if(!db||typeof db.execute!=="function"||typeof db.transaction!=="function")
    throw Error("HS_CATALOGO_V407_DB_INVALIDA");
  async function init(){
    await db.execute("CREATE TABLE IF NOT EXISTS "+AUDIT+
      " (version TEXT PRIMARY KEY, fecha INTEGER NOT NULL, antes INTEGER NOT NULL,"+
      " despues INTEGER NOT NULL, detalle TEXT NOT NULL)");
  }
  async function aplicar(){
    await init();
    const tx=await db.transaction("write");
    try{
      const registro=await tx.execute({sql:"SELECT version,antes,despues FROM "+AUDIT+
        " WHERE version=? LIMIT 1",args:[VERSION]});
      if(registro.rows.length){
        await tx.rollback();
        return {yaAplicado:true,antes:Number(registro.rows[0].antes),
          despues:Number(registro.rows[0].despues)};
      }
      // Restringir la protección a productos que se VAN A RENOMBRAR.
      // Otras compras abiertas no deben bloquear altas independientes disponibles.
      const condiciones=SPLITS.map(()=> "lower(p.nombre)=lower(?)").join(" OR ");
      const afectada=await tx.execute({sql:
        "SELECT 1 FROM hs_v2_security_items i "+
        "JOIN hs_v2_security_grants g ON g.compra_id=i.compra_id "+
        "JOIN productos p ON p.id=i.producto_id "+
        "WHERE g.estado='abierta' AND g.expira>? AND ("+condiciones+") LIMIT 1",
        args:[reloj(),...SPLITS.map(x=>x.origen)]});
      if(afectada.rows.length){
        await tx.rollback();
        return {aplazado:true,razon:"PRODUCTO_EN_COMPRA_ACTIVA"};
      }
      const antes=Number((await tx.execute("SELECT COUNT(*) AS n FROM productos")).rows[0].n);
      const detalles=[];
      let renombrados=0,creados=0;
      async function activo(nombre){
        const r=await tx.execute({sql:
          "SELECT p.id,p.nombre,p.categoria,p.agotado FROM productos p "+
          "WHERE lower(p.nombre)=lower(?) "+
          "AND NOT EXISTS (SELECT 1 FROM hs_catalogo_archivados a WHERE a.producto_id=p.id) "+
          "LIMIT 2",args:[nombre]});
        if(r.rows.length>1)throw Error("HS_CATALOGO_V407_NOMBRE_AMBIGUO");
        return r.rows.length?r.rows[0]:null;
      }
      async function insertar(nombre,categoria){
        const existente=await activo(nombre);
        if(existente)return {id:Number(existente.id),creado:false};
        const r=await tx.execute({sql:
          "INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,0)",
          args:[nombre,categoria]});
        if(!Number.isSafeInteger(Number(r.lastInsertRowid)))throw Error("HS_CATALOGO_V407_ID_INVALIDO");
        creados++;
        return {id:Number(r.lastInsertRowid),creado:true};
      }
      for(const cambio of SPLITS){
        const original=await activo(cambio.origen);
        if(!original){
          // Una eliminación/edición anterior es deliberada; no resucitarla.
          detalles.push({tipo:"origen_ausente",nombre:cambio.origen});
          continue;
        }
        const principal=await activo(cambio.destinos[0]);
        if(principal && Number(principal.id)!==Number(original.id))
          throw Error("HS_CATALOGO_V407_CONFLICTO_RENOMBRE");
        const id=Number(original.id);
        const r=await tx.execute({sql:"UPDATE productos SET nombre=? WHERE id=? AND nombre=?",
          args:[cambio.destinos[0],id,String(original.nombre)]});
        if(Number(r.rowsAffected)!==1)throw Error("HS_CATALOGO_V407_EDICION_CONCURRENTE");
        renombrados++;
        detalles.push({tipo:"renombrado",id,antes:String(original.nombre),
          despues:cambio.destinos[0],categoria:String(original.categoria),
          agotado:Number(original.agotado)});
        const segundo=await insertar(cambio.destinos[1],String(original.categoria));
        detalles.push({tipo:segundo.creado?"agregado":"ya_existia",
          id:segundo.id,nombre:cambio.destinos[1]});
      }
      for(const producto of NUEVOS){
        const a=await insertar(producto.nombre,producto.categoria);
        detalles.push({tipo:a.creado?"agregado":"ya_existia",id:a.id,
          nombre:producto.nombre,categoria:producto.categoria});
      }
      const despues=Number((await tx.execute("SELECT COUNT(*) AS n FROM productos")).rows[0].n);
      await tx.execute({sql:"INSERT INTO "+AUDIT+
        "(version,fecha,antes,despues,detalle) VALUES(?,?,?,?,?)",
        args:[VERSION,reloj(),antes,despues,JSON.stringify(detalles)]});
      await tx.commit();
      return {aplicado:true,antes,despues,renombrados,creados,
        origenesAusentes:detalles.filter(x=>x.tipo==="origen_ausente").length};
    }catch(error){
      try{await tx.rollback()}catch(_){}
      throw error;
    }finally{tx.close();}
  }
  return Object.freeze({init,aplicar});
}
module.exports={crearRevisionCatalogo,VERSION,SPLITS,NUEVOS};