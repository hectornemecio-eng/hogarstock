"use strict";
// Suite de protecciones del entrypoint; no abre WhatsApp ni Turso.
const test = require("node:test");
const assert = require("node:assert/strict");
const { validarStaging, iniciarStagingV3 } =
  require("../integration/v3-staging-entrypoint.js");

const base = () => ({
  HOGARSTOCK_V3_STAGING: "1",
  HOGARSTOCK_V3_STAGING_ORIGIN: "https://hogarstock-v3-stage.invalid",
  HOGARSTOCK_V3_STAGING_PASSWORD: "FICTICIA-SOLO-ENSAYOS-2026!",
});

test("Staging no arranca sin habilitacion explicita", () => {
  assert.throws(() => validarStaging({ ...base(), HOGARSTOCK_V3_STAGING: "0" }),
    /V3_STAGING_NO_AUTORIZADO/);
});
test("Staging bloquea credenciales Turso y WhatsApp", () => {
  for (const [clave, valor] of [
    ["TURSO_DATABASE_URL", "libsql://ficticio.turso.io"],
    ["TURSO_AUTH_TOKEN", "TOKEN_FICTICIO"],
    ["HOGARSTOCK_V3_WHATSAPP_LIVE", "1"],
    ["WA_MASTER_KEY", "CLAVE_FICTICIA"],
    ["WA_ALLOWED_NUMBERS", "000"],
    ["HOGARSTOCK_V3_SANDBOX", "1"],
  ]) {
    assert.throws(() => validarStaging({ ...base(), [clave]: valor }),
      /V3_STAGING_ENTORNO_NO_AISLADO/);
  }
});
test("Staging nunca usa origen de produccion ni HTTP", () => {
  for (const origen of [
    "https://hogarstock.onrender.com", "http://hogarstock-v3-stage.invalid",
    "https://hogarstock-v3-stage.invalid/path", "https://otro.invalid",
    "https://hogarstock-v3-stage.invalid?x=1"
  ]) {
    assert.throws(() => validarStaging({
      ...base(), HOGARSTOCK_V3_STAGING_ORIGIN: origen,
    }), /V3_STAGING_ORIGEN_INVALIDO/);
  }
});
test("Publicacion exige habilitacion S y dominio separado", () => {
  assert.throws(() => validarStaging({
    ...base(), HOGARSTOCK_V3_STAGING_PUBLIC: "S",
  }), /V3_STAGING_PUBLICACION_REQUIERE_HOST_SEPARADO/);
  const r = validarStaging({
    ...base(),
    HOGARSTOCK_V3_STAGING_ORIGIN: "https://hogarstock-v3-stage.onrender.com",
    HOGARSTOCK_V3_STAGING_PUBLIC: "S",
    PORT: "8080",
  });
  assert.equal(r.host, "0.0.0.0");
  assert.equal(r.puerto, 8080);
});
test("Por defecto solo 127.0.0.1 y puerto efimero", () => {
  const r = validarStaging(base());
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.puerto, 0);
});
test("Rechaza contrasenas insuficientes y puertos invalidos", () => {
  assert.throws(() => validarStaging({
    ...base(), HOGARSTOCK_V3_STAGING_PASSWORD: "corta",
  }), /V3_STAGING_PASSWORD_INVALIDA/);
  for (const puerto of ["65536", "-1", "abc", "22.1"]) {
    assert.throws(() => validarStaging({
      ...base(), PORT: puerto,
    }), /V3_STAGING_PUERTO_INVALIDO/);
  }
});
test("Staging real: HTTP loopback y datos ficticios, sin redes externas", async t => {
  // Ausencia o cadena vacia son equivalentes; credenciales reales no.
  assert.equal(Boolean(process.env.TURSO_DATABASE_URL), false);
  assert.equal(Boolean(process.env.TURSO_AUTH_TOKEN), false);
  const s = await iniciarStagingV3({ entorno: base() });
  t.after(() => s.cerrar());
  assert.equal(s.host, "127.0.0.1");
  const baseUrl = "http://127.0.0.1:" + s.puerto;
  const health = await fetch(baseUrl + "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, 3);
  assert.equal((await fetch(baseUrl + "/api/productos")).status, 410);
  assert.equal((await fetch(baseUrl + "/api/v3/admin/productos")).status, 401);
  const login = await fetch(baseUrl + "/api/v3/auth/login", {
    method: "POST",
    headers: {
      Origin: "https://hogarstock-v3-stage.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ contrasena: base().HOGARSTOCK_V3_STAGING_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("hs_admin_v3="));
  const listado = await fetch(baseUrl + "/api/v3/admin/productos", {
    headers: { Cookie: cookie },
  });
  assert.equal(listado.status, 200);
  assert.equal((await listado.json()).productos.length, 3);
});
