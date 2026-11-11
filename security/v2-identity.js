"use strict";
// Identidad V2: sesiones administrativas efímeras y tokens de compradores.
 // El hash de administrador puede rotarse a través de Turso; nunca guardar texto claro.
const crypto = require("node:crypto");
const HEX64 = /^[a-f0-9]{64}$/i;
const ES_LAB_LOCAL = process.env.NODE_ENV==="test" &&
  process.env.HS_V2_LAB_NO_WHATSAPP==="1" &&
  /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.PUBLIC_BASE_URL||"");
const COOKIE_NAME = ES_LAB_LOCAL ? "hs_lab_local_admin" : "__Host-hs_v2_admin";
const TTL_MS = 2 * 60 * 60 * 1000;

function parseCookies(header) {
  if (typeof header !== "string" || header.length > 8192) return new Map();
  const map = new Map();
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim();
    if (!map.has(key)) map.set(key, pair.slice(i + 1).trim());
  }
  return map;
}
function safeMacEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" ||
      !/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function adminHash(password, saltHex) {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    throw Error("ADMIN_CLAVE_FUERA_DE_RANGO");
  }
  if (!HEX64.test(saltHex)) throw Error("ADMIN_SALT_INVALIDA");
  return crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 32,
    {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024}).toString("hex");
}
function generarMaterial(password) {
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = adminHash(password, salt);
  return {
    HS_V2_ADMIN_PASSWORD_SALT: salt,
    HS_V2_ADMIN_PASSWORD_HASH: hash,
    HS_V2_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    HS_V2_BUYER_SECRET: crypto.randomBytes(32).toString("hex"),
  };
}
function crearIdentidadV2({entorno, reloj = Date.now, aleatorio = crypto.randomBytes} = {}) {
  const e = entorno || {};
  if (![e.HS_V2_ADMIN_PASSWORD_SALT,e.HS_V2_ADMIN_PASSWORD_HASH,
    e.HS_V2_SESSION_SECRET,e.HS_V2_BUYER_SECRET].every(x=>HEX64.test(x||""))) {
    throw Error("HS_V2_CREDENCIALES_SEGURAS_OBLIGATORIAS");
  }
  if (e.HS_V2_SESSION_SECRET.toLowerCase()===e.HS_V2_BUYER_SECRET.toLowerCase()) {
    throw Error("HS_V2_CLAVES_REUTILIZADAS");
  }
  if (typeof reloj !== "function" || typeof aleatorio !== "function") {
    throw TypeError("HS_V2_GENERADORES_INVALIDOS");
  }
  const adminSecret = Buffer.from(e.HS_V2_SESSION_SECRET, "hex");
  const buyerSecret = Buffer.from(e.HS_V2_BUYER_SECRET, "hex");
  const sesionesActivas = new Map();
  let saltAdmin=e.HS_V2_ADMIN_PASSWORD_SALT;
  let hashAdmin=e.HS_V2_ADMIN_PASSWORD_HASH;
  let revisionAdmin=0;
  function aplicarCredencialesAdmin({salt,hash,revision}={}){
    if(!HEX64.test(salt||"") || !HEX64.test(hash||"") ||
      !Number.isSafeInteger(revision) || revision<1)throw Error("HS_ADMIN_ROTACION_INVALIDA");
    if(revision<revisionAdmin)throw Error("HS_ADMIN_REVISION_OBSOLETA");
    if(revision===revisionAdmin){
      if(salt!==saltAdmin || hash!==hashAdmin)throw Error("HS_ADMIN_REVISION_CONFLICTO");
      return;
    }
    saltAdmin=salt;
    hashAdmin=hash;
    revisionAdmin=revision;
    // Invalida todas las sesiones existentes; no afecta los enlaces de comprador.
    sesionesActivas.clear();
  }
  function obtenerRevisionAdmin(){return revisionAdmin;}
  function revocarTodosAdmin(){sesionesActivas.clear();}
  function sello(secret, payload) {
    return crypto.createHmac("sha256",secret).update(payload).digest("hex");
  }
  function validarPassword(password) {
    // Evita corta-circuito basado en comparación de cadenas.
    if (typeof password !== "string" || password.length<8 || password.length>200) return false;
    const expected=Buffer.from(hashAdmin,"hex");
    const actual=Buffer.from(adminHash(password,saltAdmin),"hex");
    return crypto.timingSafeEqual(actual,expected);
  }
  function emitirAdmin() {
    const exp=reloj()+TTL_MS;
    const nonce=aleatorio(24).toString("hex");
    if (!/^[a-f0-9]{48}$/.test(nonce) || !Number.isSafeInteger(exp)) {
      throw Error("HS_V2_SESION_INDETERMINADA");
    }
    for (const [n,t] of sesionesActivas) {if(t<=reloj()) sesionesActivas.delete(n);}
    if (sesionesActivas.size>=64) throw Error("HS_V2_DEMASIADAS_SESIONES");
    const body=`a1.${exp}.${nonce}`;
    sesionesActivas.set(nonce,exp);
    const cookie=`${body}.${sello(adminSecret,body)}`;
    return Object.freeze({cookie,csrf:sello(adminSecret,`csrf.${body}`),exp});
  }
  function leerAdmin(header) {
    const cookie=parseCookies(header).get(COOKIE_NAME);
    if (!cookie || cookie.length>256) return null;
    const match=/^(a1)\.(\d{13})\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(cookie);
    if (!match) return null;
    const exp=Number(match[2]);
    if (!Number.isSafeInteger(exp) || exp<=reloj()) return null;
    const body=`a1.${match[2]}.${match[3]}`;
    if (!safeMacEqual(sello(adminSecret,body),match[4])) return null;
    if (sesionesActivas.get(match[3])!==exp) return null;
    return Object.freeze({csrf:sello(adminSecret,`csrf.${body}`),exp});
  }
  function revocarAdmin(header) {
    const raw=parseCookies(header).get(COOKIE_NAME);
    const s=leerAdmin(header);
    if(!s||!raw)return false;
    const m=/^a1\.\d{13}\.([a-f0-9]{48})\./.exec(raw);
    return Boolean(m&&sesionesActivas.delete(m[1]));
  }
  const atributosCookie=ES_LAB_LOCAL ?
    "; Path=/; HttpOnly; SameSite=Strict" :
    "; Path=/; Secure; HttpOnly; SameSite=Strict";
  function cookieHeader(value,maxAge=7200) {
    if (typeof value!=="string" || /[;\r\n\s]/.test(value)) throw Error("HS_V2_COOKIE_INVALIDO");
    return `${COOKIE_NAME}=${value}; Max-Age=${maxAge}${atributosCookie}`;
  }
  function borrarCookie(){return `${COOKIE_NAME}=; Max-Age=0${atributosCookie}`;}
  function emitirComprador({idCompra, ttlMs=24*60*60*1000}={}) {
    if (typeof idCompra!=="string" || !/^[a-f0-9]{48}$/.test(idCompra) ||
      !Number.isSafeInteger(ttlMs) || ttlMs<60000 || ttlMs>86400000) {
      throw Error("HS_V2_COMPRA_TOKEN_PARAM_INVALIDO");
    }
    const exp=reloj()+ttlMs;
    const body=`b1.${exp}.${idCompra}`;
    const token=`${body}.${sello(buyerSecret,body)}`;
    return Object.freeze({token,hash:crypto.createHash("sha256").update(token).digest("hex"),exp});
  }
  // Reconstruye un enlace antiguo sin almacenar tokens en texto claro.
  // El hash guardado valida que la invitacion original no fue alterada.
  function recuperarComprador({idCompra, exp, hash}={}) {
    if(typeof idCompra!=="string"||!/^[a-f0-9]{48}$/.test(idCompra)||
       !Number.isSafeInteger(exp)||exp<=reloj()||String(exp).length!==13||
       typeof hash!=="string"||!/^[a-f0-9]{64}$/i.test(hash))
      throw Error("HS_V2_RECUPERAR_GRANT_INVALIDO");
    const body=`b1.${exp}.${idCompra}`;
    const token=`${body}.${sello(buyerSecret,body)}`;
    const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
    if(!safeMacEqual(tokenHash,hash)) throw Error("HS_V2_RECUPERAR_GRANT_NO_COINCIDE");
    return Object.freeze({token,hash:tokenHash,exp});
  }
  function leerComprador(header) {
    if (typeof header!=="string" || header.length>256 || !header.startsWith("Bearer "))return null;
    const token=header.slice(7);
    const parts=/^b1\.(\d{13})\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(token);
    if(!parts || Number(parts[1])<=reloj())return null;
    const body=`b1.${parts[1]}.${parts[2]}`;
    if(!safeMacEqual(sello(buyerSecret,body),parts[3]))return null;
    return Object.freeze({hash:crypto.createHash("sha256").update(token).digest("hex"),idCompra:parts[2],exp:Number(parts[1])});
  }
  return Object.freeze({validarPassword,aplicarCredencialesAdmin,obtenerRevisionAdmin,
    revocarTodosAdmin,emitirAdmin,leerAdmin,revocarAdmin,cookieHeader,borrarCookie,
    emitirComprador,recuperarComprador,leerComprador});
}
module.exports={crearIdentidadV2,adminHash,generarMaterial,safeMacEqual,
  COOKIE_NAME,parseCookies};
