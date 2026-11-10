"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const os=require("node:os");
const path=require("node:path");
const {createClient}=require("@libsql/client");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const {crearGrantsV2}=require("../security/v2-grants");

test("UI v3.96: sintaxis, pantallas y rutas protegidas",()=>{
  const backend=fs.readFileSync("server.js","utf8");
  const admin=fs.readFileSync("public/index.html","utf8");
  const buyer=fs.readFileSync("public/comprador.html","utf8");
  const login=fs.readFileSync("public/admin-login.html","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  for(const [name,html] of [["admin",admin],["comprador",buyer],["login",login]]){
    assert(html.includes('href="/hogarstock-ui.css"'),name);
    assert.equal((html.match(/<body\b/g)||[]).length,1);
    assert.equal((html.match(/<\/body>/g)||[]).length,1);
    const scripts=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    for(const s of scripts)if(s[1].trim())new vm.Script(s[1],{filename:name+".html"});
  }
  for(const id of ["compraPanel","compraEstado","compraParticipantes","compraPendientes",
    "compraInicio","btnFinalizarAdmin","btnRevocar","btnEnviar","lista","contactosSeleccionados",
    "metricTotal","metricPending","metricAvailable"]){
    assert(admin.includes('id="'+id+'"'),"Falta "+id);
  }
  for(const route of [
    'app.get("/api/admin/compra-activa",http.admin',
    'app.post("/api/admin/finalizar-compra",http.adminWrite',
    'app.post("/api/admin/revocar-compra",http.adminWrite',
    'app.post("/api/iniciar-compra",http.adminWrite'
  ])assert(backend.includes(route),route);
  assert(admin.includes('fetch("/api/admin/compra-activa"'));
  assert(admin.includes('fetch("/api/admin/finalizar-compra"'));
  assert(admin.includes('fetch("/api/admin/contactos"'));
  assert(admin.includes('localStorage.setItem(ALIAS_KEY'));
  assert(css.includes(".shared-purchase-head"));
  assert(css.includes(".contact-info"));
  assert(css.includes(".buyer-category-icon"));
  assert(buyer.includes("buyer-category-total"));
  assert(!/https?:\/\/[^\s]+/.test(css)); // sin assets de terceros
  assert.equal((css.match(/{/g)||[]).length,(css.match(/}/g)||[]).length);
  console.log("V396_UI_SYNTAX_ACCESS_CONTROL_OK");
});

test("Compra en Turso ficticio: recargar, invitar, marcar y finalizar desde escritorio",async()=>{
  const file=path.join(os.tmpdir(),"hs_v396_"+process.pid+".db");
  const db=createClient({url:"file:"+file});
  try{
    await db.execute("CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
    await db.batch([
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[1,"Peras","Fruta",1]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[2,"Papas","Verdura",1]},
      {sql:"INSERT INTO productos VALUES(?,?,?,?)",args:[3,"Uvas","Fruta",0]}
    ],"write");
    const identidad=crearIdentidadV2({entorno:generarMaterial("solo-prueba-aislada-v396-muy-larga")});
    const nums=["34600000001","34600000002","34600000003"];
    const grants=crearGrantsV2({db,identidad,contactos:nums});
    await grants.init();
    assert.deepEqual(await grants.estadoCompra(),{activa:false});
    await assert.rejects(grants.finalizarAdmin(),/HS_V2_SIN_COMPRA_ACTIVA/);
    const a=await grants.crearCompra({telefono:nums[0]});
    const b=await grants.prepararEnvio({telefono:nums[1]});
    assert.equal(a.compraId,b.compraId);
    await grants.registrarEnviado({compraId:a.compraId,telefono:nums[1]});
    let estado=await grants.estadoCompra();
    assert.equal(estado.activa,true);
    assert.equal(estado.compraId,a.compraId);
    assert.equal(estado.pendientes,2);
    assert.deepEqual(estado.telefonos,[nums[0],nums[1]]);
    assert(Number.isSafeInteger(estado.creada)&&estado.creada>0);
    const comprador=identidad.leerComprador("Bearer "+a.token);
    await grants.marcar({grant:comprador,productoId:1});
    estado=await grants.estadoCompra();
    assert.equal(estado.pendientes,1);
    const cierre=await grants.finalizarAdmin();
    assert.equal(cierre.compraId,a.compraId);
    assert.equal(cierre.faltan,1);
    assert.deepEqual(cierre.pendientes,["Papas"]);
    assert.deepEqual(cierre.telefonos,[nums[0],nums[1]]);
    assert.deepEqual(await grants.estadoCompra(),{activa:false});
    await assert.rejects(grants.listar({grant:comprador}),/CERRADA_O_EXPIRADA/);
    const v=await db.execute("SELECT agotado FROM productos ORDER BY id");
    assert.deepEqual(v.rows.map(x=>Number(x.agotado)),[0,1,0]);
    console.log("V396_SHARED_PURCHASE_ADMIN_FINALIZE_OK");
  }finally{
    db.close();try{fs.unlinkSync(file);}catch(_){}
  }
});

