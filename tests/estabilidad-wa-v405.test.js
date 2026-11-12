"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const {crearEstabilidadWA}=require("../whatsapp/wa-stability");

test("v4.05: caídas 500 consecutivas activan aviso, sin exponer credenciales",()=>{
  let now=100000000;
  const d=crearEstabilidadWA({reloj:()=>now});
  d.abierta(); now+=10000;
  assert.equal(d.cerrada(500).estable,false);
  d.abierta(); now+=10000;
  assert.equal(d.cerrada(500).estable,false);
  const s=d.estado({conectado:true});
  assert.equal(s.conectado,true);
  assert.equal(s.inestable,true);
  assert.equal(s.errores500Recientes,2);
  assert.equal("telefono" in s,false);
  assert.equal("token" in s,false);
});
test("v4.05: conexión prolongada reinicia retroceso; apertura fugaz no",()=>{
  let now=200000000;
  const d=crearEstabilidadWA({reloj:()=>now,estableTrasMs:120000});
  d.abierta();now+=119999;assert.equal(d.cerrada(500).estable,false);
  d.abierta();now+=120000;assert.equal(d.cerrada(500).estable,true);
});
test("v4.05: una desconexión deja de contarse tras la ventana de observación",()=>{
  let now=300000000;
  const d=crearEstabilidadWA({reloj:()=>now,ventanaMs:1800000});
  d.abierta();now+=1000;d.cerrada(500);
  now+=1000;d.abierta();now+=1000;d.cerrada(500);
  assert.equal(d.estado().inestable,true);
  now+=1800001;
  assert.equal(d.estado().errores500Recientes,0);
  assert.equal(d.estado().inestable,false);
});
test("v4.05: la app muestra el aviso al administrador sin introducir secretos",()=>{
  const src=fs.readFileSync("server.js","utf8");
  const ui=fs.readFileSync("public/index.html","utf8");
  assert(src.includes('const {crearEstabilidadWA}=require("./whatsapp/wa-stability")'));
  assert(src.includes("estabilidadWA.estado({conectado:whatsappConectado})"));
  assert(src.includes("if(estabilidadWA.cerrada(codigo).estable)intentosFallidos=0"));
  assert(ui.includes("data.diagnostico?.inestable===true"));
  for(const match of ui.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)){
    if(match[1].trim())new vm.Script(match[1]);
  }
});

test("v4.09: dos desconexiones 500 separadas por 50 minutos activan aviso",()=>{
  let now=500000000;
  const m=crearEstabilidadWA({reloj:()=>now});
  m.abierta();now+=600000;m.cerrada(500);
  now+=3000000;m.abierta();now+=600000;m.cerrada(500);
  assert.equal(m.estado({conectado:true}).errores500Recientes,2);
  assert.equal(m.estado({conectado:true}).inestable,true);
  now+=7200001;
  assert.equal(m.estado({conectado:true}).inestable,false);
  assert.equal(m.estado({conectado:true}).caidasRecientes,0);
});
