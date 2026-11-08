"use strict";

// Pruebas reales de navegador contra HTTPS 127.0.0.1, SQLite temporal,
// sin servicios externos, Turso, Baileys ni datos personales.
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { crearServidorAislado, CLAVE_DEMO } = require("../integration/v3-sandbox-server.js");
const { crearAlmacenCompras } = require("../compras/store.js");

async function entorno(t, { habilitarReposicion = false } = {}) {
  const server = await crearServidorAislado({
    certPath: process.env.HOGARSTOCK_SANDBOX_CERT,
    keyPath: process.env.HOGARSTOCK_SANDBOX_KEY,
    habilitarReposicion,
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
  await admin.locator('#missingSelection input[type="checkbox"]').nth(1).check();
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
  assert.equal(await comprador.locator("#compartirPanel").isVisible(),false);
  assert.equal(await comprador.evaluate(() => location.hash), "");
  assert.equal(await comprador.locator("#estadoGlobal").innerText(), "En curso");
  assert.equal(await comprador.locator("#lista li").count(), 2);
  const combo = comprador.locator("#lista select").first();
  await combo.selectOption("comprado");
  await comprador.getByText("Cambio guardado.").waitFor();
  assert.match(await comprador.locator("#contador").innerText(), /1\s*\/\s*2/);

  // Regresión observada en Windows: el listado reflejaba 1/1, pero el
  // detalle de una compra previamente abierta seguía diciendo pendiente.
  assert.match(await admin.locator("#detailBody").innerText(), /0 comprados/);
  await admin.locator("#refreshPurchases").click();
  await admin.getByText("Compras y detalle actualizados.").waitFor();
  assert.match(await admin.locator("#detailBody").innerText(), /1 comprados/);
  assert.match(await admin.locator("#detailBody").innerText(), /1 pendientes/);
  // El refresco no debe hacer desaparecer una invitación activa del panel.
  assert.equal(await admin.locator("#invitationArea").isVisible(), true);

  // El segundo producto se declara no disponible y queda reflejado en
  // la compra antes de finalizarla.
  await comprador.locator("#lista select").nth(1).selectOption("no_disponible");
  await comprador.getByText("Cambio guardado.").waitFor();
  await comprador.getByText("0 pendientes · 1 no disponibles").waitFor();

  comprador.once("dialog", (dialog) => dialog.accept());
  await comprador.locator("#finalizar").click();
  await comprador.getByText("Compra finalizada y registrada.").waitFor();
  assert.equal(await comprador.locator("#estadoGlobal").innerText(), "Finalizada");
  // Alternativa manual: prepara un texto sin el secreto del enlace, sin
  // enviar mensajes ni abrir WhatsApp en la prueba.
  assert.equal(await comprador.locator("#compartirPanel").isVisible(),true);
  const resumen=await comprador.locator("#resumenCompartir").inputValue();
  assert.match(resumen,/Compra finalizada con 1 producto/);
  assert.match(resumen,/no disponible/);
  assert.ok(!resumen.includes(enlace));
  assert.ok(!resumen.includes("invitacion="));
  const urlWa=await comprador.locator("#abrirWhatsApp").getAttribute("href");
  const parsedWa=new URL(urlWa);
  assert.equal(parsedWa.hostname,"wa.me");
  assert.equal(parsedWa.searchParams.get("text"),resumen);
  assert.equal(await comprador.locator("#abrirWhatsApp").getAttribute("rel"),
    "noopener noreferrer");
  assert.match(await comprador.locator("#avisoCompartir").innerText(),/manual/);


  // Regresión observada en Windows: listado finalizado y detalle abierto.
  // Actualizar debe dejar ambos coherentes SIN pulsar Ver.
  await admin.locator("#refreshPurchases").click();
  await admin.getByText("Compras y detalle actualizados.").waitFor();
  // Esperar el ESTADO real, no un aviso de éxito que pudiera ser previo.
  await admin.waitForFunction(() => /finalizada/.test(
    document.getElementById("detailTitle")?.textContent || ""
  ));
  assert.match(await admin.locator("#detailTitle").innerText(), /finalizada/);
  const detalleFinal=await admin.locator("#detailBody").innerText();
  assert.match(detalleFinal, /1 comprados/);
  assert.match(detalleFinal, /0 pendientes/);
  assert.match(detalleFinal, /1 no disponibles/);
  assert.equal(await admin.locator("#createInvitation").isDisabled(),true);
  assert.equal(await admin.locator("#showReconciliation").isEnabled(),true);
  assert.equal(await admin.locator("#invitationArea").isVisible(),false);
  assert.match(await admin.locator("#purchaseRows").innerText(), /finalizada/);
  await admin.locator("#showResponses").click();
  await admin.getByText("Todavía no hay respuestas registradas para esta compra.").waitFor();
  assert.equal(await admin.locator("#responses button").count(),0);
  await admin.locator("#showReconciliation").click();
  await admin.getByText("Informe consultado. Reposición no habilitada.").waitFor();
  assert.match(await admin.locator("#reconciliation").innerText(),
    /Reposición desactivada en este entorno/);
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
  await admin.locator("#invitationArea").waitFor({ state: "visible" });
  const enlace = await admin.locator("#invitationLink").inputValue();
  assert.ok(enlace.startsWith(e.origen + "/comprador-v3.html?compra="));
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


test("Navegador HTTPS: cambio de contraseña y revocación administrativa por compra",async t=>{
  const e=await entorno(t);
  const admin=await e.admin.newPage();
  await iniciarAdmin(admin,e.origen);
  const nueva="Nueva clave FICTICIA de pruebas V3 segura 2026!";
  await admin.locator("#passwordCurrent").fill(CLAVE_DEMO);
  await admin.locator("#passwordNew").fill(nueva);
  await admin.locator("#passwordRepeat").fill(nueva);
  admin.once("dialog",dialog=>dialog.accept());
  await admin.locator('#changePasswordForm button[type="submit"]').click();
  await admin.getByText("Contraseña cambiada. Inicia sesión con la nueva.").waitFor();
  assert.equal(await admin.locator("#loginPanel").isVisible(),true);
  await admin.locator("#password").fill(CLAVE_DEMO);
  await admin.locator("#loginButton").click();
  await admin.getByText("Contraseña incorrecta.").waitFor();
  await admin.locator("#password").fill(nueva);
  await admin.locator("#loginButton").click();
  await admin.getByText("Sesión administrativa iniciada.").waitFor();

  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator('#missingSelection input[type="checkbox"]').first().check();
  await admin.locator("#createPurchase").click();
  await admin.locator("#detail").waitFor({state:"visible"});
  admin.once("dialog",dialog=>dialog.accept());
  await admin.locator("#createInvitation").click();
  await admin.locator("#invitationArea").waitFor({state:"visible"});
  const enlace=await admin.locator("#invitationLink").inputValue();
  const comprador=await e.comprador.newPage();
  await comprador.goto(enlace);
  await comprador.getByText("Lista disponible.").waitFor();
  const antes=await comprador.evaluate(async()=>{
    const id=/compra=([0-9]+)/.exec(location.search)?.[1];
    return (await fetch("/api/v3/compras/"+id,{credentials:"same-origin"})).status;
  });
  assert.equal(antes,200);
  admin.once("dialog",dialog=>dialog.accept());
  await admin.locator("#revokeAccess").click();
  await admin.getByText(/Accesos revocados:/).waitFor();
  assert.equal(await admin.locator("#invitationArea").isVisible(),false);
  const despues=await comprador.evaluate(async()=>{
    const id=/compra=([0-9]+)/.exec(location.search)?.[1];
    return (await fetch("/api/v3/compras/"+id,{credentials:"same-origin"})).status;
  });
  assert.equal(despues,403);
});

test("Navegador HTTPS real: reposición opt-in requiere doble aprobación y respeta faltantes",async t=>{
  const e=await entorno(t,{habilitarReposicion:true});
  const compras=crearAlmacenCompras(e.cliente);
  await compras.init();
  const id=(await compras.crearCompra({
    lineas:[{productoId:1},{productoId:2}],
  })).compraId;
  const detalle=await compras.obtenerCompra({compraId:id});
  await compras.cambiarEstadoItem({
    compraId:id,itemId:detalle.items[0].id,
    revisionEsperada:0,estado:"comprado",
  });
  await compras.finalizarCompra({compraId:id});

  const admin=await e.admin.newPage();
  await iniciarAdmin(admin,e.origen);
  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator("#purchaseRows button").first().click();
  await admin.locator("#showReconciliation").click();
  await admin.locator("#reconciliation").getByText(/1 productos reponibles/).waitFor();
  assert.match(await admin.locator("#reconciliation").innerText(),/REPONIBLE/);
  assert.match(await admin.locator("#reconciliation").innerText(),/NO_COMPRADO/);
  assert.equal(await admin.locator("#reconciliation button").count(),1);

  // Cancelar la confirmación deja intacto el catálogo.
  admin.once("dialog",d=>d.dismiss());
  await admin.locator("#reconciliation button").click();
  assert.equal(Number((await e.cliente.execute(
    "SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);

  // Una aprobación explícita repone únicamente el artículo comprado.
  admin.once("dialog",d=>d.accept());
  await admin.locator("#reconciliation button").click();
  await admin.getByText("Inventario de ensayo actualizado; revisa el catálogo.").waitFor();
  const productos=await e.cliente.execute(
    "SELECT id,agotado FROM productos WHERE id IN (1,2) ORDER BY id");
  assert.deepEqual(productos.rows.map(x=>Number(x.agotado)),[0,1]);
  const bitacora=await e.cliente.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_reposiciones_v3");
  assert.equal(Number(bitacora.rows[0].n),1);
  await admin.locator("#showReconciliation").click();
  await admin.locator("#reconciliation").getByText(/CONCILIADA_ANTERIORMENTE/).waitFor();
  assert.equal(await admin.locator("#reconciliation button").count(),0);
});

test("Navegador HTTPS real: cambio ABA tras informe se rechaza sin reponer",async t=>{
  const e=await entorno(t,{habilitarReposicion:true});
  const compras=crearAlmacenCompras(e.cliente);
  await compras.init();
  const id=(await compras.crearCompra({lineas:[{productoId:1}]})).compraId;
  const detalle=await compras.obtenerCompra({compraId:id});
  await compras.cambiarEstadoItem({
    compraId:id,itemId:detalle.items[0].id,
    revisionEsperada:0,estado:"comprado",
  });
  await compras.finalizarCompra({compraId:id});
  const admin=await e.admin.newPage();
  await iniciarAdmin(admin,e.origen);
  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator("#purchaseRows button").first().click();
  await admin.locator("#showReconciliation").click();
  await admin.locator("#reconciliation button").waitFor();
  // Otro agente modifica la necesidad y la devuelve al valor previo.
  await e.cliente.execute("UPDATE productos SET agotado=0 WHERE id=1");
  await e.cliente.execute("UPDATE productos SET agotado=1 WHERE id=1");
  admin.once("dialog",d=>d.accept());
  await admin.locator("#reconciliation button").click();
  await admin.getByText("Operación no completada: V3_REPOSICION_DESACTUALIZADA").waitFor();
  assert.equal(Number((await e.cliente.execute(
    "SELECT agotado FROM productos WHERE id=1")).rows[0].agotado),1);
  assert.equal(Number((await e.cliente.execute(
    "SELECT COUNT(*) AS n FROM hogarstock_reposiciones_v3")).rows[0].n),0);
});

test("Navegador HTTPS: comprador prepara cierre completo manual sin Baileys",async t=>{
  const e=await entorno(t);
  const admin=await e.admin.newPage();
  await iniciarAdmin(admin,e.origen);
  await admin.locator('nav [data-tab="compras"]').click();
  await admin.locator('#missingSelection input[type="checkbox"]').first().check();
  await admin.locator("#createPurchase").click();
  await admin.locator("#detail").waitFor({state:"visible"});
  admin.once("dialog",d=>d.accept());
  await admin.locator("#createInvitation").click();
  await admin.locator("#invitationArea").waitFor({state:"visible"});
  const enlace=await admin.locator("#invitationLink").inputValue();
  const buyer=await e.comprador.newPage();
  await buyer.goto(enlace);
  await buyer.getByText("Lista disponible.").waitFor();
  assert.equal(await buyer.locator("#compartirPanel").isVisible(),false);
  await buyer.locator("#lista select").first().selectOption("comprado");
  await buyer.getByText("Cambio guardado.").waitFor();
  buyer.once("dialog",d=>d.accept());
  await buyer.locator("#finalizar").click();
  await buyer.getByText("Compra finalizada y registrada.").waitFor();
  assert.equal(await buyer.locator("#compartirPanel").isVisible(),true);
  const mensaje=await buyer.locator("#resumenCompartir").inputValue();
  assert.match(mensaje,/Compra completa: todos los productos comprados/);
  assert.doesNotMatch(mensaje,/producto\(s\) pendiente\(s\)/);
  assert.ok(!mensaje.includes("invitacion="));
  const link=await buyer.locator("#abrirWhatsApp").getAttribute("href");
  assert.equal(new URL(link).searchParams.get("text"),mensaje);
  assert.equal(await buyer.locator("#abrirWhatsApp").isVisible(),true);
  // Cerrar acceso borra el resumen del DOM y el vínculo con WhatsApp.
  await buyer.locator("#salir").click();
  await buyer.getByText("Acceso cerrado.").waitFor();
  assert.equal(await buyer.locator("#compartirPanel").isVisible(),false);
  assert.equal(await buyer.locator("#resumenCompartir").inputValue(),"");
  assert.equal(await buyer.locator("#abrirWhatsApp").getAttribute("href"),null);
});
