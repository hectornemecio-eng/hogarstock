"use strict";
// Laboratorio: grants de comprador persistidos en SQLite/libSQL separado.
// NO ejecutar init() en la base real sin backup, migración y autorización S/N.
const crypto = require("node:crypto");
const CAB = "hs_v2_security_grants";
const ITEMS = "hs_v2_security_items";
const DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${CAB} (`+
    `compra_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,`+
    ` telefono TEXT NOT NULL, creada INTEGER NOT NULL,`+
    ` expira INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'abierta'`+
    ` CHECK(estado IN ('abierta','finalizada','revocada')))` ,
  `CREATE TABLE IF NOT EXISTS ${ITEMS} (`+
    `compra_id TEXT NOT NULL REFERENCES ${CAB}(compra_id),`+
    ` producto_id INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente'`+
    ` CHECK(estado IN ('pendiente','comprado')),`+
    ` PRIMARY KEY(compra_id,producto_id))`,
]);
function validarContacto(telefono, contactos) {
  const tel = String(telefono??"").replace(/[\s+()-]/g, "");
  if(!/^\d{8,15}$/.test(tel) || !contactos.has(tel)) {
    throw Error("HS_V2_DESTINATARIO_NO_PERMITIDO");
  }
  return tel;
}
async function enTransaccion(db,func) {
  const tx=await db.transaction("write");
  try {
    const out=await func(tx);
    await tx.commit();
    return out;
  } catch(e) {
    try {await tx.rollback();}catch (_){}
    throw e;
  } finally {tx.close();}
}
function crearGrantsV2({db,identidad,contactos=[],reloj=Date.now}={}) {
  if (!db || typeof db.execute!=="function"||typeof db.transaction!=="function"||
      typeof db.batch!=="function"||!identidad ||
      typeof identidad.emitirComprador!=="function" ||
      !Array.isArray(contactos) || contactos.length===0) {
    throw Error("HS_V2_GRANTS_CONFIG_INVALIDA");
  }
  const permitidos = new Set(contactos.map(x=>validarContacto(x,new Set([String(x)]))));
  let inicializado=false;
  function exigirInit() {if(!inicializado)throw Error("HS_V2_GRANTS_NO_INICIALIZADOS");}
  async function init() {
    // No permitir tabla previa con estructura inesperada.
    for(const [tabla,columnas] of [[CAB,["compra_id","token_hash","telefono","creada","expira","estado"]],
      [ITEMS,["compra_id","producto_id","estado"]]]) {
      const r=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",args:[tabla]});
      if(r.rows.length) {
        try {await db.execute(`SELECT ${columnas.join(",")} FROM ${tabla} LIMIT 0`);}
        catch (_) {throw Error("HS_V2_GRANTS_ESQUEMA_INCOMPATIBLE");}
      }
    }
    await db.batch(DDL,"write");
    inicializado=true;
  }
  async function crearCompra({telefono}={}) {
    exigirInit();
    const numero=validarContacto(telefono,permitidos);
    return enTransaccion(db,async tx=>{
      const ahora=reloj();
      const active=await tx.execute({
        sql:`SELECT compra_id FROM ${CAB} WHERE estado='abierta' AND expira>? LIMIT 1`,
        args:[ahora],
      });
      if(active.rows.length)throw Error("HS_V2_COMPRA_YA_ABIERTA");
      const r=await tx.execute(
        "SELECT id,nombre,categoria FROM productos WHERE agotado=1 ORDER BY categoria,nombre,id"
      );
      if(r.rows.length===0)throw Error("HS_V2_SIN_FALTANTES");
      if(r.rows.length>300)throw Error("HS_V2_DEMASIADOS_PRODUCTOS");
      const id=crypto.randomBytes(24).toString("hex");
      const grant=identidad.emitirComprador({idCompra:id});
      await tx.execute({sql:`INSERT INTO ${CAB}`+
        `(compra_id,token_hash,telefono,creada,expira,estado) VALUES(?,?,?,?,?,'abierta')`,
        args:[id,grant.hash,numero,ahora,grant.exp],
      });
      for(const item of r.rows) {
        await tx.execute({sql:`INSERT INTO ${ITEMS}(compra_id,producto_id,estado)`+
          ` VALUES(?,?,'pendiente')`,args:[id,Number(item.id)]});
      }
      return Object.freeze({compraId:id,token:grant.token,numero, cantidad:r.rows.length,
        nombres:r.rows.map(x=>String(x.nombre)),exp:grant.exp});
    });
  }
  async function validarVigencia(tx,grant) {
    if(!grant || typeof grant.hash!=="string"||typeof grant.idCompra!=="string") {
      throw Error("HS_V2_COMPRADOR_NO_AUTORIZADO");
    }
    const r=await tx.execute({sql:`SELECT compra_id,telefono,expira,estado FROM ${CAB}`+
      ` WHERE compra_id=? AND token_hash=? LIMIT 1`,args:[grant.idCompra,grant.hash]});
    const c=r.rows[0];
    if(!c||String(c.estado)!=="abierta"||Number(c.expira)<=reloj()) {
      throw Error("HS_V2_COMPRA_CERRADA_O_EXPIRADA");
    }
    return c;
  }
  async function listar({grant}={}) {
    exigirInit();
    await validarVigencia(db,grant);
    const r=await db.execute({sql:`SELECT p.id,p.nombre,p.categoria,p.agotado,gi.estado AS compra_estado`+
      ` FROM ${ITEMS} gi JOIN productos p ON p.id=gi.producto_id`+
      ` WHERE gi.compra_id=? ORDER BY p.categoria,p.nombre,p.id`,
      args:[grant.idCompra]});
    return r.rows.map(x=>({id:Number(x.id),nombre:String(x.nombre),
      categoria:String(x.categoria),agotado:String(x.compra_estado)==="pendiente"&&Number(x.agotado)===1}));
  }
  async function marcar({grant,productoId}={}) {
    exigirInit();
    if(!Number.isSafeInteger(productoId)||productoId<1)throw Error("HS_V2_PRODUCTO_INVALIDO");
    return enTransaccion(db,async tx=>{
      await validarVigencia(tx,grant);
      const r=await tx.execute({sql:`SELECT estado FROM ${ITEMS} WHERE compra_id=? AND producto_id=?`,
        args:[grant.idCompra,productoId]});
      if(!r.rows.length)throw Error("HS_V2_PRODUCTO_NO_AUTORIZADO");
      if(String(r.rows[0].estado)==="comprado")return Object.freeze({yaRegistrado:true});
      await tx.execute({sql:`UPDATE ${ITEMS} SET estado='comprado'`+
        ` WHERE compra_id=? AND producto_id=? AND estado='pendiente'`,
        args:[grant.idCompra,productoId]});
      const u=await tx.execute({sql:"UPDATE productos SET agotado=0 WHERE id=? AND agotado=1",
        args:[productoId]});
      return Object.freeze({yaRegistrado:false,actualizado:Number(u.rowsAffected)===1});
    });
  }
  async function finalizar({grant}={}) {
    exigirInit();
    return enTransaccion(db,async tx=>{
      const g=await validarVigencia(tx,grant);
      const r=await tx.execute({sql:`SELECT p.nombre,gi.estado FROM ${ITEMS} gi`+
        ` JOIN productos p ON p.id=gi.producto_id WHERE gi.compra_id=? ORDER BY p.nombre`,
        args:[grant.idCompra]});
      const pendientes=r.rows.filter(x=>String(x.estado)!=="comprado").map(x=>String(x.nombre));
      const u=await tx.execute({sql:`UPDATE ${CAB} SET estado='finalizada'`+
        ` WHERE compra_id=? AND token_hash=? AND estado='abierta' AND expira>?`,
        args:[grant.idCompra,grant.hash,reloj()]});
      if(Number(u.rowsAffected)!==1)throw Error("HS_V2_COMPRA_CAMBIO_CONCURRENTE");
      return Object.freeze({faltan:pendientes.length,pendientes,telefono:String(g.telefono)});
    });
  }
  async function hayCompraAbierta() {
    exigirInit();
    const r=await db.execute({sql:`SELECT 1 AS existe FROM ${CAB}`+
      ` WHERE estado='abierta' AND expira>? LIMIT 1`,args:[reloj()]});
    return r.rows.length>0;
  }
  async function revocar({compraId}={}) {
    exigirInit();
    if(typeof compraId!=="string"||!/^[a-f0-9]{48}$/.test(compraId)) {
      throw Error("HS_V2_COMPRA_ID_INVALIDO");
    }
    const r=await db.execute({sql:`UPDATE ${CAB} SET estado='revocada' WHERE compra_id=? AND estado='abierta'`,
      args:[compraId]});
    return Number(r.rowsAffected)===1;
  }
  return Object.freeze({init,crearCompra,listar,marcar,finalizar,revocar,hayCompraAbierta});
}
module.exports={crearGrantsV2};
