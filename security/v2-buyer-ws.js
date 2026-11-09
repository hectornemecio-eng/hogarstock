"use strict";
// Notificaciones en tiempo real para compradores autorizados.
// Los mensajes NO contienen inventario, teléfonos ni tokens.
function crearCanalCompradores({WebSocketServer,identidad,grants,origen,maxConexiones=64}={}) {
  if(typeof WebSocketServer!=="function" ||
    typeof identidad?.leerComprador!=="function" ||
    typeof grants?.listar!=="function" ||
    typeof origen!=="string" || !/^https:\/\//.test(origen) ||
    !Number.isSafeInteger(maxConexiones)||maxConexiones<1||maxConexiones>256)
    throw Error("HS_BUYER_WS_CONFIG_INVALIDA");

  const wss=new WebSocketServer({noServer:true,maxPayload:1024});
  function aceptaUpgrade(req) {
    if(req?.headers?.origin!==origen)return false;
    try{
      const url=new URL(req.url,"https://host.invalid");
      return url.pathname==="/ws-comprador" && !url.search && !url.hash;
    }catch(_){return false;}
  }
  function upgrade(req,socket,head) {
    if(!aceptaUpgrade(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if(wss.clients.size>=maxConexiones){
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));
  }
  wss.on("connection",ws=>{
    let autenticando=false;
    ws.hsGrant=null;
    ws.hsVivo=true;
    const limite=setTimeout(()=>{
      if(!ws.hsGrant)ws.close(1008,"Autenticacion requerida");
    },7000);
    limite.unref?.();
    ws.on("close",()=>clearTimeout(limite));
    ws.on("error",()=>{});
    ws.on("pong",()=>{ws.hsVivo=true;});
    ws.on("message",async raw=>{
      if(ws.hsGrant || autenticando){ws.close(1008,"Protocolo invalido");return;}
      autenticando=true;
      try{
        const d=JSON.parse(raw.toString("utf8"));
        if(!d || d.type!=="auth" || typeof d.token!=="string" ||
          d.token.length<40 || d.token.length>256)
          throw Error("AUTH_INVALIDA");
        const grant=identidad.leerComprador("Bearer "+d.token);
        if(!grant || grant.exp<=Date.now())throw Error("AUTH_INVALIDA");
        // Verifica también que la compra esté abierta y el token no revocado.
        await grants.listar({grant});
        if(ws.readyState!==1)return;
        clearTimeout(limite);
        ws.hsGrant=grant; // No guardar ni reenviar el token original.
        ws.send(JSON.stringify({type:"sincronizar"}));
      }catch(_){
        if(ws.readyState===1)ws.close(1008,"Compra no autorizada");
      }
    });
  });
  function notificar({compraId,tipo="actualizar"}={}) {
    if(typeof compraId!=="string"||!/^[a-f0-9]{48}$/.test(compraId)||
       (tipo!=="actualizar"&&tipo!=="cerrada"))return 0;
    const msg=JSON.stringify({type:tipo});
    let cantidad=0;
    for(const ws of wss.clients){
      if(ws.readyState!==1 || !ws.hsGrant || ws.hsGrant.idCompra!==compraId)continue;
      if(ws.hsGrant.exp<=Date.now()){ws.close(1008,"Invitacion expirada");continue;}
      ws.send(msg);
      cantidad++;
    }
    return cantidad;
  }
  const pulso=setInterval(()=>{
    for(const ws of wss.clients) {
      if(ws.readyState!==1)continue;
      if(!ws.hsVivo){ws.terminate();continue;}
      if(ws.hsGrant && ws.hsGrant.exp<=Date.now()){
        ws.close(1008,"Invitacion expirada");
        continue;
      }
      ws.hsVivo=false;
      try{ws.ping();}catch(_){ws.terminate();}
    }
  },30000);
  pulso.unref?.();
  function cerrar(){
    clearInterval(pulso);
    for(const ws of wss.clients)ws.terminate();
    wss.close();
  }
  return Object.freeze({aceptaUpgrade,upgrade,notificar,cerrar});
}
module.exports={crearCanalCompradores};
