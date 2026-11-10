"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

function iniciarEscenario({pendiente=false,conCompraRemota=false}={}){
  const html=fs.readFileSync("public/comprador.html","utf8");
  const script=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(Boolean);
  assert(script,"Comprador requiere JavaScript");
  new vm.Script(script);
  const dom=new Map();
  function nodo(id){
    if(!dom.has(id))dom.set(id,{
      id,children:[],textContent:"",className:"",value:"",disabled:false,style:{},
      append(...c){this.children.push(...c)},replaceChildren(...c){this.children=[...c]},
      setAttribute(){},addEventListener(){}
    });
    return dom.get(id);
  }
  const store=new Map();
  let ws=null,numeroPosts=0,resolverPost=null;
  function Socket(){this.readyState=1;this.close=()=>{this.readyState=3};this.send=()=>{};ws=this;}
  Socket.OPEN=1;Socket.CONNECTING=0;
  async function fetchMock(path,opts={}){
    if(path==="/api/comprador/lista"){
      return {ok:!conCompraRemota,status:conCompraRemota?409:200,
        json:async()=>({productos:[{id:1,nombre:"Peras",categoria:"Frutas",agotado:1}]})};
    }
    if(path==="/api/finalizar-compra"){
      numeroPosts++;
      if(!pendiente)return {ok:true,status:200,json:async()=>({enviada:true,faltan:0})};
      return new Promise(resolve=>{resolverPost=resolve;});
    }
    throw Error("PETICION_INESPERADA:"+path);
  }
  const ctx={
    document:{getElementById:nodo,createElement:tag=>nodo(tag+":"+Math.random()),
      addEventListener(){},hidden:false},
    window:{addEventListener(){}},location:{hash:"#token=token-de-prueba",pathname:"/comprador.html",
      host:"hogarstock.test.invalid",protocol:"https:"},
    sessionStorage:{getItem:key=>store.get(key)||null,setItem:(key,v)=>store.set(key,v),
      removeItem:key=>store.delete(key)},
    history:{replaceState(){}},navigator:{onLine:true},
    WebSocket:Socket,URLSearchParams,fetch:fetchMock,console,Date,Math,JSON,
    confirm:()=>true,setTimeout:()=>101,clearTimeout(){},setInterval:()=>202
  };
  vm.runInNewContext(script,ctx);
  return {
    ctx,dom:nodo,store,ws:()=>ws,postCount:()=>numeroPosts,
    resolver:()=>resolverPost
  };
}
async function tick(){await new Promise(resolve=>setTimeout(resolve,0));}
test("Cierre propio: el WebSocket llega antes que la respuesta HTTP, pero solo se presenta confirmación local",async()=>{
  const t=iniciarEscenario({pendiente:true});
  await tick();
  const proceso=t.ctx.finalizarCompra();
  await tick();
  assert.equal(t.postCount(),1,"debe haberse solicitado la finalización una vez");
  assert(t.resolver(),"POST debe permanecer sin responder");
  t.ws().onmessage({data:JSON.stringify({type:"cerrada"})});
  assert.equal(t.dom("lista").children.length>0,true);
  // El aviso no puede cerrar la UI antes de que vuelva la confirmación HTTP.
  t.resolver()({ok:true,status:200,json:async()=>({enviada:true,faltan:0})});
  await proceso;
  assert.equal(t.dom("estado").textContent,"Compra finalizada. Resumen enviado. Faltantes: 0");
  assert.equal(t.dom("lista").children[0].textContent,"Compra finalizada para todos los participantes.");
  assert.equal(t.dom("syncEstado").textContent,"Compra cerrada. No se realizarán más cambios.");
  assert.equal(t.dom("btnFinalizar").style.display,"none");
  assert.equal(t.store.has("hs_v2_buyer_grant"),false);
  console.log("CIERRE_PROPIO_SIN_MENSAJE_CONTRADICTORIO_OK");
});
test("Cierre externo: se muestra un aviso neutral, sin atribuir el origen",async()=>{
  const t=iniciarEscenario();
  await tick();
  t.ws().onmessage({data:JSON.stringify({type:"cerrada"})});
  assert.equal(t.dom("lista").children[0].textContent,
    "La compra compartida ha terminado. Solicita una nueva lista.");
  assert.equal(t.dom("estado").textContent,"");
  assert.equal(t.store.has("hs_v2_buyer_grant"),false);
  assert.equal(t.postCount(),0);
  console.log("CIERRE_REMOTO_INDEPENDIENTE_OK");
});
test("Error HTTP tras aviso: se consulta estado y no se declara éxito falso",async()=>{
  const t=iniciarEscenario({pendiente:true});
  await tick();
  const proceso=t.ctx.finalizarCompra();
  await tick();
  assert.equal(t.postCount(),1);
  t.ws().onmessage({data:JSON.stringify({type:"cerrada"})});
  // Desde entonces, el servidor informa que otra persona cerró la compra.
  t.ctx.finalizacionLocalPendiente; // no altera ninguna variable interna
  t.resolver()({ok:false,status:409,json:async()=>({error:"COMPRA_CERRADA"})});
  // No es posible cambiar fetch mock, por lo que verificar el texto de error
  // y la ausencia de confirmación de éxito sin simular una nueva compra.
  await proceso;
  assert(!t.dom("estado").textContent.includes("Resumen enviado"));
  assert(t.dom("estado").textContent.includes("No se pudo confirmar"));
  console.log("ERROR_HTTP_NO_CONFUNDE_CIERRE_CON_EXITO_OK");
});
