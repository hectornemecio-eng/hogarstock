"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const tls = require("node:tls");
const { randomBytes } = require("node:crypto");
const { crearServidorAislado, CLAVE_DEMO } = require("../integration/v3-sandbox-server.js");

async function entorno(t) {
  const e = await crearServidorAislado({
    certPath: process.env.HOGARSTOCK_SANDBOX_CERT,
    keyPath: process.env.HOGARSTOCK_SANDBOX_KEY,
  });
  t.after(() => e.cerrar());
  return e;
}

async function pedir(origen, ruta, metodo = "GET", cuerpo = undefined, cookies = "") {
  const url = new URL(ruta, origen);
  const json = cuerpo === undefined ? null : JSON.stringify(cuerpo);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: metodo, rejectUnauthorized: false, agent: false, timeout: 5000,
      headers: {
        ...(json === null ? {} : { "content-type": "application/json" }),
        ...(cookies ? { cookie: cookies } : {}),
        ...(metodo === "GET" ? {} : { origin: origen }),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: JSON.parse(body || "{}"),
        setCookie: res.headers["set-cookie"]?.[0],
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTPS_TIMEOUT")));
    if (json !== null) req.write(json);
    req.end();
  });
}

test("Frontera V2: todas las rutas HTTP antiguas responden 410 y no mutan datos", async (t) => {
  const { origen, cliente } = await entorno(t);
  const productosAntes = await cliente.execute("SELECT id,nombre,agotado FROM productos ORDER BY id");
  const rutas = [
    ["GET", "/api/productos"],
    ["GET", "/api/whatsapp-status"],
    ["POST", "/api/agotar/1"],
    ["POST", "/api/iniciar-compra"],
    ["POST", "/api/comprado/1"],
    ["POST", "/api/finalizar-compra"],
  ];
  for (const [metodo, ruta] of rutas) {
    const respuesta = await pedir(origen, ruta, metodo, metodo === "POST" ? { telefono: "000000000" } : undefined);
    assert.equal(respuesta.status, 410, metodo + " " + ruta);
    assert.equal(respuesta.body.error, "API_V2_DESHABILITADA");
    assert.equal(Object.hasOwn(respuesta.body, "qr"), false);
  }
  const productosDespues = await cliente.execute("SELECT id,nombre,agotado FROM productos ORDER BY id");
  assert.deepEqual(productosDespues.rows, productosAntes.rows);
});

test("Frontera V2: HTML de las pantallas antiguas no se sirve", async (t) => {
  const { origen } = await entorno(t);
  for (const ruta of ["/", "/index.html", "/comprador.html"]) {
    const respuesta = await pedir(origen, ruta);
    assert.equal(respuesta.status, 410, ruta);
    assert.equal(respuesta.body.error, "PANTALLA_V2_DESHABILITADA");
  }
  for (const ruta of ["/admin-v3.html", "/comprador-v3.html"]) {
    const url = new URL(ruta, origen);
    const respuesta = await new Promise((resolve, reject) => {
      https.get(url, { rejectUnauthorized: false, agent: false, timeout: 5000 }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }).on("error", reject);
    });
    assert.equal(respuesta, 200, ruta);
  }
});

test("Frontera V2: una conexion WebSocket sin autorizacion no obtiene 101", async (t) => {
  const { origen } = await entorno(t);
  const url = new URL(origen);
  const port = Number(url.port);
  const protocolResponse = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1", port, rejectUnauthorized: false,
    });
    let text = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("UPGRADE_NO_TERMINADO"));
    }, 3000);
    socket.on("secureConnect", () => {
      socket.write(
        "GET / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: " + randomBytes(16).toString("base64") + "\r\n\r\n"
      );
    });
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n\r\n")) finish(text);
    });
    socket.on("end", () => finish(text));
    socket.on("close", () => finish(text));
    socket.on("error", reject);
  });
  assert.doesNotMatch(protocolResponse, /^HTTP\/1\.[01] 101\b/);
});

test("Frontera V3: login y rutas protegidas siguen disponibles", async (t) => {
  const { origen } = await entorno(t);
  const sin = await pedir(origen, "/api/v3/admin/productos");
  assert.equal(sin.status, 401);
  assert.equal(Object.hasOwn(sin.body, "productos"), false);
  const login = await pedir(origen, "/api/v3/auth/login", "POST", {
    contrasena: CLAVE_DEMO,
  });
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /Secure/);
  const catalogo = await pedir(origen, "/api/v3/admin/productos", "GET",
    undefined, login.setCookie.split(";")[0]);
  assert.equal(catalogo.status, 200);
  assert.equal(catalogo.body.productos.length, 3);
});
