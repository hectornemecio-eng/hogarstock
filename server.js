
const express = require("express");
const path = require("node:path");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./db");
const {crearIdentidadV2}=require("./security/v2-identity");
const {crearAlmacenClaveAdmin}=require("./security/v2-password-store");
const {crearHTTPV2}=require("./security/v2-http");
const {crearCanalCompradores}=require("./security/v2-buyer-ws");
const {crearGrantsV2}=require("./security/v2-grants");
const {crearAuthTurso}=require("./whatsapp/wa-auth-turso");
const {crearLeaseWa}=require("./whatsapp/wa-lease");
const {permitirVinculacionNueva}=require("./whatsapp/wa-pairing-policy");
const {prepararNuevaVinculacion}=require("./whatsapp/wa-relink");

let makeWASocket;
let initAuthCreds;
let BufferJSON;
let proto;
let DisconnectReason;
let fetchLatestWaWebVersion;
let promesaBaileys;

async function cargarBaileys() {
  if (!promesaBaileys) {
    promesaBaileys = import("@whiskeysockets/baileys")
      .then((modulo) => {
        makeWASocket = modulo.default;
        initAuthCreds = modulo.initAuthCreds;
        BufferJSON = modulo.BufferJSON;
        proto = modulo.proto;
        DisconnectReason = modulo.DisconnectReason;
        fetchLatestWaWebVersion = modulo.fetchLatestWaWebVersion;

        if (
          typeof makeWASocket !== "function" ||
          typeof initAuthCreds !== "function" ||
          !BufferJSON || !proto ||
          typeof fetchLatestWaWebVersion !== "function"
        ) {
          throw new Error(
            "La version instalada de Baileys no exporta las funciones requeridas. Revisar package.json."
          );
        }
      })
      .catch((error) => {
        promesaBaileys = null;
        throw error;
      });
  }
  await promesaBaileys;
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({noServer:true});

app.disable("x-powered-by");
app.use(express.json({limit:"16kb"}));
app.use((req,res,next)=>{
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  next();
});
// Ausencia de configuración segura = fallo cerrado antes de servir HTTP.
const identidad=crearIdentidadV2({entorno:process.env});
const almacenAdmin=crearAlmacenClaveAdmin({db,identidad,entorno:process.env});
const origen=(process.env.PUBLIC_BASE_URL||"https://hogarstock.onrender.com").replace(/\/+$/g,"");
const http=crearHTTPV2({identidad,almacenAdmin,origen});
const contactos=(process.env.WA_ALLOWED_NUMBERS||"").split(",").map(x=>x.trim()).filter(Boolean);
const grants=crearGrantsV2({db,identidad,contactos});
const compradoresWS=crearCanalCompradores({WebSocketServer,identidad,grants,origen});
let envioListaEnCurso=false;
server.on("upgrade",(req,socket,head)=>{
  if(compradoresWS.aceptaUpgrade(req)){
    compradoresWS.upgrade(req,socket,head);
    return;
  }
  // Una sesión administrativa antigua no puede seguir entrando por WebSocket
  // después de cambiar la contraseña en otro proceso de Render.
  void (async()=>{
    try{await almacenAdmin.sincronizar();}
    catch(_){
      socket.destroy();
      return;
    }
    if(!http.websocketAdmin(req)){
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();return;
    }
    wss.handleUpgrade(req,socket,head,ws=>{
      const session=identidad.leerAdmin(req.headers.cookie);
      if(!session){ws.close(1008,"Sesión inválida");return;}
      ws.hsCookie=req.headers.cookie;
      const timeout=setTimeout(()=>ws.close(1008,"Sesión expirada"),
        Math.max(0,session.exp-Date.now()));
      ws.on("close",()=>clearTimeout(timeout));
      wss.emit("connection",ws,req);
    });
  })().catch(()=>{try{socket.destroy();}catch(_){}});
});
app.use(express.static(path.join(__dirname,"public")));

let sock = null;
let qrActual = null;
let whatsappConectado = false;
let reconexionTimer = null;
let intentosFallidos = 0;
let errorWhatsApp = null;
let waLease = null;
let waLeaseTimer = null;
let waLeasePerdido = false;
let waLeaseRenovando = false;
let waResetInProgress = false;
let waCredencialesPendientes = Promise.resolve();

function bloquearPorPerdidaDeLease() {
  if (waLeasePerdido) return;
  waLeasePerdido = true;
  if (waLeaseTimer) clearInterval(waLeaseTimer);
  if (reconexionTimer) clearTimeout(reconexionTimer);
  waLeaseTimer = null;
  reconexionTimer = null;
  const anterior = sock;
  sock = null;
  qrActual = null;
  whatsappConectado = false;
  errorWhatsApp = "HS_WA_LEASE_PERDIDO";
  console.error("Sesión WhatsApp detenida: se perdió la exclusión del propietario.");
  anunciarEstado();
  try { anterior?.end(new Error("HS_WA_LEASE_PERDIDO")); } catch (_) {}
}

async function prepararWaLease() {
  if (waLeasePerdido) throw Error("HS_WA_LEASE_PERDIDO");
  if (waLease) {
    await waLease.verificar();
    return waLease;
  }
  const candidato = crearLeaseWa({db});
  await candidato.adquirir();
  waLease = candidato;
  waLeaseTimer = setInterval(() => {
    if (waLeaseRenovando || waLeasePerdido) return;
    waLeaseRenovando = true;
    void candidato.renovar().catch(() => bloquearPorPerdidaDeLease())
      .finally(() => {waLeaseRenovando = false;});
  }, 10000);
  waLeaseTimer.unref?.();
  return candidato;
}

async function liberarWaLeaseSinSocket() {
  if (sock || !waLease || waLeasePerdido) return;
  if (waLeaseTimer) clearInterval(waLeaseTimer);
  waLeaseTimer = null;
  const anterior=waLease;
  waLease=null;
  await anterior.liberar();
}

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      if(!identidad.leerAdmin(client.hsCookie)){
        client.close(1008,"Sesión revocada");
        return;
      }
      client.send(JSON.stringify(data));
    }
  });
}

