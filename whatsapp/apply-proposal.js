"use strict";

// Aplicación ADMINISTRATIVA explícita de propuestas de WhatsApp a una compra V3.
// No acepta números, mensajes ni identidades desde HTTP, solo IDs de propuestas
// previamente almacenadas. No cambia productos.agotado y no envía mensajes.
// Todo el efecto (item, estado de propuesta y auditoría) es UNA transacción SQL.
const { randomUUID } = require("node:crypto");

const TABLA = "hogarstock_wa_inbox_aplicaciones_v3";
const COLUMNAS = ["id","respuesta_id","compra_id","item_id","estado_aplicado",
  "revision_anterior","revision_nueva","cambiado","aplicada_en"];
const ESTADOS = new Set(["pendiente","comprado","no_disponible"]);

function idPositivo(valor) {
  if (!Number.isSafeInteger(valor) || valor < 1) throw new TypeError("ID_INVALIDO");
  return valor;
}
function revisionValida(valor) {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new TypeError("REVISION_INVALIDA");
  }
  return valor;
}
function respuestaValida(valor) {
  if (typeof valor !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor)) {
    throw new TypeError("RESPUESTA_INVALIDA");
  }
  return valor;
}
async function transaccion(cliente, tarea) {
  const tx = await cliente.transaction("write");
  try {
    const resultado = await tarea(tx);
    await tx.commit();
    return resultado;
  } catch (error) {
    try { await tx.rollback(); } catch (_) { /* preservar la causa */ }
    throw error;
  } finally {
    tx.close();
  }
}
function crearAplicadorWhatsApp({cliente,reloj=Date.now}={}) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.transaction !== "function") {
    throw new TypeError("WA_APLICADOR_CLIENTE_INVALIDO");
  }
  if (typeof reloj !== "function") throw new TypeError("WA_APLICADOR_RELOJ_INVALIDO");
  let iniciado=false;
  function exigirInit(){ if(!iniciado) throw Error("WA_APLICADOR_NO_INICIALIZADO"); }
  function ahora(){
    const fecha=reloj();
    if(!Number.isSafeInteger(fecha) || fecha < 0) throw Error("WA_APLICADOR_RELOJ_INVALIDO");
    return fecha;
  }
  function resultado(row,yaAplicada=false) {
    return {
      id:String(row.id),respuestaId:String(row.respuesta_id),
      compraId:Number(row.compra_id),itemId:Number(row.item_id),
      estado:String(row.estado_aplicado),
      revisionAnterior:Number(row.revision_anterior),
      revisionNueva:Number(row.revision_nueva),
      cambiado:Number(row.cambiado)===1,
      aplicadaEn:Number(row.aplicada_en),yaAplicada,
    };
  }
  async function init() {
    // Primero confirmar la presencia y forma de tablas dependientes.
    const requeridas=[
      ["hogarstock_wa_inbox_v3",["id","compra_id","item_id","accion","estado","revisado"]],
      ["hogarstock_compras_v3",["id","estado"]],
      ["hogarstock_compra_items_v3",["id","compra_id","estado","revision","actualizada"]],
    ];
    for (const [tabla,columnas] of requeridas) {
      const r=await cliente.execute("PRAGMA table_info("+tabla+")");
      const existentes=new Set(r.rows.map(f=>String(f.name)));
      if(columnas.some(c=>!existentes.has(c))) throw Error("WA_APLICADOR_DEPENDENCIA_INCOMPATIBLE");
    }
    const previo=await cliente.execute("PRAGMA table_info("+TABLA+")");
    if(previo.rows.length) {
      const columnas=new Map(previo.rows.map(x=>[String(x.name),x]));
      if(COLUMNAS.some(x=>!columnas.has(x)) || Number(columnas.get("id")?.pk)!==1) {
        throw Error("WA_APLICADOR_ESQUEMA_INCOMPATIBLE");
      }
    }
    await cliente.execute("CREATE TABLE IF NOT EXISTS "+TABLA+" ("+
      "id TEXT PRIMARY KEY NOT NULL,respuesta_id TEXT UNIQUE NOT NULL,"+
      "compra_id INTEGER NOT NULL,item_id INTEGER NOT NULL,"+
      "estado_aplicado TEXT NOT NULL CHECK(estado_aplicado IN ("+
      "'pendiente','comprado','no_disponible')),"+
      "revision_anterior INTEGER NOT NULL,revision_nueva INTEGER NOT NULL,"+
      "cambiado INTEGER NOT NULL CHECK(cambiado IN (0,1)),"+
      "aplicada_en INTEGER NOT NULL)");
    await cliente.execute("CREATE INDEX IF NOT EXISTS idx_wa_aplicaciones_compra_v3 ON "+
      TABLA+"(compra_id,aplicada_en)");
    iniciado=true;
  }

  async function aplicar({compraId,respuestaId,revisionEsperada}={}) {
    exigirInit();
    idPositivo(compraId);respuestaValida(respuestaId);revisionValida(revisionEsperada);
    return transaccion(cliente,async tx=>{
      // Una repetición de la MISMA aplicación no modifica de nuevo el artículo.
      const aplicada=await tx.execute({
        sql:"SELECT * FROM "+TABLA+" WHERE respuesta_id=? LIMIT 1",
        args:[respuestaId],
      });
      if(aplicada.rows.length){
        const fila=aplicada.rows[0];
        if(Number(fila.compra_id)!==compraId) throw Error("WA_PROPUESTA_AJENA");
        return resultado(fila,true);
      }
      const r=await tx.execute({
        sql:"SELECT compra_id,item_id,accion,estado FROM hogarstock_wa_inbox_v3"+
          " WHERE id=? LIMIT 1",
        args:[respuestaId],
      });
      if(!r.rows.length) throw Error("WA_PROPUESTA_INEXISTENTE");
      const propuesta=r.rows[0];
      if(propuesta.compra_id===null || Number(propuesta.compra_id)!==compraId){
        throw Error("WA_PROPUESTA_AJENA");
      }
      if(propuesta.estado!=="pendiente_revision" ||
          propuesta.item_id===null || !ESTADOS.has(propuesta.accion)) {
        throw Error("WA_PROPUESTA_NO_APLICABLE");
      }
      const cabecera=await tx.execute({
        sql:"SELECT estado FROM hogarstock_compras_v3 WHERE id=? LIMIT 1",
        args:[compraId],
      });
      if(!cabecera.rows.length) throw Error("COMPRA_NO_ENCONTRADA");
      if(cabecera.rows[0].estado!=="abierta") throw Error("COMPRA_CERRADA");
      const itemId=Number(propuesta.item_id);
      const actual=await tx.execute({
        sql:"SELECT estado,revision FROM hogarstock_compra_items_v3"+
          " WHERE compra_id=? AND id=? LIMIT 1",
        args:[compraId,itemId],
      });
      if(!actual.rows.length) throw Error("ITEM_NO_ENCONTRADO");
      if(Number(actual.rows[0].revision)!==revisionEsperada) throw Error("CONFLICTO_VERSION");

      const estado=String(propuesta.accion),cambiado=actual.rows[0].estado!==estado;
      const fecha=ahora(),revisionNueva=revisionEsperada+(cambiado?1:0);
      if(cambiado){
        const cambio=await tx.execute({
          sql:"UPDATE hogarstock_compra_items_v3 SET estado=?,revision=revision+1,"+
            "actualizada=? WHERE id=? AND compra_id=? AND revision=?"+
            " AND EXISTS (SELECT 1 FROM hogarstock_compras_v3"+
            " WHERE id=? AND estado='abierta')",
          args:[estado,fecha,itemId,compraId,revisionEsperada,compraId],
        });
        if(Number(cambio.rowsAffected)!==1) throw Error("CONFLICTO_VERSION");
      }
      const revisado=await tx.execute({
        sql:"UPDATE hogarstock_wa_inbox_v3 SET estado='revisada',revisado=?"+
          " WHERE id=? AND compra_id=? AND estado='pendiente_revision'",
        args:[fecha,respuestaId,compraId],
      });
      if(Number(revisado.rowsAffected)!==1) throw Error("WA_PROPUESTA_NO_APLICABLE");
      const id=randomUUID();
      await tx.execute({
        sql:"INSERT INTO "+TABLA+" (id,respuesta_id,compra_id,item_id,"+
          "estado_aplicado,revision_anterior,revision_nueva,cambiado,aplicada_en)"+
          " VALUES (?,?,?,?,?,?,?,?,?)",
        args:[id,respuestaId,compraId,itemId,estado,
          revisionEsperada,revisionNueva,cambiado?1:0,fecha],
      });
      return {id,respuestaId,compraId,itemId,estado,
        revisionAnterior:revisionEsperada,revisionNueva,cambiado,
        aplicadaEn:fecha,yaAplicada:false};
    });
  }

  async function listarPorCompra({compraId,limite=100}={}) {
    exigirInit();idPositivo(compraId);
    if(!Number.isSafeInteger(limite)||limite<1||limite>100){
      throw new TypeError("WA_APLICADOR_LIMITE_INVALIDO");
    }
    const r=await cliente.execute({
      sql:"SELECT * FROM "+TABLA+" WHERE compra_id=?"+
        " ORDER BY aplicada_en DESC,id DESC LIMIT ?",
      args:[compraId,limite],
    });
    return r.rows.map(f=>resultado(f));
  }
  return Object.freeze({init,aplicar,listarPorCompra});
}
module.exports={crearAplicadorWhatsApp};
