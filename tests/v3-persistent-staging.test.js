"use strict";

// Ensayos con SQLite ficticia, loopback, sin contactos con Turso ni WhatsApp.
// Las carpetas se conservan hasta que finalice Node; CI las descarta al salir.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const {
  validarRuta, abrirPersistencia, crearRespaldo,
  restaurarEnDirectorioNuevo, leerMarca,
} = require("../integration/v3-staging-persistence.js");
const {
  validarStagingPersistente, iniciarStagingPersistente,
} = require("../integration/v3-persistent-staging-entrypoint.js");

function carpeta() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-v3persist-"));
}
const hmac = "f".repeat(64);
function entorno(dir) {
  return {
    HOGARSTOCK_V3_STAGING: "1",
    HOGARSTOCK_V3_STAGING_ORIGIN: "https://hogarstock-v3-stage.invalid",
    HOGARSTOCK_V3_STAGING_PASSWORD: "CLAVE-FICTICIA-V3-NO-PRODUCCION-2026!",
    HOGARSTOCK_V3_STAGING_HMAC_HEX: hmac,
    HOGARSTOCK_V3_STAGING_PERSIST_DIR: dir,
  };
}

test("Proteccion: sin ruta absoluta, raiz o enlace simbolico no opera", () => {
  assert.throws(() => validarRuta("data"), /RUTA_ABSOLUTA_REQUERIDA/);
  assert.throws(() => validarRuta(path.parse(process.cwd()).root),
    /RAIZ_PROHIBIDA/);
  assert.throws(() => validarRuta(path.join(__dirname, "..", "carpeta-staging")),
    /DENTRO_REPOSITORIO/);
});
test("Proteccion: no se abre staging con credenciales remotas o WhatsApp", async () => {
  const destino = path.join(carpeta(), "sin-crear");
  for (const extra of [
    {TURSO_DATABASE_URL:"libsql://produccion.turso.io"},
    {TURSO_AUTH_TOKEN:"TOKEN_REAL_NO_DEFINIDO"},
    {WA_MASTER_KEY:"CLAVE_NO_USAR"},
    {HOGARSTOCK_V3_WHATSAPP_LIVE:"1"},
    {HOGARSTOCK_V3_STAGING_PUBLIC:"S"},
  ]) {
    await assert.rejects(iniciarStagingPersistente({
      entorno: {...entorno(destino), ...extra},
    }));
    assert.equal(fs.existsSync(destino), false);
  }
});
test("Proteccion: HMAC explicita y origen de staging obligatorios", () => {
  assert.throws(() => validarStagingPersistente({
    ...entorno(path.join(carpeta(),"stage")),
    HOGARSTOCK_V3_STAGING_HMAC_HEX:"",
  }), /HMAC_REQUERIDA/);
  assert.throws(() => validarStagingPersistente({
    ...entorno(path.join(carpeta(),"stage")),
    HOGARSTOCK_V3_STAGING_ORIGIN:"https://hogarstock.onrender.com",
  }), /V3_STAGING_ORIGEN_INVALIDO/);
});
test("Proteccion: carpeta ajena o SQLite sin marca no se toca", async () => {
  const dir = path.join(carpeta(), "stage");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,"archivo-previo.txt"),"CONSERVAR");
  await assert.rejects(abrirPersistencia(dir), /DIRECTORIO_AJENO/);
  assert.equal(fs.readFileSync(path.join(dir,"archivo-previo.txt"),"utf8"),"CONSERVAR");
  assert.equal(fs.readdirSync(dir).length,1);
});
test("Persistencia: datos y esquema sobreviven cierre y nueva conexion", async () => {
  const dir = path.join(carpeta(), "stage");
  const primero = await abrirPersistencia(dir);
  assert.equal(primero.nuevo, true);
  assert.ok(leerMarca(dir).id);
  await primero.cliente.execute("UPDATE productos SET nombre='Leche MODIFICADA FICTICIA' WHERE id=1");
  await primero.cliente.close();
  const segundo = await abrirPersistencia(dir);
  assert.equal(segundo.nuevo, false);
  const r = await segundo.cliente.execute("SELECT nombre FROM productos WHERE id=1");
  assert.equal(String(r.rows[0].nombre),"Leche MODIFICADA FICTICIA");
  assert.equal(Number((await segundo.cliente.execute("SELECT COUNT(*) AS n FROM productos")).rows[0].n),3);
  await segundo.cliente.close();
});
test("Respaldo: VACUUM INTO, SHA256 y restauracion independiente sin sobrescribir", async () => {
  const root=carpeta(), dir=path.join(root,"origen"), destino=path.join(root,"recuperada");
  const estado = await abrirPersistencia(dir);
  await estado.cliente.execute("UPDATE productos SET nombre='RECUPERABLE FICTICIO' WHERE id=2");
  const b = await crearRespaldo({directorio:dir,cliente:estado.cliente});
  assert.match(b.sha256,/^[a-f0-9]{64}$/);
  await estado.cliente.close();
  const r = restaurarEnDirectorioNuevo({
    origen:dir, archivo:b.archivo, sha256Esperado:b.sha256, destino,
  });
  assert.equal(r.sha256,b.sha256);
  assert.equal(leerMarca(destino).restauradoDesdeSha256,b.sha256);
  const recuperada=await abrirPersistencia(destino);
  assert.equal(recuperada.nuevo,false);
  const datos=await recuperada.cliente.execute("SELECT nombre FROM productos WHERE id=2");
  assert.equal(String(datos.rows[0].nombre),"RECUPERABLE FICTICIO");
  await recuperada.cliente.close();
  assert.throws(() => restaurarEnDirectorioNuevo({
    origen:dir,archivo:b.archivo,sha256Esperado:b.sha256,destino,
  }), /DESTINO_EXISTENTE/);
  assert.throws(() => restaurarEnDirectorioNuevo({
    origen:dir,archivo:b.archivo,sha256Esperado:"0".repeat(64),
    destino:path.join(root,"no-creada"),
  }), /INTEGRIDAD_INVALIDA/);
});
test("Restauracion: nunca escribir dentro del origen ni sobre el propio origen", async () => {
  const root=carpeta(), dir=path.join(root,"stage");
  const a=await abrirPersistencia(dir);
  const b=await crearRespaldo({directorio:dir,cliente:a.cliente});
  await a.cliente.close();
  assert.throws(() => restaurarEnDirectorioNuevo({
    origen:dir,archivo:b.archivo,sha256Esperado:b.sha256,
    destino:path.join(dir,"reemplazo"),
  }), /DESTINO_SOLAPADO/);
  assert.throws(() => restaurarEnDirectorioNuevo({
    origen:dir,archivo:"../exfiltrar.sqlite",
    sha256Esperado:b.sha256,destino:path.join(root,"x"),
  }), /ARCHIVO_INVALIDO/);
});
test("HTTP staging persistente: arranque, login, respaldo y segundo arranque", async () => {
  const dir=path.join(carpeta(),"stage");
  const cfg=entorno(dir);
  const uno=await iniciarStagingPersistente({entorno:cfg});
  assert.equal(uno.nuevo,true);
  assert.equal(uno.host,"127.0.0.1");
  const base="http://127.0.0.1:"+uno.puerto;
  assert.equal((await (await fetch(base+"/health")).json()).version,3);
  assert.equal((await fetch(base+"/api/productos")).status,410);
  assert.equal((await fetch(base+"/api/v3/admin/productos")).status,401);
  const login=await fetch(base+"/api/v3/auth/login",{
    method:"POST",headers:{"Origin":cfg.HOGARSTOCK_V3_STAGING_ORIGIN,
      "Content-Type":"application/json"},
    body:JSON.stringify({contrasena:cfg.HOGARSTOCK_V3_STAGING_PASSWORD}),
  });
  assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("hs_admin_v3="));
  const antes=await fetch(base+"/api/v3/admin/productos",{headers:{Cookie:cookie}});
  assert.equal(antes.status,200);
  assert.equal((await antes.json()).productos.length,3);
  const respaldo=await uno.respaldo();
  assert.ok(fs.existsSync(respaldo.ruta));
  await uno.cerrar();
  const dos=await iniciarStagingPersistente({entorno:cfg});
  assert.equal(dos.nuevo,false);
  const salud=await fetch("http://127.0.0.1:"+dos.puerto+"/health");
  assert.equal(salud.status,200);
  await dos.cerrar();
});
