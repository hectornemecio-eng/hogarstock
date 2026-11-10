"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

test("Servidor: nombres privados solo de números autorizados y con sesión admin",()=>{
  const src=fs.readFileSync("server.js","utf8");
  const a=src.indexOf('app.get("/api/admin/contactos"');
  const b=src.indexOf('app.get("/api/productos"',a);
  assert(a>=0&&b>a,"Falta la ruta admin de contactos");
  let cb=null,auth=null;
  const entorno={WA_CONTACT_NAMES_JSON:JSON.stringify({
    "34600000001":"Comprador de prueba",
    "34600000002":"Familia de prueba",
    "34699999999":"No autorizado"
  })};
  const contexto={
    app:{get:(ruta,guard,fn)=>{assert.equal(ruta,"/api/admin/contactos");auth=guard;cb=fn}},
    http:{admin:()=>true},
    grants:{listarContactos:()=>["34600000001","34600000002"]},
    process:{env:entorno},console,JSON,Object,Array
  };
  vm.runInNewContext(src.slice(a,b),contexto);
  assert.equal(auth,contexto.http.admin);
  const out={setHeader(k,v){assert.equal(k,"Cache-Control");assert.equal(v,"no-store")},
    json(v){this.body=v}};
  cb({},out);
  assert.deepEqual(Array.from(out.body.telefonos),["34600000001","34600000002"]);
  assert.equal(out.body.nombres["34600000001"],"Comprador de prueba");
  assert.equal(out.body.nombres["34600000002"],"Familia de prueba");
  assert.equal(out.body.nombres["34699999999"],undefined);
  entorno.WA_CONTACT_NAMES_JSON='{"34600000001":" "}';
  cb({},out);
  assert.equal(out.body.nombres["34600000001"],undefined);
  console.log("NOMBRES_PRIVADOS_NO_PUBLICADOS_OK");
});

test("UI: solo una categoría abierta; pendientes no fuerzan su apertura; buscar conserva resultados visibles",async()=>{
  const html=fs.readFileSync("public/index.html","utf8");
  const src=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(x=>x[1]).find(x=>x.includes("function toggleCategoria"));
  assert(src,"JavaScript administrativo ausente");
  new vm.Script(src);
  const nodes=new Map();
  const makeNode=(id)=>{
    if(!nodes.has(id))nodes.set(id,{
      id,textContent:"",innerHTML:"",value:"",disabled:false,style:{},className:"",
      children:[],checked:false,
      append(...elements){this.children.push(...elements)},
      replaceChildren(...elements){this.children=elements},
      querySelectorAll(){return []},addEventListener(){},setAttribute(){}
    });
    return nodes.get(id);
  };
  const fetchMock=async url=>({
    ok:true,status:200,json:async()=>url==="/api/admin/session"?{csrf:"x"}:
      url==="/api/productos"?[]:
      url==="/api/admin/contactos"?{telefonos:["34600000001","34600000002"],
        nombres:{"34600000001":"Nombre seguro A","34600000002":"Nombre seguro B"}}:
      url==="/api/admin/compra-activa"?{activa:false}:
      url==="/api/whatsapp-status"?{conectado:false,qr:null}:{}
  });
  function Socket(){this.readyState=0;this.close=()=>{}}
  Socket.OPEN=1;Socket.CONNECTING=0;
  const cache=new Map();
  const x={document:{getElementById:makeNode,createElement:tag=>makeNode("creado-"+tag+"-"+Math.random()),
    addEventListener(){},hidden:false},
    location:{protocol:"https:",host:"hogarstock.example",replace(){}},
    fetch:fetchMock,WebSocket:Socket,console,Math,Set,URL,
    localStorage:{getItem:k=>cache.get(k)||null,setItem:(k,v)=>cache.set(k,v)},
    encodeURIComponent,decodeURIComponent,confirm:()=>false,prompt:()=>null,
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>0
  };
  x.window=x;
  vm.runInNewContext(src+';globalThis.__testApi={setProductos(items){allProductos=items;filtrarProductos()},toggleCategoria};',x);
  await new Promise(resolve=>setTimeout(resolve,30));
  const productos=[
    {id:1,nombre:"Peras",categoria:"Frutas",agotado:1},
    {id:2,nombre:"Manzanas",categoria:"Frutas",agotado:0},
    {id:3,nombre:"Arroz",categoria:"Despensa",agotado:1}
  ];
  x.__testApi.setProductos(productos);
  function abiertas(){
    return (makeNode("lista").innerHTML.match(/class="category-block abierta"/g)||[]).length;
  }
  assert.equal(abiertas(),0,"La categoría pendiente no debe abrirse sola");
  assert(makeNode("lista").innerHTML.includes("1 por comprar"));
  x.__testApi.toggleCategoria("Frutas");
  assert.equal(abiertas(),1);
  x.__testApi.toggleCategoria("Despensa");
  assert.equal(abiertas(),1,"Abrir Despensa debe cerrar Frutas");
  x.__testApi.toggleCategoria("Despensa");
  assert.equal(abiertas(),0,"Pulsar la misma categoría la cierra");
  makeNode("search").value="peras";
  x.__testApi.setProductos(productos);
  assert.equal(abiertas(),1,"La búsqueda debe desplegar resultados");
  const rows=makeNode("contactosSeleccionados").children;
  assert.equal(rows.length,2);
  const names=rows.map(row=>row.children[0].children[1].children[0].textContent);
  assert.deepEqual(names,["Nombre seguro A","Nombre seguro B"]);
  assert.equal(makeNode("metricTotal").textContent,"3");
  assert.equal(makeNode("metricPending").textContent,"2");
  assert.equal(makeNode("btnEnviar").disabled,false);
  console.log("ACORDEON_EXCLUSIVO_Y_NOMBRES_CORRECTOS_OK");
});
