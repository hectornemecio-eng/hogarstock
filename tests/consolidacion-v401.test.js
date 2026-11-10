"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const os=require("node:os");
const path=require("node:path");
const {createClient}=require("@libsql/client");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const {crearGrantsV2}=require("../security/v2-grants");

const esperar=()=>new Promise(resolve=>setImmediate(resolve));
function panelFicticio(){
  const html=fs.readFileSync("public/index.html","utf8");
  const src=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(x=>x[1]).find(x=>x.includes("function sincronizarCatalogo"));
  assert(src,"No se encuentra JS admin");
  new vm.Script(src);
  const nodos=new Map();
  function el(id){
    if(!nodos.has(id))nodos.set(id,{
      id,style:{},textContent:"",innerHTML:"",className:"",value:"",
      disabled:false,checked:false,children:[],dataset:{},
      replaceChildren(...xs){this.children=[...xs];},
      append(...xs){this.children.push(...xs);},
      querySelectorAll(){return [];},addEventListener(){},setAttribute(){},focus(){}
    });
    return nodos.get(id);
  }
  let estadoCompra={activa:false},solicitudesEnvio=0,liberarEnvio=null,conectado=null;
  let resolverCatalogo=null;
  const fetchMock=(url,options={})=>{
    if(url==="/api/productos")return new Promise(resolve=>{resolverCatalogo=resolve;});
    if(url==="/api/iniciar-compra"){
      solicitudesEnvio++;
      return new Promise(resolve=>{liberarEnvio=resolve;});
    }
    const data=url==="/api/admin/session"?{csrf:"csrf-ficticio"}:
      url==="/api/admin/contactos"?{telefonos:["34600000001"],nombres:{"34600000001":"Prueba"}}:
      url==="/api/admin/compra-activa"?estadoCompra:
      url==="/api/whatsapp-status"?{conectado:true,qr:null}:null;
    assert(data!==null,"Ruta inesperada "+url);
    return Promise.resolve({ok:true,status:200,json:async()=>data});
  };
  function Socket(){this.readyState=1;this.send=()=>{};this.close=()=>{};conectado=this;}
  Socket.OPEN=1;Socket.CONNECTING=0;
  const store=new Map();
  const context={
    document:{
      getElementById:el,
      querySelectorAll:(selector)=>selector==="#contactosSeleccionados input:checked"?[{value:"34600000001"}]:[],
      createElement:t=>el("created:"+t+":"+Math.random()),addEventListener(){},hidden:false
    },
    location:{protocol:"https:",host:"hogarstock.test.invalid",replace(){}},
    fetch:fetchMock,WebSocket:Socket,
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},
    console,Set,Math,Date,Intl,URL,encodeURIComponent,decodeURIComponent,
    confirm:()=>true,prompt:()=>null,alert(){},setTimeout(){return 5;},clearTimeout(){},
    setInterval(){return 6;},requestAnimationFrame:fn=>fn()
  };
  context.window=context;
  vm.runInNewContext(src+';globalThis.hsTest={actualizar:(x)=>{allProductos=x;filtrarProductos()},enviarLista,cargarEstadoCompra,obtenerProductos:()=>allProductos};',context,{timeout:5000});
  return {
    el,context,events:()=>conectado,
    resolverCatalogo:()=>resolverCatalogo,
    responseCatalogo:data=>resolverCatalogo({
      ok:true,status:200,json:async()=>data
    }),
    estadoCompra:v=>{estadoCompra=v},
    enviar:()=>context.hsTest.enviarLista(),
    cargarEstado:()=>context.hsTest.cargarEstadoCompra(),
    actualizar:p=>context.hsTest.actualizar(p),
    posts:()=>solicitudesEnvio,
    liberar:v=>liberarEnvio({ok:true,status:200,json:async()=>v})
  };
}
test("GET anterior no sobrescribe la versión recibida por WebSocket",async()=>{
  const app=panelFicticio();
  await esperar();
  assert(app.resolverCatalogo());
  app.events().onmessage({data:JSON.stringify({type:"update",productos:[
    {id:1,nombre:"Arroz",categoria:"Despensa",agotado:1}
  ]})});
  await esperar();
  app.responseCatalogo([{id:1,nombre:"Arroz",categoria:"Despensa",agotado:0}]);
  await esperar();await esperar();
  assert.equal(app.el("metricPending").textContent,"1");
  assert.equal(app.el("btnEnviar").disabled,false);
  assert.equal(app.context.hsTest.obtenerProductos()[0].agotado,1);
});