function anunciarEstado() {
  broadcast({ type: "qr_update" });
}

function programarReconexion() {
  if (reconexionTimer) return;

  intentosFallidos += 1;

  const segundos = Math.min(
    30 * (2 ** Math.min(intentosFallidos - 1, 3)),
    300
  );

  console.log(
    `Reintentando WhatsApp en ${segundos} segundos (intento ${intentosFallidos}).`
  );

  reconexionTimer = setTimeout(() => {
    reconexionTimer = null;
    void iniciarWhatsApp();
  }, segundos * 1000);
}

async function iniciarWhatsApp() {
  try {
    await cargarBaileys();

    const respuesta = await fetchLatestWaWebVersion();
    const version = respuesta && respuesta.version;

    if (
      !respuesta ||
      respuesta.isLatest !== true ||
      !Array.isArray(version) ||
      version.length !== 3 ||
      !version.every((v) =>
        Number.isInteger(v) && v >= 0
      )
    ) {
      throw new Error(
        "No se pudo confirmar una version actual de WhatsApp Web. Se evitara conectar con una version obsoleta."
      );
    }

    console.log(
      `Version WhatsApp Web consultada: ${version.join(".")}`
    );

    // Una sola instancia nueva puede escribir las claves Signal.
    // Exige migración explícita de la sesión antigua antes de conectar.
    const lease = await prepararWaLease();
    const { state, saveCreds } = await crearAuthTurso({
      db,
      lease,
      claveHex: process.env.HS_WA_AUTH_ENC_KEY,
      permitirAltaNueva: permitirVinculacionNueva(process.env),
      baileys: {initAuthCreds, BufferJSON, proto}
    }).abrir();

    const nuevoSocket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
    });

    sock = nuevoSocket;
    qrActual = null;
    whatsappConectado = false;
    errorWhatsApp = null;

    anunciarEstado();

    // Serializa escrituras concurrentes: si falla la persistencia,
    // deshabilita envíos y corta el socket para evitar divergencia de claves.
    let colaCredenciales = Promise.resolve();
    let persistenciaFallida = false;
    nuevoSocket.ev.on("creds.update", () => {
      if (persistenciaFallida || waResetInProgress) return;
      colaCredenciales = colaCredenciales.then(() => saveCreds()).catch(() => {
        persistenciaFallida = true;
        if (sock === nuevoSocket) {
          sock = null;
          whatsappConectado = false;
          qrActual = null;
          errorWhatsApp = "FALLO_PERSISTENCIA_SESION_REQUIERE_REVISION";
          anunciarEstado();
        }
        console.error("Fallo al persistir credenciales WhatsApp; sesión detenida.");
        try {nuevoSocket.end(new Error("WA_AUTH_PERSISTENCIA_FALLIDA"));} catch (_) {}
      });
      waCredencialesPendientes = colaCredenciales;
    });

    nuevoSocket.ev.on("connection.update", (update) => {
      if (sock !== nuevoSocket) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("Nuevo QR de WhatsApp generado.");
        qrActual = qr;
        whatsappConectado = false;
        errorWhatsApp = null;
        anunciarEstado();
      }

      if (connection === "open") {
        whatsappConectado = true;
        qrActual = null;
        errorWhatsApp = null;
        intentosFallidos = 0;

        console.log("WhatsApp conectado.");
        anunciarEstado();
        return;
      }

      if (connection === "close") {
        // Descartar el socket viejo antes del siguiente intento.
        sock = null;
        whatsappConectado = false;
        qrActual = null;

        const codigo =
          lastDisconnect?.error?.output?.statusCode;

        errorWhatsApp =
          `Conexion cerrada (codigo ${codigo ?? "desconocido"})`;

        console.error(errorWhatsApp);
        anunciarEstado();

        if (codigo === DisconnectReason.loggedOut) {
          console.error(
            "WhatsApp cerro la sesion. Se requiere revisar la vinculacion; no se borraran credenciales automaticamente."
          );
          return;
        }

        if (codigo === DisconnectReason.restartRequired) {
          // Tras escanear el QR, WhatsApp solicita reconectar con las claves nuevas.
          // Nunca abrir el socket siguiente antes de terminar de persistirlas en Turso.
          console.log("WhatsApp: reinicio de sesion tras emparejamiento.");
          void colaCredenciales.then(() => {
            if (persistenciaFallida || waLeasePerdido) return;
            intentosFallidos = 0;
            if (reconexionTimer) clearTimeout(reconexionTimer);
            reconexionTimer = setTimeout(() => {
              reconexionTimer = null;
              void iniciarWhatsApp();
            }, 1000);
          }).catch(() => {
            console.error("WhatsApp: credenciales no confirmadas; reinicio cancelado.");
          });
          return;
        }

        programarReconexion();
      }
    });
  } catch (error) {
    whatsappConectado = false;
    qrActual = null;

    errorWhatsApp =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "Error al iniciar WhatsApp:",
      errorWhatsApp
    );

    anunciarEstado();
    // En despliegue sin interrupciones, el proceso anterior puede conservar el
    // lease durante unos segundos. Solo reintentar: nunca robarlo ni borrar datos.
    if (errorWhatsApp === "HS_WA_LEASE_EN_USO") {
      console.warn("WhatsApp: esperando liberacion de lease por la instancia anterior.");
      programarReconexion();
      return;
    }
    // Datos cifrados irrecuperables o esquema incompatible: no reintentar
    // indefinidamente ni crear una sesión nueva sobre credenciales dañadas.
    if (/^HS_WA_(AUTH_(CIFRADO_INVALIDO|PARCIAL_SIN_CREDENCIALES|SIN_SESION_MIGRADA|ESQUEMA_INCOMPATIBLE|CONFIG_INVALIDA)|LEASE_(PERDIDO|EN_USO|ESQUEMA_INCOMPATIBLE))/.test(errorWhatsApp)) {
      console.error("Persistencia o exclusión de WhatsApp bloqueada; requiere revisión sin borrar datos.");
      if (errorWhatsApp === "HS_WA_AUTH_SIN_SESION_MIGRADA") {
        await liberarWaLeaseSinSocket();
      }
      return;
    }
    programarReconexion();
  }
}

