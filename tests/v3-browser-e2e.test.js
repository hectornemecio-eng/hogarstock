"use strict";

// Pruebas reales de navegador contra HTTPS 127.0.0.1, SQLite temporal,
// sin servicios externos, Turso, Baileys ni datos personales.
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { crearServidorAislado, CLAVE_DEMO } = require("../integration/v3-sandbox-server.js");

async function entorno(t) {
  const server = await crearServidorAislado({
    certPath: process.env.HOGARSTOCK_SANDBOX_CERT,
    keyPath: process.env.HOGARSTOCK_SANDBOX_KEY,
  });
  t.after(() => server.cerrar());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const admin = await browser.newContext({ ignoreHTTPSErrors: true });
  t.after(() => admin.close());
  const comprador = await browser.newContext({ ignoreHTTPSErrors: true });
  t.after(() => comprador.close());
  return { ...server, browser, admin, comprador };
}

async function iniciarAdmin(page, origen) {
  await page.goto(origen + "/admin-v3.html");
  await page.locator("#password").fill(CLAVE_DEMO);
  await page.locator("#loginButton").click();
  await page.locator("#appPanel").waitFor({ state: "visible" });
  await page.getByText("Sesión administrativa iniciada.").waitFor();
}

test("Navegador HTTPS: compra completa entre administrador y comprador aislados", async (t) => {
  const e = await entorno(t);
  const admin = await e.admin.newPage();
  await iniciarAdmin(admin, e.origen);

  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator('#missingSelection input[type="checkbox"]').first().check();
  await admin.locator("#createPurchase").click();
  await admin.locator("#detail").waitFor({ state: "visible" });
  const encabezado = await admin.locator("#detailTitle").innerText();
  const match = /Compra #([1-9][0-9]*)/.exec(encabezado);
  assert.ok(match, "Se debe crear una compra con ID");
  const id = Number(match[1]);
  assert.ok(id > 0);

  admin.once("dialog", (dialog) => dialog.accept());
  await admin.locator("#createInvitation").click();
  await admin.locator("#invitationArea").waitFor({ state: "visible" });
  const enlace = await admin.locator("#invitationLink").inputValue();
  // El enlace es un secreto efimero; nunca imprimirlo en logs.
  assert.ok(enlace.startsWith(e.origen + "/comprador-v3.html?compra=" + id + "#invitacion="));

  const comprador = await e.comprador.newPage();
  await comprador.goto(enlace);
  await comprador.getByText("Lista disponible.").waitFor();
  assert.equal(await comprador.evaluate(() => location.hash), "");
  assert.equal(await comprador.locator("#estadoGlobal").innerText(), "En curso");
  assert.equal(await comprador.locator("#lista li").count(), 1);
  const combo = comprador.locator("#lista select").first();
  await combo.selectOption("comprado");
  await comprador.getByText("Cambio guardado.").waitFor();
  assert.match(await comprador.locator("#contador").innerText(), /1\s*\/\s*1/);

  comprador.once("dialog", (dialog) => dialog.accept());
  await comprador.locator("#finalizar").click();
  await comprador.getByText("Compra finalizada y registrada.").waitFor();
  assert.equal(await comprador.locator("#estadoGlobal").innerText(), "Finalizada");

  await admin.locator("#refreshPurchases").click();
  await admin.locator("#purchaseRows button").first().click();
  await admin.locator("#showReconciliation").click();
  await admin.getByText("Informe consultado. No se ha modificado el inventario.").waitFor();
  assert.ok((await admin.locator("#reconciliation").innerText()).includes("REVISION_ADMINISTRADOR"));

  const productos = await e.cliente.execute("SELECT nombre,agotado FROM productos ORDER BY id");
  assert.equal(productos.rows.length, 3);
  assert.ok(productos.rows.some((fila) => Number(fila.agotado) === 1));
});

test("Navegador HTTPS: invitacion usada no abre una segunda sesion", async (t) => {
  const e = await entorno(t);
  const admin = await e.admin.newPage();
  await iniciarAdmin(admin, e.origen);
  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator('#missingSelection input[type="checkbox"]').first().check();
  await admin.locator("#createPurchase").click();
  await admin.locator("#detail").waitFor({ state: "visible" });
  admin.once("dialog", (dialog) => dialog.accept());
  await admin.locator("#createInvitation").click();
  const enlace = await admin.locator("#invitationLink").inputValue();
  const pagina1 = await e.comprador.newPage();
  await pagina1.goto(enlace);
  await pagina1.getByText("Lista disponible.").waitFor();

  const otroContexto = await e.browser.newContext({ ignoreHTTPSErrors: true });
  t.after(() => otroContexto.close());
  const pagina2 = await otroContexto.newPage();
  await pagina2.goto(enlace);
  await pagina2.getByText("Enlace no válido, utilizado o caducado. Solicita una invitación nueva.").waitFor();
  assert.equal(await pagina2.locator("#lista li").count(), 0);
  assert.equal(await pagina2.evaluate(() => location.hash), "");
});

test("Navegador HTTPS: visitante sin cookie no puede administrar y no lee productos", async (t) => {
  const e = await entorno(t);
  const visitante = await e.comprador.newPage();
  await visitante.goto(e.origen + "/admin-v3.html");
  await visitante.locator("#loginPanel").waitFor({ state: "visible" });
  assert.equal(await visitante.locator("#appPanel").isVisible(), false);
  const respuesta = await visitante.evaluate(async () => {
    const r = await fetch("/api/v3/admin/productos", { cache: "no-store" });
    return { status: r.status, data: await r.json() };
  });
  assert.equal(respuesta.status, 401);
  assert.equal("productos" in respuesta.data, false);
});
