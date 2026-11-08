"use strict";

// Reposición de catálogo V3: exclusivamente laboratorio con datos ficticios.
// No se monta en HTTP ni en server.js. Exige confirmación administrativa externa.
// La compra finalizada solo repone productos comprados, agotados, no compartidos
// con otras compras abiertas y no conciliados antes desde la misma compra.
const { createHash } = require("node:crypto");
const TABLA = "hogarstock_reposiciones_v3";
const VERSIONES = "hogarstock_productos_version_v3";
// Los triggers detectan todos los cambios, también desde el catálogo antiguo.
const CAMBIOS = [
 ["insert","AFTER INSERT ON productos","NEW.id",""],
 ["delete","AFTER DELETE ON productos","OLD.id",""],
 ["update","AFTER UPDATE ON productos","NEW.id",
  " WHEN OLD.agotado IS NOT NEW.agotado"+
  " OR OLD.nombre IS NOT NEW.nombre"+
  " OR OLD.categoria IS NOT NEW.categoria"],
].map(([sufijo,evento,id,condicion])=>
 "CREATE TRIGGER IF NOT EXISTS hs_v3_product_version_"+sufijo+
 " "+evento+condicion+" BEGIN "+
 "INSERT INTO "+VERSIONES+"(producto_id,version) VALUES("+id+",1)"+
 " ON CONFLICT(producto_id) DO UPDATE SET version=version+1; END");

const COLUMNAS = ["compra_id","producto_id","item_id","aplicada_en"];
const CREAR = "CREATE TABLE IF NOT EXISTS " + TABLA +
  " (compra_id INTEGER NOT NULL,producto_id INTEGER NOT NULL," +
  " item_id INTEGER NOT NULL,aplicada_en INTEGER NOT NULL," +
  " PRIMARY KEY(compra_id,producto_id))";
const CONSULTA =
  "SELECT c.id AS compra_id,c.estado AS compra_estado," +
  " c.revision AS compra_revision,i.id AS item_id," +
  " i.producto_id,i.estado AS item_estado,i.revision AS item_revision," +
  " p.id AS producto_existente,p.agotado AS agotado_actual," +
  " COALESCE(v.version,0) AS version_producto," +
  " EXISTS(SELECT 1 FROM hogarstock_compra_items_v3 otro" +
  " JOIN hogarstock_compras_v3 otra ON otra.id=otro.compra_id" +
  " WHERE otro.producto_id=i.producto_id AND otra.estado='abierta'" +
  " AND otra.id<>c.id) AS compartida," +
  " EXISTS(SELECT 1 FROM " + TABLA + " j" +
  " WHERE j.compra_id=c.id AND j.producto_id=i.producto_id)" +
  " AS ya_aplicada" +
  " FROM hogarstock_compras_v3 c" +
  " JOIN hogarstock_compra_items_v3 i ON i.compra_id=c.id" +
  " LEFT JOIN productos p ON p.id=i.producto_id" +
  " LEFT JOIN "+VERSIONES+" v ON v.producto_id=i.producto_id" +
  " WHERE c.id=? ORDER BY i.id";