async function enviarWhatsApp(telefono, mensaje) {
  if (!whatsappConectado || !sock) {
    throw new Error("WhatsApp no esta conectado.");
  }

  const numero = String(telefono || "")
    .replace(/[^0-9]/g, "");

  if (!/^\d{8,15}$/.test(numero)) {
    throw new Error(
      "Numero de WhatsApp no valido; utiliza el prefijo internacional."
    );
  }

  await sock.sendMessage(
    `${numero}@s.whatsapp.net`,
    { text: mensaje }
  );
}


// Rutas seguras propuestas para V2. Todas requieren identidad apropiada.
function resultadoPublico(res,error){
  const msg=String(error?.message||"");
  if (msg.includes("NO_AUTORIZADO")||msg.includes("NO_PERMITIDO"))
    return res.status(403).json({error:"ACCESO_NO_AUTORIZADO"});
  if (msg.includes("YA_ABIERTA")||msg.includes("CERRADA_O_EXPIRADA")||msg.includes("CAMBIO_CONCURRENTE"))
    return res.status(409).json({error:"COMPRA_NO_DISPONIBLE"});
  if (msg.includes("SIN_COMPRA_ACTIVA"))return res.status(409).json({error:"SIN_COMPRA_ACTIVA"});
  if (msg.includes("MULTIPLES_COMPRAS_ABIERTAS"))return res.status(409).json({error:"ESTADO_COMPRA_INCONSISTENTE"});
  if (msg.includes("SIN_FALTANTES"))return res.status(409).json({error:"SIN_FALTANTES"});
  if (msg.includes("PRODUCTO_NO_AUTORIZADO"))return res.status(403).json({error:"PRODUCTO_NO_AUTORIZADO"});
  console.error("Error de operación HogarStock V2 seguro:",error?.code||"OPERACION_FALLIDA");
  return res.status(500).json({error:"OPERACION_NO_COMPLETADA"});
}
app.post("/api/admin/login",http.login);
app.get("/api/admin/session",http.estadoAdmin);
app.post("/api/admin/logout",http.logout);
const intentosCambioClave=new Map();
app.post("/api/admin/cambiar-clave",http.adminWrite,async(req,res)=>{
  const ip=String(req.socket?.remoteAddress||"desconocido").slice(0,120);
  const ahora=Date.now();
  let intentos=intentosCambioClave.get(ip)||{first:ahora,n:0};
  if(ahora-intentos.first>15*60*1000){
    intentos={first:ahora,n:0};intentosCambioClave.delete(ip);
  }
  if(intentos.n>=5)return res.status(429).json({error:"CAMBIO_CLAVE_TEMPORALMENTE_LIMITADO"});
  try{
    await almacenAdmin.cambiar({
      actual:req.body?.actual,
      nueva:req.body?.nueva
    });
    intentosCambioClave.delete(ip);
    // Invalidar todas las ventanas y cerrar la actual: se inicia sesión de nuevo.
    for(const cliente of wss.clients){
      try{cliente.close(1008,"Sesión administrativa renovada");}catch(_){}
    }
    res.setHeader("Set-Cookie",identidad.borrarCookie());
    res.setHeader("Cache-Control","no-store");
    return res.json({ok:true,relogin:true});
  }catch(error){
    const motivo=String(error?.message||"");
    if(motivo==="HS_ADMIN_CLAVE_ACTUAL_INCORRECTA"){
      intentos.n++;intentosCambioClave.set(ip,intentos);
      return res.status(403).json({error:"CLAVE_ACTUAL_INCORRECTA"});
    }
    if(motivo==="HS_ADMIN_CLAVE_NUEVA_LONGITUD" ||
      motivo==="HS_ADMIN_CLAVE_SIN_CAMBIOS"){
      return res.status(400).json({error:motivo});
    }
    console.error("HogarStock: cambio de clave no completado.");
    return res.status(503).json({error:"CAMBIO_CLAVE_NO_CONFIRMADO"});
  }
});

