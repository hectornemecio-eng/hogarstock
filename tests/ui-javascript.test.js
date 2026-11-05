"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
for (const pagina of ["admin-v3.html", "comprador-v3.html"]) {
  test("JavaScript embebido sintacticamente valido: " + pagina, () => {
    const html = readFileSync(join(__dirname, "../public", pagina), "utf8");
    const bloques = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.equal(bloques.length, 1);
    assert.doesNotThrow(() => new vm.Script(bloques[0][1], { filename: pagina }));
  });
}
