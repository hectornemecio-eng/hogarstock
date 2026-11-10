"use strict";
const {safeMacEqual}=require("./v2-identity");
function crearHTTPV2({identidad, almacenAdmin, origen, reloj=Date.now}={}) {
  if (!identidad || typeof identidad.leerAdmin!=="function" ||
      typeof identidad.leerComprador!=="function" ||
      typeof identidad.validarPassword!=="function" ||
      typeof almacenAdmin?.sincronizar!=="function") {
    throw Error("HS_V2_HTTP_IDENTIDAD_INVALIDA");
  }
  let url;
  try {url=new URL(origen);}catch(_){throw Error("HS_V2_ORIGEN_INVALIDO");}
  if (url.protocol!=="https:" || url.origin!==origen || url.hostname!=="hogarstock.onrender.com") {
    // Este parche es EXCLUSIVAMENTE para V2 Render; los ensayos HTTP deben
    // inyectar el origen ficticio https://hogarstock.test.invalid.
    if (url.protocol!=="https:" || url.origin!==origen ||
        url.hostname!=="hogarstock.test.invalid")throw Error("HS_V2_ORIGEN_INVALIDO");
  }
  const fallos = new Map();
  function json(res,code,data) {
    res.setHeader("Cache-Control","no-store");
    return res.status(code).json(data);
  }
  function sameOrigin(req) {
    return req.headers?.origin===origen;
  }
  async function admin(req,res,next) {
    try{await almacenAdmin.sincronizar();}
    catch(_){return json(res,503,{error:"ADMIN_ALMACEN_NO_DISPONIBLE"});}
    const sesion=identidad.leerAdmin(req.headers?.cookie);
    if(!sesion)return json(res,401,{error:"ADMIN_NO_AUTORIZADO"});
    req.hsAdmin=sesion;
    return next();
  }
  async function adminWrite(req,res,next) {
    try{await almacenAdmin.sincronizar();}
    catch(_){return json(res,503,{error:"ADMIN_ALMACEN_NO_DISPONIBLE"});}
    const sesion=identidad.leerAdmin(req.headers?.cookie);
    if(!sesion)return json(res,401,{error:"ADMIN_NO_AUTORIZADO"});
    if(!sameOrigin(req) || !safeMacEqual(String(req.headers?.["x-hs-csrf"]||""),sesion.csrf))
      return json(res,403,{error:"ADMIN_CSRF_BLOQUEADO"});
    req.hsAdmin=sesion;
    return next();
  }
  function comprador(req,res,next) {
    const token=identidad.leerComprador(req.headers?.authorization);
    if(!token)return json(res,401,{error:"COMPRADOR_NO_AUTORIZADO"});
    req.hsCompra=token;
    return next();
  }
  function compradorWrite(req,res,next) {
    if (!sameOrigin(req))return json(res,403,{error:"COMPRADOR_ORIGEN_BLOQUEADO"});
    return comprador(req,res,next);
  }
  async function estadoAdmin(req,res) {
    try{await almacenAdmin.sincronizar();}
    catch(_){return json(res,503,{error:"ADMIN_ALMACEN_NO_DISPONIBLE"});}
    const sesion=identidad.leerAdmin(req.headers?.cookie);
    if(!sesion)return json(res,401,{autenticado:false});
    return json(res,200,{autenticado:true,csrf:sesion.csrf,exp:sesion.exp});
  }
  async function login(req,res) {
    if(!sameOrigin(req))return json(res,403,{error:"ADMIN_ORIGEN_BLOQUEADO"});
    const ip=String(req.socket?.remoteAddress||"desconocido").slice(0,120);
    const ahora=reloj();
    let fallosIp=fallos.get(ip)||{first:ahora,n:0};
    if(ahora-fallosIp.first>15*60*1000){
      fallosIp={first:ahora,n:0};fallos.delete(ip);
    }
    if(fallosIp.n>=5)return json(res,429,{error:"ADMIN_ACCESO_TEMPORALMENTE_LIMITADO"});
    try{await almacenAdmin.sincronizar();}
    catch(_){return json(res,503,{error:"ADMIN_ALMACEN_NO_DISPONIBLE"});}
    const clave=req.body?.password;
    if(typeof clave!=="string" || !identidad.validarPassword(clave)){
      fallosIp.n++;fallos.set(ip,fallosIp);
      return json(res,401,{error:"ADMIN_CREDENCIALES_INVALIDAS"});
    }
    fallos.delete(ip);
    const token=identidad.emitirAdmin();
    res.setHeader("Set-Cookie",identidad.cookieHeader(token.cookie));
    return json(res,200,{ok:true,csrf:token.csrf,exp:token.exp});
  }
  function logout(req,res) {
    const s=identidad.leerAdmin(req.headers?.cookie);
    if(!s || !sameOrigin(req) ||
      !safeMacEqual(String(req.headers?.["x-hs-csrf"]||""),s.csrf)) {
      return json(res,403,{error:"ADMIN_CSRF_BLOQUEADO"});
    }
    identidad.revocarAdmin(req.headers?.cookie);
    res.setHeader("Set-Cookie",identidad.borrarCookie());
    return json(res,200,{ok:true});
  }
  function websocketAdmin(req) {
    return req.headers?.origin===origen &&
      Boolean(identidad.leerAdmin(req.headers?.cookie)) &&
      (()=>{try{return new URL(req.url,"https://host.invalid").pathname==="/ws"}catch(_){return false}})();
  }
  return Object.freeze({admin,adminWrite,comprador,compradorWrite,
    estadoAdmin,login,logout,websocketAdmin,sameOrigin});
}
module.exports={crearHTTPV2};
