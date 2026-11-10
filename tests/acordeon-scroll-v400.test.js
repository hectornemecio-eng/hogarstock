"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

function simular({movimientoReducido=false}={}){
  const html=fs.readFileSync("public/index.html","utf8");
  const inicio=html.indexOf("    function toggleCategoria(cat) {");
  const fin=html.indexOf("    function filtrarProductos()",inicio);
  assert(inicio>=0 && fin>inicio,"No se encontró la función real");
  assert(html.includes('data-categoria="'+ "$" + '{escapar(cat)}"'),
    "Cada encabezado debe identificar su categoría sin depender de la posición");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  assert(css.includes(".page-admin .category-header{scroll-margin-top:20px}"),
    "Debe evitarse que el encabezado quede pegado al borde superior");
  const eventos=[],frames=[];
  const categorias=["Carnes y Pescados","Despensa","Frutas y Verduras"];
  let renderizados=0;
  const botones=categorias.map(categoria=>({
    dataset:{categoria},
    focus(opciones){eventos.push({tipo:"focus",categoria,opciones})},
    scrollIntoView(opciones){eventos.push({tipo:"scroll",categoria,opciones})}
  }));
  const contexto={
    document:{querySelectorAll:selector=>{
      assert.equal(selector,"#lista .category-header");
      return botones;
    }},
    window:{matchMedia:consulta=>{
      assert.equal(consulta,"(prefers-reduced-motion: reduce)");
      return {matches:movimientoReducido}
    }},
    requestAnimationFrame:callback=>{frames.push(callback)},
    filtrarProductos:()=>{renderizados++},
    Array
  };
  vm.runInNewContext(
    "let categoriaAbierta=null;let revisionAjusteCategoria=0;\n"+
    html.slice(inicio,fin)+"\n"+
    "globalThis.accionCategoria=toggleCategoria;globalThis.abierta=()=>categoriaAbierta;",
    contexto
  );
  return {
    click:categoria=>contexto.accionCategoria(categoria),
    abierta:()=>contexto.abierta(),eventos,frames,
    renderizados:()=>renderizados,
    aplicarFrames:()=>{while(frames.length)frames.shift()()}
  };
}

test("Solo la última categoría seleccionada desplaza; no queda a mitad de una lista",()=>{
  const t=simular();
  t.click("Carnes y Pescados");
  t.click("Despensa");
  t.aplicarFrames();
  assert.equal(t.abierta(),"Despensa");
  assert.equal(t.renderizados(),2);
  const scrolls=t.eventos.filter(x=>x.tipo==="scroll");
  assert.equal(scrolls.length,1,"Un frame obsoleto no debe producir un salto");
  assert.equal(scrolls[0].categoria,"Despensa");
  assert.equal(scrolls[0].opciones.block,"start");
  assert.equal(scrolls[0].opciones.behavior,"smooth");
  const focos=t.eventos.filter(x=>x.tipo==="focus");
  assert.equal(focos.length,1);
  assert.equal(focos[0].categoria,"Despensa");
  assert.equal(focos[0].opciones.preventScroll,true);
});
test("Cerrar una categoría mantiene el foco, sin mover la pantalla",()=>{
  const t=simular();
  t.click("Despensa");t.aplicarFrames();
  const antes=t.eventos.filter(x=>x.tipo==="scroll").length;
  t.click("Despensa");t.aplicarFrames();
  assert.equal(t.abierta(),null);
  assert.equal(t.eventos.filter(x=>x.tipo==="scroll").length,antes);
  assert.equal(t.eventos.at(-1).tipo,"focus");
  assert.equal(t.eventos.at(-1).categoria,"Despensa");
});
test("Preferencia de movimiento reducido evita desplazamiento animado",()=>{
  const t=simular({movimientoReducido:true});
  t.click("Frutas y Verduras");t.aplicarFrames();
  const scroll=t.eventos.find(x=>x.tipo==="scroll");
  assert.equal(scroll.opciones.behavior,"auto");
  assert.equal(scroll.opciones.block,"start");
});
test("No hay scroll automático al marcar productos o al resincronizar",()=>{
  const t=simular();
  t.click("Carnes y Pescados");t.aplicarFrames();
  const antes=t.eventos.length;
  assert.equal(t.eventos.length,antes);
  assert.equal(t.frames.length,0);
  const html=fs.readFileSync("public/index.html","utf8");
  const bloque=html.slice(html.indexOf("function render(productos"),html.indexOf("let cambiandoProducto"));
  assert(!bloque.includes("scrollIntoView"),"Renderizado debe permanecer libre de scroll");
  const productos=html.slice(html.indexOf("async function toggleAgotado("),html.indexOf("// Alias opcionales"));
  assert(!productos.includes("scrollIntoView"),"Marcar producto no debe forzar scroll");
});