test("Panel administrador recupera compra tras recargar sin mutar datos",async()=>{
  const html=fs.readFileSync("public/index.html","utf8");
  const src=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(Boolean);
  assert(src);
  const dom=new Map();
  const element=(id)=>{
    if(!dom.has(id))dom.set(id,{
      id,innerHTML:"",textContent:"",className:"",disabled:false,value:"",style:{},
      checked:false,children:[],setAttribute(){},addEventListener(){},
      append(...els){this.children.push(...els);},replaceChildren(...els){this.children=[...els]},
      querySelectorAll(){return []}
    });
    return dom.get(id);
  };
  const reqs=[];
  const serverFetch=async(url,options)=>{
    reqs.push({url,method:options?.method||"GET"});
    return {ok:true,status:200,json:async()=>{
      if(url==="/api/admin/session")return {csrf:"prueba"};
      if(url==="/api/admin/contactos")return {telefonos:["34600000001","34600000002"]};
      if(url==="/api/admin/compra-activa")return {
        activa:true,compraId:"a".repeat(48),creada:Date.now(),expira:Date.now()+100000,
        pendientes:2,telefonos:["34600000001","34600000002"]};
      if(url==="/api/productos")return [
        {id:1,nombre:"Peras",categoria:"Frutas",agotado:1},
        {id:2,nombre:"Papas",categoria:"Verduras",agotado:0}];
      if(url==="/api/whatsapp-status")return {conectado:false,qr:null};
      return {};
    }};
  };
  function Socket(){this.close=()=>{};this.readyState=0}
  Socket.OPEN=1;Socket.CONNECTING=0;
  const x={document:{getElementById:element,createElement:t=>element(t+":"+Math.random()),
    addEventListener(){}},location:{protocol:"https:",host:"hogarstock.test.invalid",replace(){}},
    WebSocket:Socket,localStorage:{getItem:()=>null,setItem(){}},fetch:serverFetch,
    console,setInterval(){return 1},setTimeout(){return 2},clearTimeout(){},
    prompt:()=>null,confirm:()=>false,alert(){},URL,Math,Date,Intl,Set,
    encodeURIComponent,decodeURIComponent};
  x.window=x;
  vm.runInNewContext(src,x,{timeout:5000});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(element("compraEstado").textContent,"En curso");
  assert.equal(element("compraParticipantes").textContent,"2");
  assert.equal(element("compraPendientes").textContent,"2");
  assert.equal(element("btnRevocar").disabled,false);
  assert.equal(element("btnFinalizarAdmin").disabled,false);
  assert.equal(element("metricTotal").textContent,"2");
  assert.equal(element("metricPending").textContent,"1");
  assert(reqs.some(x=>x.url==="/api/admin/compra-activa"));
  assert(reqs.every(x=>x.method==="GET"));
  console.log("V396_BROWSER_RELOAD_RESTORES_ACTIVE_PURCHASE_OK");
});