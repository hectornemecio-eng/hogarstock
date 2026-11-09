"use strict";
const {safeMacEqual}=require("./v2-identity");
function crearHTTPV2({identidad, origen, reloj=Date.now}={}) {
  if (!identidad || typeof identidad.leerAdmin!=="function" ||
      typeof identidad.leerComprador!=="function" ||
      typeof identidad.validarPassword!=="function") {
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
  function admin(req,res,next) {
    const s=identidad.leerAdmin(req.headers?.cookie);
    if(!s) return json(res,401,{error:"ADMIN_NO_AUTORIZADO"});
    req.hsAdmin=s;
    return next();
  }
  function adminWrite(req,res,next) {
    const s=identidad.leerAdmin(req.headers?.cookie);
    if(!s)return json(res,401,{error:"ADMIN_NO_AUTORIZADO"});
    if(!sameOrigin(req) || !safeMacEqual(String(req.headers?.["x-hs-csrf"]||""),s.csrf)) {
      return json(res,403,{error:"ADMIN_CSRF_BLOQUEADO"});
    }
    req.hsAdmin=s;
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
  function estadoAdmin(req,res) {
    const s=identidad.leerAdmin(req.headers?.cookie);
    if(!s)return json(res,401,{autenticado:false});
    return json(res,200,{autenticado:true,csrf:s.csrf,exp:s.exp});
  }
  function login(req,res) {
    if(!sameOrigin(req))return json(res,403,{error:"ADMIN_ORIGEN_BLOQUEADO"});
    const ip=String(req.socket?.remoteAddress||"desconocido").slice(0,120);
    const now=reloj();
    let b=fallos.get(ip)||{first:now,n:0};
    if(now-b.first>15*60*1000){b={first:now,n:0};fallos.delete(ip);}
    if(b.n>=5)return json(res,429,{error:"ADMIN_ACCESO_TEMPORALMENTE_LIMITADO"});
    const pw=req.body?.password;
    if(typeof pw!=="string" || !identidad.validarPassword(pw)){
      b.n++;fallos.set(ip,b);
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
