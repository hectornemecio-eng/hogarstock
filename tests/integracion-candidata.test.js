"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const dir = path.join(__dirname, "../integration");
const original = Module._load;
const registro = [];
const servicios = Object.create(null);
function constructor(nombre, metodos) {
  return (...args) => {
    registro.push("crear:"+nombre);
    const obj = {};
    for (const metodo of metodos) obj[metodo] = async () => { registro.push(nombre+"."+metodo); };
    servicios[nombre] = obj;
    return obj;
  };
}
const factories = {
  "../security/access.js": {crearServicioAcceso: constructor("acceso",[])},
  "../security/store.js": {crearAlmacenSeguridad: constructor("seguridad",["init"])},
  "../security/admin-credentials.js": {crearCredencialesAdmin: constructor("credenciales",["init"])},
  "../security/buyer-sessions.js": {crearSesionesComprador: constructor("sesiones",["init"])},
  "../catalogo/store.js": {crearCatalogoV3: constructor("catalogo",[])},
  "../compras/store.js": {crearAlmacenCompras: constructor("compras",["init"])},
  "../compras/conciliacion.js": {crearConciliadorCompras: constructor("conciliador",[])},
  "../whatsapp/inbox-store.js": {crearBandejaWhatsApp: constructor("bandeja",["init"])},
  "../whatsapp/apply-proposal.js": {crearAplicadorWhatsApp: constructor("aplicador",["init"])},
};
const appMounts = [];
function expressFake() {
  return {
    disable: () => {},
    get: (route) => appMounts.push("GET "+route),
    all: (route) => appMounts.push("ALL "+String(route)),
    use: (route) => appMounts.push("USE "+String(route)),
  };
}
const hash = "scrypt:16384:8:1:"+"a".repeat(32)+":"+"b".repeat(128);
const client = {execute(){},batch(){},transaction(){}};
const options = {cliente:client,hashAdministrador:hash,claveHmacHex:"f".repeat(64),esquemaAuditado:true,escriturasAutorizadas:true};
const fakeRouter = {crearRouterV3: () => {appMounts.push("ROUTER_V3_CREADO");return function router(){};}};
Module._load = function(request,parent,isMain) {
  if (parent && path.dirname(parent.filename) === dir) {
    if (factories[request]) return factories[request];
    if (request === "express") return expressFake;
    if (request === "../api/v3-router.js") return fakeRouter;
  }
  return original.apply(this,arguments);
};
const core = require("../integration/v3-compose-services.js");
const app = require("../integration/v3-production-app.js");
const composition = require("../integration/v3-production-composition.js");
Module._load = original;

test("Falla cerrado sin permiso de escritura", () => {
  assert.throws(()=>core.validarOpciones({...options,escriturasAutorizadas:false}),/NO_AUTORIZADA/);
});
test("Falla cerrado sin hash real valido ni HMAC", () => {
  assert.throws(()=>core.validarOpciones({...options,hashAdministrador:"demo"}),/HASH_ADMIN_INVALIDO/);
  assert.throws(()=>core.validarOpciones({...options,claveHmacHex:"demo"}),/CLAVE_HMAC_INVALIDA/);
});
test("Falla cerrado sin preflight del esquema", () => {
  assert.throws(()=>core.validarOpciones({...options,esquemaAuditado:false}),/NO_AUTORIZADA/);
});
test("Falla cerrado con origen HTTP y no modifica el esquema",async()=>{
  const antes=registro.length;
  await assert.rejects(()=>composition.prepararAplicacionV3({...options,origen:"http://ejemplo.com"}),/ORIGEN_HTTPS_INVALIDO/);
  assert.equal(registro.length,antes);
});
test("Exige esquema verificado antes de construir router",()=>{
  assert.throws(()=>app.crearAplicacionV3Produccion({origen:"https://ejemplo.com"}),/ESQUEMA_NO_VERIFICADO/);
});
test("Inicializa en orden y no abre conexiones ni listeners",async()=>{
  const x=await core.inicializarServiciosV3(options);
  for(const k of ["acceso","compras","catalogo","conciliador","sesionesComprador","bandejaWhatsApp","aplicadorWhatsApp"])
    assert.ok(x[k],"falta "+k);
  const steps=registro.filter(s=>s.includes(".init"));
  assert.deepEqual(steps,["seguridad.init","compras.init","credenciales.init","sesiones.init","bandeja.init","aplicador.init"]);
});
test("No expone rutas V2 y monta solo API V3",()=>{
  appMounts.length=0;
  app.crearAplicacionV3Produccion({
    origen:"https://ejemplo.com",esquemaVerificado:true,
    acceso:{},compras:{},catalogo:{},conciliador:{},
    sesionesComprador:{},bandejaWhatsApp:{},aplicadorWhatsApp:{},
  });
  assert.ok(appMounts.some(v=>v.includes("/api/productos")));
  assert.ok(appMounts.includes("USE /api/v3"));
  assert.ok(appMounts.indexOf("ALL /api/productos") < appMounts.indexOf("USE /api/v3"));
});
test("Módulos fuente no contienen arranque automático ni credenciales demo",()=>{
  const files=["v3-production-app.js","v3-compose-services.js","v3-production-composition.js"];
  for(const file of files) {
    const source=fs.readFileSync(path.join(dir,file),"utf8");
    assert.doesNotMatch(source,/\.listen\s*\(|makeWASocket\s*\(|HogarStock-V3-Clave-FICTICIA/);
  }
});