test("Un re-render no reactiva el botón durante el envío ni permite duplicarlo",async()=>{
  const app=panelFicticio();
  await esperar();
  app.responseCatalogo([{id:1,nombre:"Arroz",categoria:"Despensa",agotado:1}]);
  await esperar();
  const post=app.enviar();
  await esperar();
  assert.equal(app.posts(),1);
  assert.equal(app.el("btnEnviar").disabled,true);
  app.actualizar([{id:1,nombre:"Arroz",categoria:"Despensa",agotado:1}]);
  assert.equal(app.el("btnEnviar").disabled,true);
  await app.enviar();
  assert.equal(app.posts(),1);
  app.estadoCompra({activa:true,compraId:"a".repeat(48),creada:Date.now(),
    pendientes:1,telefonos:["34600000001"]});
  app.liberar({ok:true,compraId:"a".repeat(48),enviados:["34600000001"],
    yaEnviados:[],reenviados:[],fallidos:[],inciertos:[]});
  await post;
  assert.equal(app.el("btnEnviar").disabled,false);
  assert(app.el("estado").textContent.includes("Solicitudes de envío aceptadas: 1"));
});

test("Un cierre externo limpia el aviso anterior sin borrar confirmaciones de cierre locales",async()=>{
  const app=panelFicticio();
  await esperar();app.responseCatalogo([]);
  app.estadoCompra({activa:true,compraId:"a".repeat(48),creada:Date.now(),
    pendientes:1,telefonos:["34600000001"]});
  await app.cargarEstado();
  const aviso=app.el("estado");
  aviso.textContent="Solicitudes de envío aceptadas: 1. Reenvíos solicitados: 0.";
  aviso.className="ok";
  app.estadoCompra({activa:false});
  await app.cargarEstado();
  assert.equal(aviso.textContent,"La compra anterior ha terminado. Puedes preparar una nueva lista.");
  assert.equal(aviso.className,"");
  assert.equal(app.el("compraEstado").textContent,"Sin compra activa");
  aviso.textContent="Compra finalizada. Faltantes: 0. Resúmenes confirmados: 1 de 1.";
  await app.cargarEstado();
  assert.equal(aviso.textContent,"Compra finalizada. Faltantes: 0. Resúmenes confirmados: 1 de 1.");
});

test("Ciclo completo con tres destinatarios ficticios sin tocar producción",async()=>{
  const file=path.join(os.tmpdir(),"hs_v401_"+process.pid+"_"+Date.now()+".db");
  const db=createClient({url:"file:"+file});
  try{
    await db.execute("CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
    await db.batch([
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[1,"Pera","Fruta",1]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[2,"Arroz","Despensa",1]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[3,"Leche","Lacteos",1]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[4,"Aceite","Despensa",0]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[5,"Papel","Limpieza",0]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[6,"Café","Despensa",0]}
    ],"write");
    const nums=["34600000001","34600000002","34600000003"];
    const identidad=crearIdentidadV2({entorno:generarMaterial("clave-ficticia-aislada-solo-pruebas-v401")});
    const grants=crearGrantsV2({db,identidad,contactos:nums});
    await grants.init();
    const primera=await grants.prepararEnvio({telefono:nums[0]});
    assert.equal(primera.nueva,true);
    assert.equal(primera.cantidad,3);
    for(const numero of nums.slice(1)){
      const invitacion=await grants.prepararEnvio({telefono:numero});
      assert.equal(invitacion.compraId,primera.compraId);
      assert.equal(invitacion.token,primera.token);
      await grants.registrarEnviado({compraId:primera.compraId,telefono:numero});
    }
    const estado=await grants.estadoCompra();
    assert.equal(estado.activa,true);
    assert.equal(estado.telefonos.length,3);
    const comprador=identidad.leerComprador("Bearer "+primera.token);
    assert.equal((await grants.listar({grant:comprador})).filter(x=>x.agotado).length,3);
    await grants.marcar({grant:comprador,productoId:1});
    assert.equal((await grants.listar({grant:comprador})).filter(x=>x.agotado).length,2);
    await grants.alternarProducto({productoId:4});
    assert.equal((await grants.listar({grant:comprador})).filter(x=>x.agotado).length,3);
    await grants.marcar({grant:comprador,productoId:4});
    const cierre=await grants.finalizar({grant:comprador});
    assert.equal(cierre.faltan,2);
    assert.equal(cierre.telefonos.length,3);
    assert.deepEqual(await grants.estadoCompra(),{activa:false});
    await assert.rejects(grants.listar({grant:comprador}),/CERRADA_O_EXPIRADA/);
    const total=await db.execute("SELECT COUNT(*) AS n FROM productos");
    assert.equal(Number(total.rows[0].n),6);
    const pend=await db.execute("SELECT COUNT(*) AS n FROM productos WHERE agotado=1");
    assert.equal(Number(pend.rows[0].n),2);
  }finally{
    db.close();try{fs.unlinkSync(file);}catch(_){}
  }
});
