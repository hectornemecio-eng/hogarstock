"use strict";
// Flujo bidireccional íntegramente ficticio y offline, con adaptador Baileys
// real (EventEmitter simulado), inbox, compras y aplicador SQL V3 reales.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("@libsql/client");
const { randomBytes } = require("node:crypto");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EventEmitter } = require("node:events");
const { crearAlmacenCompras } = require("../compras/store.js");
const { crearBandejaWhatsApp } = require("../whatsapp/inbox-store.js");
const { crearAplicadorWhatsApp } = require("../whatsapp/apply-proposal.js");
const { crearAdaptadorEntradaBaileys } = require("../whatsapp/inbound-baileys.js");
const { crearProcesadorRespuestasV3 } = require("../whatsapp/v3-auto-apply-verified.js");

const telefono = "34600111222";
const validado = {
  HOGARSTOCK_V3_SANDBOX: "1",
  HOGARSTOCK_V3_AUTO_APPLY_INBOUND: "1",
};
async function escenario(t, { modo = "auto_comprado", vincular = true } = {}) {
  // Se conserva la carpeta temporal para su eliminación tras terminar Node.
  // El runner CI es efímero; nunca hay conexiones reales.
  const dir = mkdtempSync(join(tmpdir(), "hs-v3auto-"));
  const db = createClient({ url: "file:" + join(dir, "ficticio.sqlite") });
  t.after(async () => { await db.close(); });
  await db.batch([
    "CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)",
    "INSERT INTO productos VALUES (1,'Leche FICTICIA','Ensayo',1),(2,'Huevos FICTICIOS','Ensayo',1)",
  ], "write");
  const compras = crearAlmacenCompras(db);
  await compras.init();
  const compraId = (await compras.crearCompra({
    lineas: [{ productoId: 1 }, { productoId: 2 }],
  })).compraId;
  const bandeja = crearBandejaWhatsApp({
    cliente: db, compras, claveHmacHex: randomBytes(32).toString("hex"),
  });
  await bandeja.init();
  const aplicador = crearAplicadorWhatsApp({ cliente: db });
  await aplicador.init();
  if (vincular) await bandeja.vincularRemitente({ compraId, telefono });
  const procesador = crearProcesadorRespuestasV3({
    bandeja, compras, aplicador, modo,
    entorno: modo === "auto_comprado" ? validado : {},
  });
  const eventos = new EventEmitter();
  const resultados = [];
  const adaptador = crearAdaptadorEntradaBaileys({
    eventos,
    bandeja: {
      async recibir(entrada) {
        const r = await procesador.recibir(entrada);
        resultados.push(r);
        return r;
      },
    },
  });
  adaptador.iniciar();
  t.after(() => adaptador.detener());
  const compra = () => compras.obtenerCompra({ compraId });
  async function enviar(id, texto, jid=telefono+"@s.whatsapp.net", overrides={}) {
    eventos.emit("messages.upsert", {
      type:"notify",
      messages:[{
        key:{remoteJid:jid,id,fromMe:false,...(overrides.key||{})},
        message:{conversation:texto},
      }],
    });
    await adaptador.esperarPendientes();
    return resultados.at(-1);
  }
  return { db, compras, compraId, bandeja, aplicador, procesador,
    resultados, adaptador, eventos, compra, enviar };
}

