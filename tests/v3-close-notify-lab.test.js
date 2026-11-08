"use strict";

// Pruebas end-to-end: SQLite local, eventos WhatsApp ficticios,
// emisor de salida inyectado. Sin red, Render, Turso o Baileys real.
const test = require("node:test");
const assert = require("node:assert/strict");
const {createClient} = require("@libsql/client");
const {randomBytes} = require("node:crypto");
const {mkdtempSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {EventEmitter} = require("node:events");
const {crearAlmacenCompras} = require("../compras/store.js");
const {crearBandejaWhatsApp} = require("../whatsapp/inbox-store.js");
const {crearAplicadorWhatsApp} = require("../whatsapp/apply-proposal.js");
const {crearAdaptadorEntradaBaileys} = require("../whatsapp/inbound-baileys.js");
const {crearProcesadorRespuestasV3} = require("../whatsapp/v3-auto-apply-verified.js");
const {crearRegistroWhatsApp} = require("../whatsapp/outbox-store.js");
const {crearDespachador} = require("../whatsapp/dispatch-service.js");
const {crearCierreNotificadorV3} = require("../whatsapp/v3-close-notify-lab.js");

const telefono="34900000111";
const entornoCierre={
  HOGARSTOCK_V3_SANDBOX:"1", HOGARSTOCK_V3_CLOSE_NOTIFY_LAB:"1",
};
const entornoAuto={
  HOGARSTOCK_V3_SANDBOX:"1", HOGARSTOCK_V3_AUTO_APPLY_INBOUND:"1",
};
async function escenario(t,{ auto=true,emisor }={}) {
  const dir=mkdtempSync(join(tmpdir(),"hs-close-notify-fake-"));
  const cliente=createClient({url:"file:"+join(dir,"ficticia.sqlite")});
  const claveOutbox=randomBytes(32).toString("hex");
  const sent=[];
  const testSender=emisor || (async ({telefono:numero,mensaje})=>{
    sent.push({telefono:numero,mensaje});
    return {estado:"aceptado_por_proveedor",
      codigo:"WA_PROVEEDOR_ACEPTO_SOLICITUD",proveedorId:"FAKEclos123"};
  });
  const compras=crearAlmacenCompras(cliente);
  await cliente.batch([
    "CREATE TABLE productos(id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, categoria TEXT NOT NULL, agotado INTEGER NOT NULL)",
    "INSERT INTO productos VALUES(1,'Leche FICTICIA','Ensayo',1),(2,'Huevos FICTICIOS','Ensayo',1)",
  ],"write");
  await compras.init();
  const compraId=(await compras.crearCompra({lineas:[{productoId:1},{productoId:2}]})).compraId;
  const bandeja=crearBandejaWhatsApp({
    cliente, compras, claveHmacHex:randomBytes(32).toString("hex"),
  });
  await bandeja.init();
  await bandeja.vincularRemitente({compraId,telefono});
  const aplicador=crearAplicadorWhatsApp({cliente});
  await aplicador.init();
  const registro=crearRegistroWhatsApp({cliente,claveHex:claveOutbox});
  await registro.init();
  const despachador=crearDespachador({registro,enviarInterno:testSender});
  const allowed=async numero=>numero===telefono;
  const cierre=crearCierreNotificadorV3({
    cliente, registro, despachador, destinatarioPermitido:allowed,
    entorno:entornoCierre,
  });
  const procesador=crearProcesadorRespuestasV3({
    bandeja, compras, aplicador,
    modo:auto?"auto_comprado":"revision_manual",
    entorno:auto?entornoAuto:{},
    notificarCierre:auto?params=>cierre.cerrarYNotificar(params):null,
  });
  const eventos=new EventEmitter(),resultados=[];
  const adapter=crearAdaptadorEntradaBaileys({
    eventos,bandeja:{async recibir(d){
      const r=await procesador.recibir(d);resultados.push(r);return r;
    }},
  });
  adapter.iniciar();
  t.after(async()=>{await adapter.detener();await cliente.close();});
  async function recibir(id,texto,numero=telefono) {
    eventos.emit("messages.upsert",{
      type:"notify", messages:[{
        key:{remoteJid:numero+"@s.whatsapp.net",id,fromMe:false},
        message:{conversation:texto},
      }],
    });
    await adapter.esperarPendientes();
    return resultados.at(-1);
  }
  return {cliente,claveOutbox,compras,bandeja,aplicador,registro,despachador,
    cierre,procesador,compraId,allowed,sent,recibir,compra:()=>compras.obtenerCompra({compraId})};
}
test("Por defecto se bloquea el cierre ante entornos de red y sin habilitacion",()=>{
  const p={
    cliente:{transaction(){}},
    registro:{registrarSolicitudEnTransaccion(){}},
    despachador:{enviar(){}},
    destinatarioPermitido:async()=>true,
  };
  for(const extra of [
    {},{HOGARSTOCK_V3_SANDBOX:"1"},
    {...entornoCierre,HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
    {...entornoCierre,TURSO_DATABASE_URL:"libsql://fake.turso.io"},
    {...entornoCierre,HOGARSTOCK_V3_REMOTE_STAGE:"1"},
    {...entornoCierre,WA_MASTER_KEY:"NO"},
  ]){
    assert.throws(()=>crearCierreNotificadorV3({...p,entorno:extra}),
      /WA_CIERRE_SOLO_SANDBOX_FICTICIO/);
  }
});
test("No cerrar si hay faltantes sin permiso explicito; sin registro OUTBOX",async t=>{
  const e=await escenario(t,{auto:false});
  await assert.rejects(e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,
  }),/WA_CIERRE_FALTANTES_REQUIEREN_CONFIRMACION/);
  assert.equal((await e.compra()).estado,"abierta");
  assert.equal((await e.registro.listarPorCompra({compraId:e.compraId})).length,0);
  assert.equal(e.sent.length,0);
});
test("Dos respuestas compradas cierran, registran y envian UN aviso ficticio",async t=>{
  const e=await escenario(t);
  const items=(await e.compra()).items;
  const primera=await e.recibir("FAKEcl001","COMPRADO "+items[0].id);
  assert.equal(primera.todosComprados,false);
  assert.equal(e.sent.length,0);
  const segunda=await e.recibir("FAKEcl002","COMPRADO "+items[1].id);
  assert.equal(segunda.cierre,"compra_cerrada_outbox_registrado");
  assert.equal(segunda.todosComprados,true);
  const compra=await e.compra();
  assert.equal(compra.estado,"finalizada");
  assert.equal(compra.resumen.comprados,2);
  const op=await e.registro.listarPorCompra({compraId:e.compraId});
  assert.equal(op.length,1);
  assert.equal(op[0].estado,"aceptado_proveedor");
  assert.equal(op[0].entregadoEn,null);
  assert.equal(e.sent.length,1);
  assert.match(e.sent[0].mensaje,/Todos los productos comprados/);
  assert.equal(Number((await e.cliente.execute(
    "SELECT COUNT(*) AS n FROM productos WHERE agotado=1")).rows[0].n),2);
});
test("Mensaje repetido o otro ID despues del cierre no reenvia",async t=>{
  const e=await escenario(t);
  const items=(await e.compra()).items;
  await e.recibir("FAKEcl003","COMPRADO "+items[0].id);
  await e.recibir("FAKEcl004","COMPRADO "+items[1].id);
  const dup=await e.recibir("FAKEcl004","COMPRADO "+items[1].id);
  assert.equal(dup.aplicado,false);
  const op=await e.cierre.cerrarYNotificar({compraId:e.compraId,telefono});
  assert.equal(op.nuevaOperacion,false);
  assert.equal(op.notificacion,"aceptado_proveedor");
  assert.equal(e.sent.length,1);
  assert.equal((await e.registro.listarPorCompra({compraId:e.compraId})).length,1);
});
test("Tras reconstruir registro y despachador no se duplica aviso",async t=>{
  const e=await escenario(t,{auto:false});
  await e.compras.cambiarEstadoItem({
    compraId:e.compraId,itemId:(await e.compra()).items[0].id,
    estado:"comprado",revisionEsperada:0,
  });
  await e.compras.cambiarEstadoItem({
    compraId:e.compraId,itemId:(await e.compra()).items[1].id,
    estado:"comprado",revisionEsperada:0,
  });
  await e.cierre.cerrarYNotificar({compraId:e.compraId,telefono});
  const registro2=crearRegistroWhatsApp({cliente:e.cliente,claveHex:e.claveOutbox});
  await registro2.init();
  let nuevosEnvios=0;
  const otro=crearCierreNotificadorV3({
    cliente:e.cliente,registro:registro2,
    despachador:crearDespachador({registro:registro2,enviarInterno:async()=>{
      nuevosEnvios++;return {estado:"aceptado_por_proveedor",proveedorId:"FAKEcl1234"};
    }}),destinatarioPermitido:e.allowed,entorno:entornoCierre,
  });
  const r=await otro.cerrarYNotificar({compraId:e.compraId,telefono});
  assert.equal(r.nuevaOperacion,false);
  assert.equal(r.notificacion,"aceptado_proveedor");
  assert.equal(nuevosEnvios,0);
  assert.equal(e.sent.length,1);
});
test("Cierre con faltantes autorizado devuelve lista sin falsa compra completa",async t=>{
  const e=await escenario(t,{auto:false});
  const item=(await e.compra()).items[0];
  await e.compras.cambiarEstadoItem({
    compraId:e.compraId,itemId:item.id,estado:"comprado",revisionEsperada:0,
  });
  const r=await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(r.completa,false);
  assert.equal(r.faltantes,1);
  assert.equal((await e.compra()).estado,"finalizada");
  assert.equal(e.sent.length,1);
  assert.match(e.sent[0].mensaje,/Quedan por conseguir/);
  assert.match(e.sent[0].mensaje,/Huevos FICTICIOS/);
  assert.doesNotMatch(e.sent[0].mensaje,/Leche FICTICIA/);
});
test("Un destinatario no permitido no cierra compra ni genera solicitud",async t=>{
  const e=await escenario(t,{auto:false});
  await assert.rejects(e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono:"34900000999",autorizarFaltantes:true,
  }),/WA_CIERRE_DESTINATARIO_NO_PERMITIDO/);
  assert.equal((await e.compra()).estado,"abierta");
  assert.equal((await e.registro.listarPorCompra({compraId:e.compraId})).length,0);
});
test("Colision de clave de cierre aborta transaccion antes de finalizar",async t=>{
  const e=await escenario(t,{auto:false});
  await e.registro.registrarSolicitud({
    claveIdempotencia:"HS-V3-CIERRE-UNICO-"+e.compraId,
    telefono,mensaje:"Otro contenido ficticio",compraId:e.compraId,
  });
  await assert.rejects(e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  }),/WA_IDEMPOTENCIA_CONFLICTO/);
  assert.equal((await e.compra()).estado,"abierta");
  assert.equal(e.sent.length,0);
});
test("Aceptacion de proveedor NO significa confirmacion de entrega",async t=>{
  const e=await escenario(t,{auto:false});
  const r=await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(r.notificacion,"aceptado_proveedor");
  const op=(await e.registro.listarPorCompra({compraId:e.compraId}))[0];
  assert.equal(op.entregadoEn,null);
  const confirmacion=await e.registro.registrarAcuse({
    telefono,proveedorId:"FAKEclos123",tipo:"entregado",
  });
  assert.equal(confirmacion.actualizado,true);
  assert.equal((await e.registro.obtener(op.id)).estado,"confirmado_entrega");
});
test("Fallos indeterminados no ocasionan reenvios tras nuevo intento",async t=>{
  let intentos=0;
  const e=await escenario(t,{auto:false,emisor:async()=>{
    intentos++;throw Error("fallo ambiguo: pudo enviarse");
  }});
  const r=await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(r.notificacion,"indeterminado");
  const otro=await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(otro.notificacion,"indeterminado");
  assert.equal(intentos,1);
  assert.equal((await e.compra()).estado,"finalizada");
});
test("Cierre registrado sobrevive excepcion del despachador y reintento controlado",async t=>{
  const e=await escenario(t,{auto:false});
  const falla=crearCierreNotificadorV3({
    cliente:e.cliente,registro:e.registro,
    despachador:{async enviar(){throw Error("Sin intento de salida");}},
    destinatarioPermitido:e.allowed,entorno:entornoCierre,
  });
  const antes=await falla.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(antes.notificacion,"pendiente_verificacion_manual");
  assert.equal((await e.compra()).estado,"finalizada");
  assert.equal((await e.registro.listarPorCompra({compraId:e.compraId}))[0].estado,"pendiente");
  const despues=await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  assert.equal(despues.notificacion,"aceptado_proveedor");
  assert.equal(e.sent.length,1);
});
test("No se cambia de destinatario tras registrar el cierre",async t=>{
  const e=await escenario(t,{auto:false});
  await e.cierre.cerrarYNotificar({
    compraId:e.compraId,telefono,autorizarFaltantes:true,
  });
  const cambiado=crearCierreNotificadorV3({
    cliente:e.cliente,registro:e.registro,despachador:e.despachador,
    destinatarioPermitido:async()=>true,entorno:entornoCierre,
  });
  await assert.rejects(cambiado.cerrarYNotificar({
    compraId:e.compraId,telefono:"34900000999",autorizarFaltantes:true,
  }),/WA_IDEMPOTENCIA_CONFLICTO/);
  assert.equal(e.sent.length,1);
});
