"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const {createClient}=require("@libsql/client");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const {crearAlmacenClaveAdmin}=require("../security/v2-password-store");
const {crearHTTPV2}=require("../security/v2-http");

async function entornoPrueba(run){
  const ruta=path.join(os.tmpdir(),"hs_pw_v402_"+process.pid+"_"+Date.now()+"_"+Math.floor(Math.random()*1e6)+".db");
  const db=createClient({url:"file:"+ruta});
  const inicial="clave-inicial-de-prueba-muy-larga";
  const credenciales=generarMaterial(inicial);
  try{
    await db.execute("CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT,agotado INTEGER)");
    await db.execute({sql:"INSERT INTO productos VALUES (?,?,?)",args:[1,"Pera",1]});
    const identidad=crearIdentidadV2({entorno:credenciales});
    const store=crearAlmacenClaveAdmin({db,identidad,entorno:credenciales});
    await store.init();
    await run({db,identidad,store,credenciales,inicial});
  }finally{
    db.close();
    try{fs.unlinkSync(ruta)}catch(_){}
    try{fs.unlinkSync(ruta+"-wal")}catch(_){}
    try{fs.unlinkSync(ruta+"-shm")}catch(_){}
  }
}
test("Cambia clave en Turso ficticio con 8 caracteres; persiste, sin texto claro y sin afectar inventario",async()=>{
  await entornoPrueba(async({db,identidad,store,credenciales,inicial})=>{
    assert.equal(identidad.validarPassword(inicial),true);
    const sesion=identidad.emitirAdmin();
    const cabecera="__Host-hs_v2_admin="+sesion.cookie;
    assert(identidad.leerAdmin(cabecera));
    await assert.rejects(store.cambiar({actual:inicial,nueva:"1234567"}),/HS_ADMIN_CLAVE_NUEVA_LONGITUD/);
    await assert.rejects(store.cambiar({actual:"clave-invalida-ficticia",nueva:"8cifras!!"}),/HS_ADMIN_CLAVE_ACTUAL_INCORRECTA/);
    assert.equal(identidad.validarPassword(inicial),true);
    await store.cambiar({actual:inicial,nueva:"8cifras!"});
    assert.equal(identidad.validarPassword(inicial),false);
    assert.equal(identidad.validarPassword("8cifras!"),true);
    assert.equal(identidad.leerAdmin(cabecera),null,"sesión anterior debe ser inválida");
    const r=await db.execute("SELECT salt,hash,revision FROM hs_v2_admin_password WHERE id=1");
    assert.equal(r.rows.length,1);
    assert.equal(Number(r.rows[0].revision),1);
    assert.match(String(r.rows[0].hash),/^[a-f0-9]{64}$/);
    assert.match(String(r.rows[0].salt),/^[a-f0-9]{64}$/);
    assert.notEqual(String(r.rows[0].hash),"8cifras!");
    const user2=crearIdentidadV2({entorno:credenciales});
    const store2=crearAlmacenClaveAdmin({db,identidad:user2,entorno:credenciales});
    await store2.init();
    assert.equal(user2.validarPassword("8cifras!"),true);
    assert.equal(user2.validarPassword(inicial),false);
    await assert.rejects(store2.cambiar({actual:"8cifras!",nueva:"8cifras!"}),/HS_ADMIN_CLAVE_SIN_CAMBIOS/);
    await store2.cambiar({actual:"8cifras!",nueva:"otra-clave-9"});
    assert.equal(user2.validarPassword("otra-clave-9"),true);
    const ver=await db.execute("SELECT revision FROM hs_v2_admin_password WHERE id=1");
    assert.equal(Number(ver.rows[0].revision),2);
    // Simular que una instancia antigua comprueba la versión en otra petición.
    await store.sincronizar();
    assert.equal(identidad.validarPassword("8cifras!"),false);
    assert.equal(identidad.validarPassword("otra-clave-9"),true);
    const productos=await db.execute("SELECT nombre,agotado FROM productos");
    assert.equal(productos.rows.length,1);
    assert.equal(productos.rows[0].nombre,"Pera");
    assert.equal(Number(productos.rows[0].agotado),1);
  });
});
test("Login, CSRF y sesiones: no se puede usar contraseña anterior tras el cambio",async()=>{
  await entornoPrueba(async({db,identidad,store,credenciales,inicial})=>{
    const origen="https://hogarstock.test.invalid";
    const http=crearHTTPV2({identidad,almacenAdmin:store,origen});
    function response(){
      return {code:200,body:null,headers:{},
        setHeader(k,v){this.headers[k]=v},
        status(c){this.code=c;return this},
        json(d){this.body=d;return this}
      };
    }
    const req={headers:{origin:origen},socket:{remoteAddress:"127.0.0.1"},
      body:{password:inicial}};
    let res=response();await http.login(req,res);
    assert.equal(res.code,200);
    const cookie=res.headers["Set-Cookie"].split(";")[0];
    const csrf=res.body.csrf;
    let called=false;
    res=response();await http.adminWrite({
      headers:{origin:origen,cookie,"x-hs-csrf":csrf}
    },res,()=>{called=true});
    assert.equal(called,true);
    await store.cambiar({actual:inicial,nueva:"12345678"});
    called=false;
    res=response();await http.adminWrite({
      headers:{origin:origen,cookie,"x-hs-csrf":csrf}
    },res,()=>{called=true});
    assert.equal(res.code,401);
    assert.equal(called,false);
    req.body.password=inicial;
    res=response();await http.login(req,res);
    assert.equal(res.code,401);
    req.body.password="12345678";
    res=response();await http.login(req,res);
    assert.equal(res.code,200);
    assert(res.headers["Set-Cookie"]);
    const cookieNueva=res.headers["Set-Cookie"].split(";")[0];
    const csrfNuevo=res.body.csrf;
    assert.notEqual(cookieNueva,cookie);
    res=response();await http.adminWrite({
      headers:{origin:"https://sitio-no-autorizado.invalid",
        cookie:cookieNueva,"x-hs-csrf":csrfNuevo}
    },res,()=>{called=true});
    assert.equal(res.code,403);
    assert.equal(called,false);
    // Corroborar persistencia en otro proceso ficticio.
    const nuevoProceso=crearIdentidadV2({entorno:credenciales});
    const nuevoStore=crearAlmacenClaveAdmin({db,identidad:nuevoProceso,entorno:credenciales});
    await nuevoStore.init();
    const nuevaHttp=crearHTTPV2({identidad:nuevoProceso,almacenAdmin:nuevoStore,origen});
    req.body.password="12345678";
    res=response();await nuevaHttp.login(req,res);
    assert.equal(res.code,200);
  });
});
test("Protección de errores de persistencia: nunca usar fallback si ya se rotó la clave",async()=>{
  await entornoPrueba(async({db,identidad,store,inicial})=>{
    await store.cambiar({actual:inicial,nueva:"claveCorta8"});
    await db.execute("DELETE FROM hs_v2_admin_password WHERE id=1");
    await assert.rejects(store.sincronizar(),/HS_ADMIN_CREDENCIALES_NO_DISPONIBLES/);
    assert.equal(identidad.validarPassword(inicial),false);
  });
});
test("UI: formulario de cambio disponible, contraseña corta aceptada y protección CSRF preservada",()=>{
  const admin=fs.readFileSync("public/index.html","utf8");
  const login=fs.readFileSync("public/admin-login.html","utf8");
  const server=fs.readFileSync("server.js","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  assert(admin.includes('id="formCambiarClave"'));
  for(const id of ["claveActual","claveNueva","claveConfirmar","btnCambiarClave","estadoClave"])
    assert(admin.includes('id="'+id+'"'));
  assert(admin.includes('fetch("/api/admin/cambiar-clave"'));
  assert(admin.includes('body:JSON.stringify({actual:valorActual,nueva:valorNuevo})'));
  assert(admin.includes('location.replace("/admin-login.html")'));
  assert(login.includes('required minlength="8" maxlength="200"'));
  assert(!login.includes('required minlength="12"'));
  assert(server.includes('app.post("/api/admin/cambiar-clave",http.adminWrite'));
  assert(server.includes("await almacenAdmin.init()"));
  assert(server.includes("res.setHeader(\"Set-Cookie\",identidad.borrarCookie())"));
  assert(css.includes(".page-admin .password-panel"));
  for(const file of [admin,login]){
    const scripts=[...file.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    for(const match of scripts)if(match[1].trim())new vm.Script(match[1]);
  }
  assert(!server.includes("console.log(req.body?.nueva"));
});
