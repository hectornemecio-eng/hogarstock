"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {once}=require("node:events");
const {WebSocket,WebSocketServer}=require("ws");
const {createClient}=require("@libsql/client");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const {crearGrantsV2}=require("../security/v2-grants");
const {crearCanalCompradores}=require("../security/v2-buyer-ws");

function esperarMensaje(ws,ms=6000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{limpiar();reject(Error("TIMEOUT_WS_MESSAGE"));},ms);
    const mensaje=data=>{limpiar();resolve(JSON.parse(data.toString("utf8")));};
    const cerrado=()=>{limpiar();reject(Error("WS_CERRADO_PREMATURO"));};
    function limpiar(){
      clearTimeout(timer);ws.off("message",mensaje);ws.off("close",cerrado);
    }
    ws.on("message",mensaje);ws.on("close",cerrado);
  });
}
function esperarCierre(ws,ms=6000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{limpiar();reject(Error("TIMEOUT_WS_CLOSE"));},ms);
    const cierre=code=>{limpiar();resolve(code);};
    function limpiar(){clearTimeout(timer);ws.off("close",cierre);}
    ws.on("close",cierre);
  });
}
async function conectar(url,origen,token){
  const ws=new WebSocket(url,{headers:{Origin:origen}});
  await once(ws,"open");
  const mensaje=esperarMensaje(ws);
  ws.send(JSON.stringify({type:"auth",token}));
  assert.deepEqual(await mensaje,{type:"sincronizar"});
  return ws;
}
test("Compradores: avisos inmediatos, revocacion, aislamiento y cambios concurrentes",async()=>{
  const archivo=path.join(os.tmpdir(),"hs_ws_ci_"+process.pid+".db");
  const db=createClient({url:"file:"+archivo});
  const origen="https://hogarstock.test.invalid";
  const clientes=[];
  let hub,server;
  try{
    await db.execute("CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
    await db.batch([
      {sql:"INSERT INTO productos VALUES (1,'Peras','Fruta',1)"},
      {sql:"INSERT INTO productos VALUES (2,'Papas','Verdura',1)"},
      {sql:"INSERT INTO productos VALUES (3,'Uvas','Fruta',1)"}
    ],"write");
    const identidad=crearIdentidadV2({entorno:generarMaterial("contrasena-solo-pruebas-extensa")});
    const grants=crearGrantsV2({db,identidad,contactos:["34600000001","34600000002"]});
    await grants.init();
    const compra=await grants.prepararEnvio({telefono:"34600000001"});
    const compartida=await grants.prepararEnvio({telefono:"34600000002"});
    assert.equal(compra.compraId,compartida.compraId);
    assert.equal(compra.token,compartida.token);
    hub=crearCanalCompradores({WebSocketServer,identidad,grants,origen,maxConexiones:8});
    server=http.createServer((req,res)=>{res.writeHead(404).end();});
    server.on("upgrade",(req,socket,head)=>{
      if(hub.aceptaUpgrade(req))hub.upgrade(req,socket,head);
      else{socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");socket.destroy();}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const url="ws://127.0.0.1:"+server.address().port+"/ws-comprador";
    const A=await conectar(url,origen,compra.token);clientes.push(A);
    const B=await conectar(url,origen,compra.token);clientes.push(B);
    // Los dos clientes reciben el MISMO evento y consultan la lista central.
    const avisoA=esperarMensaje(A),avisoB=esperarMensaje(B);
    const grant=identidad.leerComprador("Bearer "+compra.token);
    const resultado=await grants.marcar({grant,productoId:1});
    assert.equal(resultado.yaRegistrado,false);
    assert.equal(hub.notificar({compraId:compra.compraId}),2);
    assert.deepEqual(await avisoA,{type:"actualizar"});
    assert.deepEqual(await avisoB,{type:"actualizar"});
    assert.deepEqual((await grants.listar({grant})).filter(x=>x.agotado).map(x=>x.nombre).sort(),
      ["Papas","Uvas"]);
    // Segunda marca simultanea o tardia no cambia un producto ya adquirido.
    const repetido=await grants.marcar({grant,productoId:1});
    assert.equal(repetido.yaRegistrado,true);
    const cambio=await grants.alternarProducto({productoId:3});
    assert.equal(cambio.compraId,compra.compraId);
    assert.equal(cambio.nuevoEstado,0);
    assert.deepEqual((await grants.listar({grant})).filter(x=>x.agotado).map(x=>x.nombre),["Papas"]);

    // Un cliente sin token valido nunca obtiene mensajes de una compra.
    const invalido=new WebSocket(url,{headers:{Origin:origen}});clientes.push(invalido);
    await once(invalido,"open");
    const cerrado=esperarCierre(invalido);
    invalido.send(JSON.stringify({type:"auth",token:"NO_ES_UN_TOKEN"}));
    assert.equal(await cerrado,1008);
    // El token jamas puede colocarse en la URL (evita logs y filtraciones).
    const query=new WebSocket(url+"?token=falso",{headers:{Origin:origen}});
    clientes.push(query);
    const rechazo=new Promise(resolve=>query.once("error",()=>resolve(true)));
    assert.equal(await rechazo,true);
    // Una peticion desde otro origen tampoco puede abrir el canal.
    const otro=new WebSocket(url,{headers:{Origin:"https://otro.ejemplo.invalid"}});
    clientes.push(otro);
    const rechazoOrigen=new Promise(resolve=>otro.once("error",()=>resolve(true)));
    assert.equal(await rechazoOrigen,true);

    const cierreA=esperarMensaje(A),cierreB=esperarMensaje(B);
    assert.equal(await grants.revocar({compraId:compra.compraId}),true);
    assert.equal(hub.notificar({compraId:compra.compraId,tipo:"cerrada"}),2);
    assert.deepEqual(await cierreA,{type:"cerrada"});
    assert.deepEqual(await cierreB,{type:"cerrada"});
    await assert.rejects(grants.listar({grant}),/COMPRA_CERRADA_O_EXPIRADA/);
    const stock=await db.execute("SELECT id,agotado FROM productos ORDER BY id");
    assert.equal(stock.rows.length,3);
    assert.deepEqual(stock.rows.map(x=>Number(x.agotado)),[0,1,0]);
    console.log("BUYERS_WS_AUTH_ISOLATION_AND_LIVE_SYNC_OK");
  }finally{
    for(const client of clientes)try{client.terminate();}catch(_){}
    if(hub)hub.cerrar();
    if(server)await new Promise(resolve=>server.close(resolve));
    db.close();
    try{fs.unlinkSync(archivo);}catch(_){}
  }
});