"use strict";

// Solo entorno de pruebas aislado. NO sustituye server.js ni puede utilizar
// Turso, WhatsApp, sus datos o secretos de produccion.
const express = require("express");
const https = require("node:https");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createClient } = require("@libsql/client");

const { crearHashContrasena, crearServicioAcceso } = require("../security/access.js");
const { crearAlmacenSeguridad } = require("../security/store.js");
const { crearSesionesComprador } = require("../security/buyer-sessions.js");
const { crearCatalogoV3 } = require("../catalogo/store.js");
const { crearAlmacenCompras } = require("../compras/store.js");
const { crearConciliadorCompras } = require("../compras/conciliacion.js");
const { crearRouterV3 } = require("../api/v3-router.js");

const CLAVE_DEMO = "HogarStock-V3-Clave-FICTICIA-Solo-Pruebas-2026!";

async function crearServidorAislado({ certPath, keyPath } = {}) {
  if (process.env.HOGARSTOCK_V3_SANDBOX !== "1") {
    throw new Error("AISLAMIENTO_REQUERIDO: establecer HOGARSTOCK_V3_SANDBOX=1");
  }
  if (process.env.TURSO_DATABASE_URL || process.env.TURSO_AUTH_TOKEN) {
    throw new Error("CREDENCIALES_DE_PRODUCCION_PRESENTES: no se inicia el entorno de pruebas");
  }
  if (!certPath || !keyPath) throw new Error("Se requiere HTTPS local de pruebas");
  const certificado = readFileSync(certPath);
  const llave = readFileSync(keyPath);
  const carpeta = mkdtempSync(join(tmpdir(), "hogarstock-v3-e2e-"));
  const dbPath = join(carpeta, "datos-ficticios.sqlite");
  let cliente = null;
  let servidor = null;
  try {
    cliente = createClient({ url: "file:" + dbPath });
    await cliente.batch([
      "CREATE TABLE productos (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)",
      "INSERT INTO productos(id,nombre,categoria,agotado) VALUES" +
        "(1,'Leche ficticia','Lacteos',1)," +
        "(2,'Huevos ficticios','Lacteos',1)," +
        "(3,'Arroz ficticio','Despensa',0)",
    ], "write");
    const almacenSeguridad = crearAlmacenSeguridad(cliente);
    const almacenCompras = crearAlmacenCompras(cliente);
    await almacenSeguridad.init();
    await almacenCompras.init();
    const sesionesComprador = crearSesionesComprador({ cliente });
    await sesionesComprador.init();
    const acceso = crearServicioAcceso({
      almacen: almacenSeguridad,
      hashAdministrador: crearHashContrasena(CLAVE_DEMO),
    });
    const catalogo = crearCatalogoV3(cliente);
    const conciliador = crearConciliadorCompras(cliente);

    const app = express();
    app.disable("x-powered-by");
    app.get("/health", (_req, res) => res.status(200).json({
      entorno: "pruebas_aisladas", correcto: true,
    }));
    // Compatibilidad NEGATIVA: ninguna ruta publica V2 debe seguir activa.
    // Devolver 410 sin acceder a producto, QR, WhatsApp ni sesiones antiguas.
    for (const ruta of [
      "/api/productos",
      "/api/whatsapp-status",
      "/api/agotar/:id",
      "/api/iniciar-compra",
      "/api/comprado/:id",
      "/api/finalizar-compra",
    ]) {
      app.all(ruta, (_req, res) => res.status(410).json({
        error: "API_V2_DESHABILITADA",
      }));
    }
    app.all(["/", "/index.html", "/comprador.html"], (_req, res) =>
      res.status(410).json({ error: "PANTALLA_V2_DESHABILITADA" })
    );
    app.get("/admin-v3.html", (_req, res) => res.sendFile(
      join(__dirname, "../public/admin-v3.html")
    ));
    app.get("/comprador-v3.html", (_req, res) => res.sendFile(
      join(__dirname, "../public/comprador-v3.html")
    ));
    // Abrimos exclusivamente loopback; luego obtenemos el origen HTTPS real
    // con el puerto efimero y registramos el router antes de responder.
    servidor = https.createServer({ key: llave, cert: certificado }, app);
    await new Promise((resolve, reject) => {
      servidor.once("error", reject);
      servidor.listen(0, "127.0.0.1", resolve);
    });
    const origen = "https://127.0.0.1:" + servidor.address().port;
    // Este entorno NO habilita WebSockets, ni los heredados ni nuevos.
    // Cerramos cualquier intento de upgrade antes de la negociacion 101.
    servidor.on("upgrade", (_req, socket) => {
      socket.destroy();
    });
    app.use("/api/v3", crearRouterV3({
      acceso, compras: almacenCompras, catalogo, conciliador,
      sesionesComprador, origen,
    }));
    app.use((_req, res) => res.status(404).json({ error: "RUTA_INEXISTENTE" }));

    let cerrado = false;
    async function cerrar() {
      if (cerrado) return;
      cerrado = true;
      const cierre = new Promise((resolve, reject) =>
        servidor.close((err) => err ? reject(err) : resolve())
      );
      // Solo staging: forzar el cierre de conexiones HTTPS ociosas
      // para que los agentes de test no queden retenidos por keep-alive.
      servidor.closeAllConnections();
      await cierre;
      cliente.close();
      rmSync(carpeta, { recursive: true, force: true });
    }
    return Object.freeze({ origen, cerrar, cliente });
  } catch (error) {
    if (servidor && servidor.listening) {
      await new Promise((resolve) => servidor.close(resolve));
    }
    if (cliente) cliente.close();
    rmSync(carpeta, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { crearServidorAislado, CLAVE_DEMO };
