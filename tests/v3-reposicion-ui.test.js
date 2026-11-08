"use strict";
// Validación de sintaxis y presencia de controles: NO sustituye un E2E visual.
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.resolve(__dirname,"../public/admin-v3.html"),"utf8");
test("El JavaScript inline administrativo compila sin errores",()=>{
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);
  assert.doesNotThrow(()=>new vm.Script(scripts[0][1],{
    filename:"admin-v3-inline.js",
  }));
});
test("El flujo opt-in exige consulta, aprobación y huella",()=>{
  assert.ok(html.includes('"/reposicion"'));
  assert.ok(html.includes('"/reposicion/aplicar","POST"'));
  assert.ok(html.includes("confirmacion:true,huellaEsperada:rep.huella"));
  assert.ok(html.includes("window.confirm("));
  assert.ok(html.includes("rep.resumen.reponibles>0"));
});
test("La pantalla muestra sólo informe ante ausencia de servicio",()=>{
  assert.ok(html.includes("if(error.status===404)"));
  assert.ok(html.includes("Reposición desactivada en este entorno"));
  assert.ok(html.includes("document.createElement(tag)"));
  assert.ok(html.includes("textContent=String(contenido)"));
});
