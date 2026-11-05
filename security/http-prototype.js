"use strict";

// Prototipo HTTP aislado para validar autorizacion; NO conectado a server.js.
// Unicamente para tests locales y de CI con datos ficticios.
const { createServer } = require("node:http");

function crearHttpPrototipo({
  acceso, origen, compras, qrFicticio = "QR_FICTICIO_NO_VINCULABLE"
}) {
  if (!acceso || typeof acceso.autorizarAdmin !== "function" ||
      typeof acceso.autorizarCompra !== "function") {
    throw new TypeError("Servicio de acceso no valido");
  }
  if (typeof origen !== "string" || !/^https?:\/\/[^/]+$/.test(origen)) {
    throw new TypeError("Origen permitido obligatorio");
  }
  if (!(compras instanceof Map)) throw new TypeError("Compras de prueba no validas");

  function responder(res, status, datos, cabeceras = {}) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...cabeceras,
    });
    res.end(JSON.stringify(datos));
  }

  function cookieAdmin(req) {
    const cookies = String(req.headers.cookie || "").split(";");
    const entrada = cookies.find((x) => x.trim().startsWith("hs_admin_v3="));
    return entrada ? entrada.trim().slice("hs_admin_v3=".length) : "";
  }

  function tokenComprador(req) {
    const valor = String(req.headers.authorization || "");
    return /^Bearer [A-Za-z0-9_-]{43}$/.test(valor) ? valor.slice(7) : "";
  }

  async function leerJson(req) {
    let texto = "";
    for await (const fragmento of req) {
      texto += fragmento;
      if (Buffer.byteLength(texto, "utf8") > 4096) {
        const error = new Error("Cuerpo demasiado grande");
        error.status = 413;
        throw error;
      }
    }
    try {
      const contenido = JSON.parse(texto);
      if (!contenido || Array.isArray(contenido) || typeof contenido !== "object") {
        throw new Error("JSON no valido");
      }
      return contenido;
    } catch (_) {
      const error = new Error("JSON no valido");
      error.status = 400;
      throw error;
    }
  }

  return createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, origen).pathname;
      if (req.method === "POST" && req.headers.origin !== origen) {
        responder(res, 403, { error: "Origen no autorizado" });
        return;
      }

      if (req.method === "POST" && pathname === "/demo/login") {
        const datos = await leerJson(req);
        const sesion = await acceso.iniciarSesionAdmin({
          contrasena: datos.contrasena,
          ttlMs: 60 * 60 * 1000,
        });
        if (!sesion) {
          responder(res, 401, { error: "Acceso denegado" });
          return;
        }
        // En HTTPS de produccion se exigiria Secure. El test corre
        // exclusivamente en localhost HTTP; esta cookie no es para produccion.
        responder(res, 200, { ok: true }, {
          "set-cookie": "hs_admin_v3=" + sesion.token +
            "; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600",
        });
        return;
      }

      if (req.method === "GET" && pathname === "/demo/qr") {
        if (!(await acceso.autorizarAdmin({ token: cookieAdmin(req) }))) {
          responder(res, 401, { error: "No autorizado" });
          return;
        }
        responder(res, 200, { qr: qrFicticio });
        return;
      }

      const accesoCompra = /^\/demo\/compras\/([1-9][0-9]{0,15})$/.exec(pathname);
      if (req.method === "GET" && accesoCompra) {
        const compraId = accesoCompra[1];
        if (!(await acceso.autorizarCompra({ compraId, token: tokenComprador(req) }))) {
          responder(res, 403, { error: "Compra no autorizada" });
          return;
        }
        const compra = compras.get(compraId);
        if (!compra) {
          responder(res, 404, { error: "Compra inexistente" });
          return;
        }
        responder(res, 200, { compra });
        return;
      }

      responder(res, 404, { error: "Ruta inexistente" });
    } catch (error) {
      if (error && error.status) {
        responder(res, error.status, { error: error.message });
      } else {
        responder(res, 500, { error: "Error interno" });
      }
    }
  });
}

module.exports = { crearHttpPrototipo };
