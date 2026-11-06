"use strict";

// Composición HTTP V3 sin efectos secundarios al importar.
// NO es un entrypoint de Render y NO inicia Turso, WhatsApp o sockets.
// Los almacenes se deben inicializar y verificar fuera, tras respaldo y preflight.
const express = require("express");
const { join } = require("node:path");
const { crearRouterV3 } = require("../api/v3-router.js");

const RUTAS_V2 = [
  "/api/productos", "/api/whatsapp-status", "/api/agotar/:id",
  "/api/iniciar-compra", "/api/comprado/:id", "/api/finalizar-compra",
];

function validarOrigen(origen) {
  if (typeof origen !== "string") throw new Error("V3_ORIGEN_HTTPS_REQUERIDO");
  let url;
  try { url = new URL(origen); } catch (_) { throw new Error("V3_ORIGEN_HTTPS_INVALIDO"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/" || url.origin !== origen ||
      ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname.toLowerCase())) {
    throw new Error("V3_ORIGEN_HTTPS_INVALIDO");
  }
  return origen;
}

function crearAplicacionV3Produccion({
  origen, acceso, compras, catalogo, conciliador, sesionesComprador,
  bandejaWhatsApp, aplicadorWhatsApp, esquemaVerificado = false,
} = {}) {
  if (esquemaVerificado !== true) throw new Error("V3_ESQUEMA_NO_VERIFICADO");
  validarOrigen(origen);
  if (process.env.HOGARSTOCK_V3_SANDBOX === "1") {
    throw new Error("V3_PRODUCCION_PROHIBIDA_EN_SANDBOX");
  }
  if (!acceso || !compras || !catalogo || !conciliador || !sesionesComprador ||
      !bandejaWhatsApp || !aplicadorWhatsApp) {
    throw new Error("V3_DEPENDENCIAS_NO_INICIALIZADAS");
  }
  // Crear el router antes de publicar cualquier ruta. Su constructor valida
  // las interfaces de seguridad y el origen declarado.
  const router = crearRouterV3({
    origen, acceso, compras, catalogo, conciliador,
    sesionesComprador, bandejaWhatsApp, aplicadorWhatsApp,
  });
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.get("/health", (_req, res) => res.status(200).json({
    correcto: true, version: 3,
  }));
  // Bloquear V2 antes de montar V3. No montar express.static(public).
  for (const ruta of RUTAS_V2) {
    app.all(ruta, (_req, res) => res.status(410).json({
      error: "API_V2_DESHABILITADA",
    }));
  }
  app.all(["/", "/index.html", "/comprador.html"], (_req, res) =>
    res.status(410).json({ error: "PANTALLA_V2_DESHABILITADA" }));
  app.get("/admin-v3.html", (_req, res) => res.sendFile(join(__dirname, "../public/admin-v3.html")));
  app.get("/comprador-v3.html", (_req, res) => res.sendFile(join(__dirname, "../public/comprador-v3.html")));
  app.use("/api/v3", router);
  app.use((_req, res) => res.status(404).json({ error: "RUTA_INEXISTENTE" }));
  return app;
}

module.exports = { crearAplicacionV3Produccion, validarOrigen };
