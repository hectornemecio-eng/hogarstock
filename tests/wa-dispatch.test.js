"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("@libsql/client");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { crearRegistroWhatsApp } = require("../whatsapp/outbox-store.js");
const { crearDespachador } = require("../whatsapp/dispatch-service.js");

async function entorno(t, emisor) {
  const directorio = mkdtempSync(join(tmpdir(), "hs-dispatch-"));
  const cliente = createClient({url:"file:"+join(directorio,"ensayo.sqlite")});
  t.after(() => { cliente.close(); rmSync(directorio,{recursive:true,force:true}); });
  const registro = crearRegistroWhatsApp({
    cliente, claveHex:randomBytes(32).toString("hex"), reloj:() => 1000000,
  });
  await registro.init();
  const despachador = crearDespachador({registro,enviarInterno:emisor});
  return {registro,despachador,cliente};
}
const pedido = {claveIdempotencia:"prueba-compra-1",telefono:"34900000000",
  mensaje:"Lista de productos ficticios",compraId:1};

test("Aceptacion del proveedor se registra pero no implica entrega",async t=>{
  let intentos=0;
  const e=await entorno(t,async()=>{intentos++;return {
    estado:"aceptado_por_proveedor",codigo:"WA_PROVEEDOR_ACEPTO_SOLICITUD",
    proveedorId:"FAKE12345",
  };});
  const a=await e.despachador.enviar(pedido);
  assert.equal(a.estado,"aceptado_proveedor");
  assert.equal(a.entregadoEn,null);
  assert.equal(intentos,1);
  const b=await e.despachador.enviar(pedido);
  assert.equal(b.id,a.id);
  assert.equal(intentos,1);
  assert.ok(!JSON.stringify(a).includes("FAKE12345"));
  const acuse=await e.registro.registrarAcuse({
    telefono:"34900000000",proveedorId:"FAKE12345",tipo:"entregado",
  });
  assert.equal(acuse.actualizado,true);
  assert.equal((await e.registro.obtener(a.id)).estado,"confirmado_entrega");
});
test("Excepcion del proveedor deja mensaje indeterminado sin reenviar",async t=>{
  let intentos=0;
  const e=await entorno(t,async()=>{intentos++;throw Error("fallo ficticio");});
  const a=await e.despachador.enviar(pedido);
  assert.equal(a.estado,"indeterminado");
  const b=await e.despachador.enviar(pedido);
  assert.equal(b.estado,"indeterminado");
  assert.equal(intentos,1);
});
test("Sin identificador de proveedor no inventa acuse",async t=>{
  const e=await entorno(t,async()=>({estado:"aceptado_por_proveedor"}));
  const a=await e.despachador.enviar(pedido);
  assert.equal(a.estado,"indeterminado");
  assert.equal(a.entregadoEn,null);
});
test("No conectado no inicia el envio",async t=>{
  let intentos=0;
  const e=await entorno(t,async()=>{intentos++;return {
    estado:"no_iniciado",codigo:"WA_NO_CONECTADO",
  };});
  const a=await e.despachador.enviar(pedido);
  assert.equal(a.estado,"pendiente");
  assert.equal(intentos,1);
});
test("Idempotencia con texto distinto rechaza duplicado",async t=>{
  let intentos=0;
  const e=await entorno(t,async()=>{intentos++;return {
    estado:"rechazado",codigo:"WA_DESTINATARIO_NO_AUTORIZADO",
  };});
  await e.despachador.enviar(pedido);
  await assert.rejects(e.despachador.enviar({...pedido,mensaje:"Contenido diferente"}),
    /WA_IDEMPOTENCIA_CONFLICTO/);
  assert.equal(intentos,1);
});
