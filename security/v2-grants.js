"use strict";
const {ordenarProductos}=require("../catalogo/categorias-v406");
// Laboratorio: grants de comprador persistidos en SQLite/libSQL separado.
// NO ejecutar init() en la base real sin backup, migración y autorización S/N.
const crypto = require("node:crypto");
const CAB = "hs_v2_security_grants";
const ITEMS = "hs_v2_security_items";
const ENVIOS = "hs_v2_security_envios";
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
  `CREATE TABLE IF NOT EXISTS ${ENVIOS} (`+
    `compra_id TEXT NOT NULL REFERENCES ${CAB}(compra_id),`+
    ` telefono TEXT NOT NULL, enviado INTEGER NOT NULL,`+
    ` PRIMARY KEY(compra_id,telefono))`,
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
      !Array.isArray(contactos)) {
    throw Error("HS_V2_GRANTS_CONFIG_INVALIDA");
  }
  // Sin contactos configurados, compras quedan denegadas; la web puede iniciar.
  const permitidos = new Set(contactos.map(x=>validarContacto(x,new Set([String(x)]))));
  let inicializado=false;
  function listarContactos() {return [...permitidos];}
  function validarDestinatarios(telefonos) {
    if(!Array.isArray(telefonos)||telefonos.length<1||telefonos.length>10)
      throw Error("HS_V2_DESTINATARIOS_INVALIDOS");
    return [...new Set(telefonos.map(x=>validarContacto(x,permitidos)))];
  }
  function exigirInit() {if(!inicializado)throw Error("HS_V2_GRANTS_NO_INICIALIZADOS");}
  async function init() {
    // No permitir tabla previa con estructura inesperada.
    for(const [tabla,columnas] of [[CAB,["compra_id","token_hash","telefono","creada","expira","estado"]],
      [ITEMS,["compra_id","producto_id","estado"]],
      [ENVIOS,["compra_id","telefono","enviado"]]]) {
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
      // Marcar antes del envío: un reinicio no debe inventar que llegó la invitación.
      await tx.execute({sql:`INSERT INTO ${ENVIOS}(compra_id,telefono,enviado) VALUES(?,?,0)`,
        args:[id,numero]});
      return Object.freeze({compraId:id,token:grant.token,numero, cantidad:r.rows.length,
        nombres:r.rows.map(x=>String(x.nombre)),exp:grant.exp});
    });
  }
  // Compartir la compra activa: todos los destinatarios reciben el MISMO
  // enlace vigente, sin crear una compra nueva ni reiniciar sus productos.
  async function prepararEnvio({telefono}={}) {
    exigirInit();
    const numero=validarContacto(telefono,permitidos);
    const active=await db.execute({
      sql:`SELECT compra_id,token_hash,telefono,expira FROM ${CAB}
        WHERE estado='abierta' AND expira>? ORDER BY creada DESC LIMIT 1`,
      args:[reloj()]
    });
    if(!active.rows.length) {
      return Object.freeze({...await crearCompra({telefono:numero}),nueva:true});
    }
    const anterior=active.rows[0], compraId=String(anterior.compra_id);
    const grant=identidad.recuperarComprador({
      idCompra:compraId,exp:Number(anterior.expira),hash:String(anterior.token_hash)
    });
    const items=await db.execute({
      sql:`SELECT p.nombre FROM ${ITEMS} gi JOIN productos p ON p.id=gi.producto_id
        WHERE gi.compra_id=? AND gi.estado='pendiente' AND p.agotado=1
        ORDER BY p.categoria,p.nombre,p.id`,args:[compraId]
    });
    if(!items.rows.length)throw Error("HS_V2_SIN_FALTANTES");
    return Object.freeze({
      compraId,token:grant.token,numero,cantidad:items.rows.length,
      nombres:items.rows.map(x=>String(x.nombre)),exp:grant.exp,nueva:false
    });
  }
  function idCompraValido(compraId) {
    if(typeof compraId!=="string"||!/^[a-f0-9]{48}$/.test(compraId))
      throw Error("HS_V2_COMPRA_ID_INVALIDO");
  }
  // confirmado: el proveedor aceptó el envío (no prueba lectura ni entrega);
  // incierto: intento pendiente, envío interrumpido o primer contacto heredado.
  async function estadoEnvio({compraId,telefono}={}) {
    exigirInit();
    idCompraValido(compraId);
    const numero=validarContacto(telefono,permitidos);
    const r=await db.execute({sql:`SELECT enviado FROM ${ENVIOS}
      WHERE compra_id=? AND telefono=? LIMIT 1`,args:[compraId,numero]});
    if(r.rows.length) return Number(r.rows[0].enviado)>0?"confirmado":"incierto";
    const original=await db.execute({sql:`SELECT 1 AS existe FROM ${CAB}
      WHERE compra_id=? AND telefono=? LIMIT 1`,args:[compraId,numero]});
    // Antes de v4.05 no se persistía el resultado del primer destinatario:
    // no inferir nunca que se entregó ni repetirlo silenciosamente.
    return original.rows.length?"incierto":"nuevo";
  }
  async function yaEnviado(args={}) {
    return (await estadoEnvio(args))==="confirmado";
  }
  // Estado persistente previo a cualquier intento sobre un nuevo destinatario.
  async function prepararIntentoEnvio({compraId,telefono}={}) {
    exigirInit();
    idCompraValido(compraId);
    const numero=validarContacto(telefono,permitidos);
    const r=await db.execute({sql:`INSERT INTO ${ENVIOS}(compra_id,telefono,enviado)
      SELECT ?,?,0 WHERE EXISTS(SELECT 1 FROM ${CAB}
      WHERE compra_id=? AND estado='abierta' AND expira>?)
      ON CONFLICT(compra_id,telefono) DO NOTHING`,
      args:[compraId,numero,compraId,reloj()]});
    if(Number(r.rowsAffected)!==1){
      const estado=await estadoEnvio({compraId,telefono:numero});
      if(estado==="nuevo")throw Error("HS_V2_COMPRA_CERRADA_O_EXPIRADA");
    }
    return true;
  }
  async function registrarEnviado({compraId,telefono}={}) {
    exigirInit();
    idCompraValido(compraId);
    const numero=validarContacto(telefono,permitidos);
    const r=await db.execute({sql:`INSERT INTO ${ENVIOS}(compra_id,telefono,enviado)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ${CAB}
      WHERE compra_id=? AND estado='abierta' AND expira>?)
      ON CONFLICT(compra_id,telefono) DO UPDATE SET enviado=excluded.enviado`,
      args:[compraId,numero,Math.max(1,reloj()),compraId,reloj()]});
    if(Number(r.rowsAffected)!==1)throw Error("HS_V2_COMPRA_CERRADA_O_EXPIRADA");
    return true;
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
    return ordenarProductos(r.rows.map(x=>({id:Number(x.id),nombre:String(x.nombre),
      categoria:String(x.categoria),agotado:String(x.compra_estado)==="pendiente"&&Number(x.agotado)===1})));
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
      const contactosCompra=await tx.execute({
        sql:`SELECT telefono FROM ${CAB} WHERE compra_id=?
          UNION SELECT telefono FROM ${ENVIOS} WHERE compra_id=? ORDER BY telefono`,
        args:[grant.idCompra,grant.idCompra]
      });
      return Object.freeze({faltan:pendientes.length,pendientes,
        telefono:String(g.telefono),
        telefonos:contactosCompra.rows.map(x=>String(x.telefono))});
    });
  }
  // El administrador puede editar la lista aunque exista una compra compartida.
  // Producto y lista se sincronizan dentro de la MISMA transaccion write.
  async function alternarProducto({productoId,verificarActivo}={}) {
    exigirInit();
    if(!Number.isSafeInteger(productoId)||productoId<1)
      throw Error("HS_V2_PRODUCTO_INVALIDO");
    if(verificarActivo!==undefined && typeof verificarActivo!=="function")
      throw Error("HS_V2_GUARDIA_CATALOGO_INVALIDA");
    return enTransaccion(db,async tx=>{
      // v4.04: comprobar archivado en la misma transaccion que cambia agotado.
      // Opcional para conservar compatibilidad con laboratorios anteriores.
      if(verificarActivo)await verificarActivo(tx,productoId);
      const r=await tx.execute({
        sql:"SELECT agotado FROM productos WHERE id=? LIMIT 1",
        args:[productoId]
      });
      if(!r.rows.length)throw Error("HS_V2_PRODUCTO_NO_ENCONTRADO");
      const anterior=Number(r.rows[0].agotado);
      if(anterior!==0&&anterior!==1)throw Error("HS_V2_PRODUCTO_ESTADO_INVALIDO");
      const nuevo=anterior===1?0:1;
      const actual=await tx.execute({
        sql:"UPDATE productos SET agotado=? WHERE id=? AND agotado=?",
        args:[nuevo,productoId,anterior]
      });
      if(Number(actual.rowsAffected)!==1)throw Error("HS_V2_CAMBIO_CONCURRENTE");

      const abiertas=await tx.execute({
        sql:`SELECT compra_id FROM ${CAB} WHERE estado='abierta' AND expira>? LIMIT 2`,
        args:[reloj()]
      });
      if(abiertas.rows.length>1)throw Error("HS_V2_MULTIPLES_COMPRAS_ABIERTAS");
      if(abiertas.rows.length===1) {
        const compraId=String(abiertas.rows[0].compra_id);
        if(nuevo===1){
          await tx.execute({
            sql:`INSERT INTO ${ITEMS}(compra_id,producto_id,estado)
              VALUES(?,?,'pendiente') ON CONFLICT(compra_id,producto_id)
              DO UPDATE SET estado='pendiente'`,
            args:[compraId,productoId]
          });
        }else{
          // Retirar un pendiente no equivale a marcarlo como comprado.
          await tx.execute({
            sql:`DELETE FROM ${ITEMS}
              WHERE compra_id=? AND producto_id=? AND estado='pendiente'`,
            args:[compraId,productoId]
          });
        }
      }
      return Object.freeze({nuevoEstado:nuevo,compraActiva:abiertas.rows.length===1,
        compraId:abiertas.rows.length===1?String(abiertas.rows[0].compra_id):null});
    });
  }

  // Estado administrativo de la única compra activa. No expone tokens de comprador.
  async function estadoCompra() {
    exigirInit();
    const r=await db.execute({sql:`SELECT compra_id,creada,expira FROM ${CAB}
      WHERE estado='abierta' AND expira>? ORDER BY creada DESC LIMIT 2`,args:[reloj()]});
    if(r.rows.length===0)return Object.freeze({activa:false});
    if(r.rows.length>1)throw Error("HS_V2_MULTIPLES_COMPRAS_ABIERTAS");
    const c=r.rows[0],id=String(c.compra_id);
    const [contactosCompra,pending]=await Promise.all([
      db.execute({sql:`SELECT telefono FROM ${CAB} WHERE compra_id=?
        UNION SELECT telefono FROM ${ENVIOS} WHERE compra_id=? ORDER BY telefono`,args:[id,id]}),
      db.execute({sql:`SELECT COUNT(*) AS total FROM ${ITEMS} gi
        JOIN productos p ON p.id=gi.producto_id
        WHERE gi.compra_id=? AND gi.estado='pendiente' AND p.agotado=1`,args:[id]})
    ]);
    return Object.freeze({activa:true,compraId:id,creada:Number(c.creada),
      expira:Number(c.expira),pendientes:Number(pending.rows[0]?.total||0),
      telefonos:contactosCompra.rows.map(x=>String(x.telefono))});
  }
  // Cerrar desde el panel con la misma política de notificación que el comprador.
  // Se ejecuta en una transacción; no requiere ni revela el token.
  async function finalizarAdmin() {
    exigirInit();
    return enTransaccion(db,async tx=>{
      const r=await tx.execute({sql:`SELECT compra_id FROM ${CAB}
        WHERE estado='abierta' AND expira>? ORDER BY creada DESC LIMIT 2`,args:[reloj()]});
      if(r.rows.length===0)throw Error("HS_V2_SIN_COMPRA_ACTIVA");
      if(r.rows.length>1)throw Error("HS_V2_MULTIPLES_COMPRAS_ABIERTAS");
      const compraId=String(r.rows[0].compra_id);
      const items=await tx.execute({sql:`SELECT p.nombre FROM ${ITEMS} gi
        JOIN productos p ON p.id=gi.producto_id
        WHERE gi.compra_id=? AND gi.estado='pendiente' AND p.agotado=1
        ORDER BY p.nombre`,args:[compraId]});
      const telefonos=await tx.execute({sql:`SELECT telefono FROM ${CAB} WHERE compra_id=?
        UNION SELECT telefono FROM ${ENVIOS} WHERE compra_id=? ORDER BY telefono`,
        args:[compraId,compraId]});
      const u=await tx.execute({sql:`UPDATE ${CAB} SET estado='finalizada'
        WHERE compra_id=? AND estado='abierta' AND expira>?`,args:[compraId,reloj()]});
      if(Number(u.rowsAffected)!==1)throw Error("HS_V2_COMPRA_CAMBIO_CONCURRENTE");
      const pendientes=items.rows.map(x=>String(x.nombre));
      return Object.freeze({compraId,faltan:pendientes.length,pendientes,
        telefonos:telefonos.rows.map(x=>String(x.telefono))});
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
  return Object.freeze({init,crearCompra,prepararEnvio,validarDestinatarios,listarContactos,yaEnviado,estadoEnvio,prepararIntentoEnvio,registrarEnviado,listar,marcar,finalizar,revocar,hayCompraAbierta,alternarProducto,estadoCompra,finalizarAdmin});
}
module.exports={crearGrantsV2};