function exigirId(id) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError("V3_REPOSICION_COMPRA_INVALIDA");
  }
}
function comprobarEntorno(entorno) {
  if (!entorno || entorno.HOGARSTOCK_V3_SANDBOX !== "1" ||
      entorno.HOGARSTOCK_V3_REPOSICION_LAB !== "1" ||
      ["TURSO_DATABASE_URL","TURSO_AUTH_TOKEN",
        "HOGARSTOCK_STAGING_TURSO_URL","HOGARSTOCK_STAGING_TURSO_TOKEN",
        "HOGARSTOCK_V3_REMOTE_STAGE","HOGARSTOCK_V3_WHATSAPP_LIVE",
        "WA_MASTER_KEY","WA_ALLOWED_NUMBERS"].some(k=>Boolean(entorno[k]))) {
    throw Error("V3_REPOSICION_SOLO_SANDBOX");
  }
}
function estadoFila(f) {
  if (Number(f.ya_aplicada)===1) return "CONCILIADA_ANTERIORMENTE";
  if (String(f.item_estado)!=="comprado") return "NO_COMPRADO";
  if (f.producto_existente==null) return "PRODUCTO_INEXISTENTE";
  if (Number(f.agotado_actual)!==1) return "YA_NO_AGOTADO";
  if (Number(f.compartida)===1) return "COMPRA_ABIERTA_COMPARTIDA";
  return "REPONIBLE";
}
function instantanea(rows, compraId) {
  if (rows.length===0) throw Error("V3_REPOSICION_COMPRA_INEXISTENTE");
  if (rows.some(f=>String(f.compra_estado)!=="finalizada")) {
    throw Error("V3_REPOSICION_COMPRA_NO_FINALIZADA");
  }
  const canon = rows.map(f => [
    Number(f.compra_id),String(f.compra_estado),Number(f.compra_revision),
    Number(f.item_id),Number(f.item_revision),Number(f.producto_id),
    String(f.item_estado),f.producto_existente===null?null:Number(f.producto_existente),
    f.agotado_actual===null?null:Number(f.agotado_actual),
    Number(f.compartida),Number(f.ya_aplicada),
    Number(f.version_producto),
  ]);
  const huella = createHash("sha256").update(JSON.stringify(canon)).digest("hex");
  const lineas = rows.map(f=>Object.freeze({
    itemId:Number(f.item_id),productoId:Number(f.producto_id),
    versionProducto:Number(f.version_producto),
    decision:estadoFila(f),
  }));
  const candidatos=lineas.filter(x=>x.decision==="REPONIBLE");
  return Object.freeze({
    compraId,huella,soloLectura:true,
    candidatos:candidatos.map(x=>x.productoId),
    lineas,
    resumen:Object.freeze({
      total:lineas.length,reponibles:candidatos.length,
      omitidos:lineas.length-candidatos.length,
    }),
  });
}