app.get("/api/admin/compra-activa",http.admin,async(req,res)=>{
  try {
    const compra=await grants.estadoCompra();
    res.setHeader("Cache-Control","no-store");
    res.json(compra);
  }catch(error){resultadoPublico(res,error);}
});
app.get("/api/admin/contactos",http.admin,(req,res)=>{
  // Los nombres solo están en el entorno privado de Render, nunca en el repositorio.
  // Únicamente se muestran a administradores y para números ya autorizados.
  const telefonos=grants.listarContactos();
  const nombres=Object.create(null);
  let configurados={};
  try{
    const datos=JSON.parse(process.env.WA_CONTACT_NAMES_JSON||"{}");
    if(datos && typeof datos==="object" && !Array.isArray(datos))configurados=datos;
  }catch(_){console.warn("HogarStock: formato de alias privados inválido.");}
  for(const numero of telefonos){
    if(!Object.prototype.hasOwnProperty.call(configurados,numero))continue;
    const valor=configurados[numero];
    if(typeof valor==="string" && valor.trim().length>0 && valor.trim().length<=40){
      nombres[numero]=valor.trim();
    }
  }
  res.setHeader("Cache-Control","no-store");
  res.json({telefonos,nombres});
});
app.get("/api/productos",http.admin,async(req,res)=>{
  try {
    const q=await db.execute("SELECT id,nombre,categoria,agotado FROM productos ORDER BY categoria,nombre");
    res.json(q.rows);
  } catch(error){resultadoPublico(res,error);}
});
app.get("/api/whatsapp-status",http.admin,(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.json({conectado:whatsappConectado,qr:qrActual,error:errorWhatsApp?"FALLO_CONEXION":null,
    requiereRevinculacion:!whatsappConectado && !sock &&
      typeof errorWhatsApp==="string" && errorWhatsApp.includes("codigo 401")});
});
app.post("/api/admin/revincular-whatsapp",http.adminWrite,async(req,res)=>{
  // La operacion solo ocurre despues de un clic y confirmacion expresa.
  if(req.body?.confirmacion!=="REVINCULAR_SOLO_WHATSAPP")
    return res.status(400).json({error:"CONFIRMACION_REQUERIDA"});
  if(waResetInProgress || sock || whatsappConectado ||
    !String(errorWhatsApp||"").includes("codigo 401") || !waLease || waLeasePerdido)
    return res.status(409).json({error:"WHATSAPP_NO_ESTA_LISTO_PARA_REVINCULAR"});
  waResetInProgress=true;
  try {
    // Antes de reemplazar la sesion rechazada, finalizar todas las escrituras
    // pendientes del mismo proceso para que no reaparezcan claves antiguas.
    await waCredencialesPendientes;
    await cargarBaileys();
    const snapshot=await prepararNuevaVinculacion({
      db,lease:waLease,claveHex:process.env.HS_WA_AUTH_ENC_KEY,
      initAuthCreds,BufferJSON
    });
    await liberarWaLeaseSinSocket();
    errorWhatsApp=null;
    intentosFallidos=0;
    qrActual=null;
    res.json({ok:true,credencialesArchivadas:snapshot.archivados});
    // Se generara un QR nuevo a partir de las credenciales frescas.
    setImmediate(()=>{void iniciarWhatsApp();});
  }catch(err){
    console.error("Fallo controlado al preparar nueva vinculacion WhatsApp:",err?.message?.startsWith("HS_")?err.message:"OPERACION_FALLIDA");
    return res.status(409).json({error:"NO_SE_PUDO_PREPARAR_NUEVA_VINCULACION"});
  }finally{waResetInProgress=false;}
});
app.post("/api/agotar/:id",http.adminWrite,async(req,res)=>{
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:"ID_INVALIDO"});
    const cambio=await grants.alternarProducto({productoId:id});
    const productos=await db.execute("SELECT id,nombre,categoria,agotado FROM productos ORDER BY categoria,nombre");
    broadcast({type:"update",productos:productos.rows}); // WS SOLO admin
    if(cambio.compraId)compradoresWS.notificar({compraId:cambio.compraId});
    res.json({ok:true,nuevoEstado:cambio.nuevoEstado,compraActiva:cambio.compraActiva});
  }catch(error){resultadoPublico(res,error);}
});
app.post("/api/iniciar-compra",http.adminWrite,async(req,res)=>{
  if(!whatsappConectado||!sock)return res.status(503).json({error:"WHATSAPP_NO_CONECTADO"});
  if(envioListaEnCurso)return res.status(409).json({error:"ENVIO_EN_PROGRESO"});
  envioListaEnCurso=true;
  try {
    // Compatibilidad: numero unico o grupo de 1 a 10 contactos autorizados.
    const input=Array.isArray(req.body?.telefonos)?req.body.telefonos:[req.body?.telefono];
    const destinos=grants.validarDestinatarios(input);
    const reenviar=req.body?.reenviar===true; // Solo por orden explícita desde el panel admin.
    const compra=await grants.prepararEnvio({telefono:destinos[0]});
    const base=(process.env.PUBLIC_BASE_URL||"https://hogarstock.onrender.com").replace(/\/+$/g,"");
    const enlace=base+"/comprador.html#token="+encodeURIComponent(compra.token);
    const mensaje="🛒 *Lista de compra*\n\n"+compra.nombres.map(x=>"- "+x).join("\n")+
      "\n\nAbre este enlace:\n"+enlace;
    const enviados=[],reenviados=[],yaEnviados=[],fallidos=[],inciertos=[];
    for(let i=0;i<destinos.length;i++){
      const numero=destinos[i],esOriginalNueva=compra.nueva && i===0;
      // Por defecto, no duplicar. Reenvío solo cuando lo pide expresamente admin.
      const registrado=!esOriginalNueva &&
        await grants.yaEnviado({compraId:compra.compraId,telefono:numero});
      if(registrado && !reenviar){
        yaEnviados.push(numero);
        continue;
      }
      try {await enviarWhatsApp(numero,mensaje);}
      catch(_){
        fallidos.push(numero);
        if(esOriginalNueva){
          // Si falla el primer envio no dejar una nueva compra inutilizable.
          try{await grants.revocar({compraId:compra.compraId});}catch(_){}
          return res.status(503).json({ok:false,error:"ENVIO_INICIAL_NO_CONFIRMADO",fallidos});
        }
        continue; // nunca reintentos automaticos de WhatsApp
      }
      if(!esOriginalNueva && !registrado){
        try{await grants.registrarEnviado({compraId:compra.compraId,telefono:numero});}
        catch(_){inciertos.push(numero);continue;}
      }
      if(registrado)reenviados.push(numero);
      else enviados.push(numero);
    }
    const ok=enviados.length>0||reenviados.length>0||yaEnviados.length>0;
    broadcast({type:"compra_update"});
    return res.status(ok?200:503).json({
      ok,compraId:compra.compraId,cantidad:compra.cantidad,compartida:!compra.nueva,
      enviados,reenviados,yaEnviados,fallidos,inciertos,
      error:ok?null:"ENVIO_NO_CONFIRMADO"
    });
  }catch(error){return resultadoPublico(res,error);}
  finally{envioListaEnCurso=false;}
});
app.post("/api/admin/finalizar-compra",http.adminWrite,async(req,res)=>{
  try {
    // Cerrar y notificar a los participantes reales; no crear nuevas compras.
    const cierre=await grants.finalizarAdmin();
    compradoresWS.notificar({compraId:cierre.compraId,tipo:"cerrada"});
    broadcast({type:"compra_update"});
    const texto=cierre.faltan===0
      ? "✅ *Compra completada.* Todos los productos comprados."
      : "⚠️ *Compra finalizada.*\n\nPendientes:\n"+cierre.pendientes.map(x=>"- "+x).join("\n");
    let notificados=0;
    for(const telefono of cierre.telefonos) {
      try{await enviarWhatsApp(telefono,texto);notificados++;}
      catch(_){console.error("HogarStock: una notificacion de cierre no confirmada.");}
    }
    res.json({ok:true,faltan:cierre.faltan,notificados,
      destinatarios:cierre.telefonos.length});
  }catch(error){resultadoPublico(res,error);}
});
app.post("/api/admin/revocar-compra",http.adminWrite,async(req,res)=>{
  try {
    const revocada=await grants.revocar({compraId:req.body?.compraId});
    if(revocada){compradoresWS.notificar({compraId:req.body.compraId,tipo:"cerrada"});broadcast({type:"compra_update"});}
    res.json({ok:true,revocada});
  }catch(error){resultadoPublico(res,error);}
});
app.get("/api/comprador/lista",http.comprador,async(req,res)=>{
  try {
    const productos=await grants.listar({grant:req.hsCompra});
    res.setHeader("Cache-Control","no-store");
    res.json({productos});
  }catch(error){resultadoPublico(res,error);}
});
app.post("/api/comprado/:id",http.compradorWrite,async(req,res)=>{
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:"ID_INVALIDO"});
    const resultado=await grants.marcar({grant:req.hsCompra,productoId:id});
    const lista=await grants.listar({grant:req.hsCompra});
    const actualizados=await db.execute("SELECT id,nombre,categoria,agotado FROM productos ORDER BY categoria,nombre");
    broadcast({type:"update",productos:actualizados.rows});
    compradoresWS.notificar({compraId:req.hsCompra.idCompra});
    res.json({ok:true,yaRegistrado:resultado.yaRegistrado,
      faltan:lista.filter(x=>x.agotado).length});
  }catch(error){resultadoPublico(res,error);}
});
app.post("/api/finalizar-compra",http.compradorWrite,async(req,res)=>{
  try {
    const cierre=await grants.finalizar({grant:req.hsCompra});
    compradoresWS.notificar({compraId:req.hsCompra.idCompra,tipo:"cerrada"});
    broadcast({type:"compra_update"});
    const texto=cierre.faltan===0
      ? "✅ *Compra completada.* Todos los productos comprados."
      : "⚠️ *Compra finalizada.*\n\nPendientes:\n"+cierre.pendientes.map(x=>"- "+x).join("\n");
    const destinatarios=cierre.telefonos||[cierre.telefono];
    let enviadas=0;
    for(const numero of destinatarios){
      try{await enviarWhatsApp(numero,texto);enviadas++;}
      catch(_){console.error("HogarStock: una notificacion de cierre no confirmada.");}
    }
    // La compra se cierra para TODOS; sin mensajes automáticos duplicados.
    res.json({ok:true,faltan:cierre.faltan,
      enviada:enviadas===destinatarios.length,
      notificados:enviadas,destinatarios:destinatarios.length});
  }catch(error){resultadoPublico(res,error);}
});

