"use strict";
// Smoke de la composición V3 auténtica, sin red remota ni secretos reales.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { createClient } = require("@libsql/client");
const { crearHashContrasena } = require("../security/access.js");
const { prepararAplicacionV3 } = require("../integration/v3-production-composition.js");

test("Composición V3 real: arranca en 127.0.0.1, protege catálogo y permite login ficticio", async (t) => {
  assert.notEqual(process.env.HOGARSTOCK_V3_SANDBOX, "1");
  assert.equal(process.env.TURSO_DATABASE_URL, undefined);
  assert.equal(process.env.TURSO_AUTH_TOKEN, undefined);
  const carpeta = mkdtempSync(join(tmpdir(), "hs-v334-smoke-"));
  const cliente = createClient({ url: "file:" + join(carpeta,"smoke.sqlite") });
  t.after(async () => { await cliente.close(); });
  await cliente.batch([
    "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, categoria TEXT NOT NULL, agotado INTEGER DEFAULT 0)",
    "INSERT INTO productos(id,nombre,categoria,agotado) VALUES (1,'Leche ficticia','Prueba',1)"
  ], "write");
  const pass = "SOLO-PRUEBAS-V334-2026-DISTINTA";
  const { app } = await prepararAplicacionV3({
    cliente, origen: "https://hogarstock.invalid",
    hashAdministrador: crearHashContrasena(pass),
    claveHmacHex: randomBytes(32).toString("hex"),
    esquemaAuditado: true, escriturasAutorizadas: true,
  });
  const servidor = await new Promise((resolve,reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error",reject);
  });
  t.after(async () => { await new Promise(resolve => servidor.close(resolve)); });
  const base = "http://127.0.0.1:" + servidor.address().port;
  let r = await fetch(base + "/health");
  assert.equal(r.status,200);
  assert.equal((await r.json()).version,3);
  r = await fetch(base + "/api/productos");
  assert.equal(r.status,410);
  r = await fetch(base + "/api/v3/admin/productos");
  assert.equal(r.status,401);
  r = await fetch(base + "/api/v3/auth/login", {
    method:"POST", headers:{"Origin":"https://hogarstock.invalid","Content-Type":"application/json"},
    body:JSON.stringify({contrasena:pass}),
  });
  assert.equal(r.status,200,"login de prueba");
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie && cookie.startsWith("hs_admin_v3="));
  r = await fetch(base + "/api/v3/admin/productos", { headers:{Cookie:cookie} });
  assert.equal(r.status,200);
  const datos = await r.json();
  assert.equal(datos.productos.length,1);
});