function crearRepositorInventarioV3({cliente,entorno={},reloj=Date.now}={}) {
  comprobarEntorno(entorno); // antes de acceder a SQL
  if (!cliente || typeof cliente.execute!=="function" ||
      typeof cliente.transaction!=="function") {
    throw new TypeError("V3_REPOSICION_CLIENTE_INVALIDO");
  }
  if (typeof reloj!=="function") throw new TypeError("V3_REPOSICION_RELOJ_INVALIDO");
  let inicializado=false;
  function exigirInit() {
    if (!inicializado) throw Error("V3_REPOSICION_NO_INICIALIZADA");
  }
  async function init() {
    const productos=await cliente.execute("PRAGMA table_info(productos)");
    const c=new Set(productos.rows.map(x=>String(x.name)));
    if (["id","agotado"].some(x=>!c.has(x))) {
      throw Error("V3_REPOSICION_CATALOGO_INCOMPATIBLE");
    }
    const presente=await cliente.execute("PRAGMA table_info("+TABLA+")");
    if (presente.rows.length) {
      const m=new Map(presente.rows.map(f=>[String(f.name),f]));
      if (COLUMNAS.some(x=>!m.has(x)) ||
          Number(m.get("compra_id").pk)!==1 ||
          Number(m.get("producto_id").pk)!==2) {
        throw Error("V3_REPOSICION_BITACORA_INCOMPATIBLE");
      }
    }
    await cliente.execute(CREAR);
    // Sólo en laboratorio; no alterar esquema de la tabla original.
    const tablaVersiones=await cliente.execute("PRAGMA table_info("+VERSIONES+")");
    if (tablaVersiones.rows.length) {
      const m=new Map(tablaVersiones.rows.map(f=>[String(f.name),f]));
      if (!m.has("producto_id") || !m.has("version") ||
          Number(m.get("producto_id").pk)!==1) {
        throw Error("V3_REPOSICION_VERSION_ESQUEMA_INCOMPATIBLE");
      }
    }
    await cliente.execute("CREATE TABLE IF NOT EXISTS "+VERSIONES+
      "(producto_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0)");
    for (const sentencia of CAMBIOS) await cliente.execute(sentencia);
    const triggers=await cliente.execute({
      sql:"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE ?",
      args:["hs_v3_product_version_%"],
    });
    const nombres=new Set(triggers.rows.map(f=>String(f.name)));
    if (["insert","delete","update"].some(n=>
        !nombres.has("hs_v3_product_version_"+n))) {
      throw Error("V3_REPOSICION_TRIGGERS_INCOMPLETOS");
    }
    inicializado=true;
  }
  async function preparar({compraId}={}) {
    exigirInit();exigirId(compraId);
    const r=await cliente.execute({sql:CONSULTA,args:[compraId]});
    return instantanea(r.rows,compraId);
  }
  async function aplicar({
    compraId, huellaEsperada, confirmacion=false,
  }={}) {
    exigirInit();exigirId(compraId);
    if (confirmacion!==true) throw Error("V3_REPOSICION_CONFIRMACION_REQUERIDA");
    if (typeof huellaEsperada!=="string" || !/^[a-f0-9]{64}$/.test(huellaEsperada)) {
      throw Error("V3_REPOSICION_HUELLA_INVALIDA");
    }
    const instante=reloj();
    if (!Number.isSafeInteger(instante) || instante<0) {
      throw Error("V3_REPOSICION_RELOJ_INVALIDO");
    }
    const tx=await cliente.transaction("write");
    try {
      const r=await tx.execute({sql:CONSULTA,args:[compraId]});
      const actual=instantanea(r.rows,compraId);
      if (actual.huella!==huellaEsperada) {
        throw Error("V3_REPOSICION_DESACTUALIZADA");
      }
      const aplicados=[];
      for (const fila of actual.lineas) {
        if (fila.decision!=="REPONIBLE") continue;
        const id=fila.productoId;
        const actualizado=await tx.execute({
          sql:"UPDATE productos SET agotado=0 WHERE id=? AND agotado=1" +
           " AND EXISTS (SELECT 1 FROM hogarstock_compras_v3 c" +
           " JOIN hogarstock_compra_items_v3 i ON i.compra_id=c.id" +
           " WHERE c.id=? AND c.estado='finalizada'" +
           " AND i.producto_id=productos.id AND i.estado='comprado')" +
           " AND NOT EXISTS (SELECT 1 FROM hogarstock_compra_items_v3 i2" +
           " JOIN hogarstock_compras_v3 c2 ON c2.id=i2.compra_id" +
           " WHERE i2.producto_id=productos.id AND c2.estado='abierta')" +
           " AND COALESCE((SELECT v.version FROM "+VERSIONES+
           " v WHERE v.producto_id=productos.id),0)=?" +
           " AND NOT EXISTS (SELECT 1 FROM "+TABLA+" j" +
           " WHERE j.compra_id=? AND j.producto_id=productos.id)",
          args:[id,compraId,fila.versionProducto,compraId],
        });
        if (Number(actualizado.rowsAffected)!==1) {
          throw Error("V3_REPOSICION_CONFLICTO_ATOMICO");
        }
        await tx.execute({
          sql:"INSERT INTO "+TABLA+
            " (compra_id,producto_id,item_id,aplicada_en) VALUES(?,?,?,?)",
          args:[compraId,id,fila.itemId,instante],
        });
        aplicados.push(id);
      }
      await tx.commit();
      return Object.freeze({
        compraId,aplicados,numeroAplicados:aplicados.length,
        omitidos:actual.resumen.omitidos,conservadoHistorial:true,
      });
    } catch(error) {
      try {await tx.rollback();} catch(_) {}
      throw error;
    } finally {
      tx.close();
    }
  }
  return Object.freeze({init,preparar,aplicar});
}
module.exports={crearRepositorInventarioV3};