test("Seguridad: autoaplicacion bloqueada fuera de sandbox ficticio", () => {
  const dependencias = {
    bandeja:{ recibir:async()=>({}) },
    compras:{ obtenerCompra:async()=>null },
    aplicador:{ aplicar:async()=>({}) },
    modo:"auto_comprado",
  };
  for (const entorno of [
    {}, {HOGARSTOCK_V3_SANDBOX:"1"},
    {...validado,TURSO_DATABASE_URL:"libsql://ficticia.turso.io"},
    {...validado,HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
    {...validado,HOGARSTOCK_V3_REMOTE_STAGE:"1"},
    {...validado,HOGARSTOCK_STAGING_TURSO_URL:"libsql://staging.turso.io"},
  ]) {
    assert.throws(() => crearProcesadorRespuestasV3({
      ...dependencias,entorno,
    }), /WA_AUTO_APPLY_SOLO_SANDBOX_FICTICIO/);
  }
});
test("Por defecto la respuesta se conserva para revision manual", async t => {
  const e=await escenario(t,{modo:"revision_manual"});
  const item=(await e.compra()).items[0];
  const r=await e.enviar("WAfake0001","COMPRADO "+item.id);
  assert.equal(r.estado,"pendiente_revision");
  assert.equal(r.aplicado,false);
  assert.equal((await e.compra()).items[0].estado,"pendiente");
});
test("WhatsApp simulado: COMPRADO actualiza compra sin modificar inventario", async t => {
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  const r=await e.enviar("WAfake0002","COMPRADO "+item.id);
  assert.equal(r.estado,"aplicado_automatico");
  assert.equal(r.aplicado,true);
  assert.equal(r.cambiado,true);
  assert.equal(r.todosComprados,false);
  assert.equal((await e.compra()).items[0].estado,"comprado");
  assert.equal((await e.bandeja.listarPorCompra({compraId:e.compraId}))[0].estado,"revisada");
  assert.equal(Number((await e.db.execute("SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
});
test("El mismo mensaje recibido dos veces no aplica de nuevo",async t=>{
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  const primero=await e.enviar("WAfake0003","COMPRADO "+item.id);
  const segundo=await e.enviar("WAfake0003","COMPRADO "+item.id);
  assert.equal(primero.aplicado,true);
  assert.equal(segundo.estado,"duplicado");
  assert.equal(segundo.aplicado,false);
  assert.equal((await e.compra()).items[0].revision,1);
  assert.equal((await e.bandeja.listarPorCompra({compraId:e.compraId})).length,1);
});
test("Número distinto o remitente sin vinculación no modifica la compra",async t=>{
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  const r=await e.enviar("WAfake0004","COMPRADO "+item.id,"34600000000@s.whatsapp.net");
  assert.equal(r.estado,"remitente_no_vinculado");
  assert.equal((await e.compra()).items[0].estado,"pendiente");
  await e.bandeja.revocarVinculo({compraId:e.compraId,telefono});
  const luego=await e.enviar("WAfake0005","COMPRADO "+item.id);
  assert.equal(luego.estado,"remitente_no_vinculado");
  assert.equal((await e.compra()).items[0].estado,"pendiente");
});
test("No disponible y comandos no interpretables NO se autoaplican",async t=>{
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  const r=await e.enviar("WAfake0006","NO DISPONIBLE "+item.id);
  assert.equal(r.estado,"pendiente_revision");
  assert.equal(r.aplicado,false);
  const otro=await e.enviar("WAfake0007","texto libre");
  assert.equal(otro.estado,"no_interpretable");
  assert.equal(otro.aplicado,false);
  assert.equal((await e.compra()).items[0].estado,"pendiente");
});
test("Mensajes propios, grupos y LID no cruzan el adaptador",async t=>{
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  for(const [id,jid,fromMe] of [
    ["WAfake0008",telefono+"@s.whatsapp.net",true],
    ["WAfake0009","123-222@g.us",false],
    ["WAfake0010","123456789@lid",false],
  ]){
    e.eventos.emit("messages.upsert",{
      type:"notify",messages:[{
        key:{remoteJid:jid,id,fromMe},
        message:{conversation:"COMPRADO "+item.id},
      }],
    });
    await e.adaptador.esperarPendientes();
  }
  assert.equal(e.resultados.length,0);
  assert.equal((await e.compra()).items[0].estado,"pendiente");
});
test("Todos comprados genera señal interna sin cerrar ni notificar realmente",async t=>{
  const e=await escenario(t);
  const items=(await e.compra()).items;
  const r1=await e.enviar("WAfake0011","COMPRADO "+items[0].id);
  assert.equal(r1.todosComprados,false);
  const r2=await e.enviar("WAfake0012","COMPRADO "+items[1].id);
  assert.equal(r2.todosComprados,true);
  assert.equal(r2.requiereNotificacion,true);
  const c=await e.compra();
  assert.equal(c.resumen.pendientes,0);
  assert.equal(c.resumen.comprados,2);
  assert.equal(c.estado,"abierta"); // Cierre y mensaje aún NO están implementados.
});
test("Nuevo ID de mensaje sobre producto ya comprado no incrementa revision",async t=>{
  const e=await escenario(t);
  const item=(await e.compra()).items[0];
  const a=await e.enviar("WAfake0013","COMPRADO "+item.id);
  const b=await e.enviar("WAfake0014","COMPRADO "+item.id);
  assert.equal(a.cambiado,true);
  assert.equal(b.cambiado,false);
  assert.equal((await e.compra()).items[0].revision,1);
});