(async () => {
  try {
    const soloLaboratorio=process.env.HS_V2_LAB_NO_WHATSAPP === "1";
    if (soloLaboratorio && (process.env.NODE_ENV !== "test" ||
      process.env.PUBLIC_BASE_URL !== "https://hogarstock.test.invalid")) {
      throw Error("HS_V2_LAB_REQUIERE_ORIGEN_FICTICIO");
    }
    // Validar ANTES de crear tablas en la base remota; no hacer fallback
    // silencioso a la carpeta de credenciales efímeras de Render Free.
    if (!soloLaboratorio && (process.env.HS_WA_AUTH_STORAGE !== "turso" ||
      !/^[a-f0-9]{64}$/i.test(process.env.HS_WA_AUTH_ENC_KEY || ""))) {
      throw Error("HS_WA_AUTH_TURSO_CIFRADO_REQUERIDO_ANTES_DE_PRODUCCION");
    }
    await initDB();
    await almacenAdmin.init();
    await grants.init();
    const puerto = process.env.PORT || 3000;
    server.listen(puerto, soloLaboratorio ? "127.0.0.1" : undefined, () => {
      console.log(
        `HogarStock escuchando en el puerto ${puerto}`
      );
    });

    if(!soloLaboratorio) void iniciarWhatsApp();
  } catch (error) {
    console.error(
      "Error fatal al iniciar HogarStock:",
      error
    );
    process.exitCode = 1;
  }
})();
