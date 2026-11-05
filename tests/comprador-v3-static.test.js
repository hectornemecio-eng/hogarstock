"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const pagina = readFileSync(join(__dirname, "../public/comprador-v3.html"), "utf8");
test("Comprador V3: invitacion desde fragmento y limpieza inmediata del URL", () => {
  assert.match(pagina, /location\.hash/);
  assert.match(pagina, /history\.replaceState/);
  assert.ok(pagina.includes('fragmento.get("invitacion")'));
  assert.match(pagina, /\/activar/);
});
test("Comprador V3: usa cookie same-origin sin guardar tokens localmente", () => {
  assert.match(pagina, /credentials:\s*"same-origin"/);
  assert.doesNotMatch(pagina, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(pagina, /\bBearer\b/);
});
test("Comprador V3: texto de base de datos insertado como texto, no HTML", () => {
  assert.match(pagina, /\.textContent/);
  assert.match(pagina, /document\.createElement/);
  assert.doesNotMatch(pagina, /\binnerHTML\b|\bouterHTML\b/);
});
test("Comprador V3: permite marcar, deshacer, finalizar, actualizar y salir", () => {
  for(const ruta of ["/items/", "/finalizar", "/salir"]) {
    assert.ok(pagina.includes(ruta));
  }
  assert.match(pagina, /revisionEsperada/);
  assert.match(pagina, /confirm\(/);
  assert.match(pagina, /"recargar"/);
});
