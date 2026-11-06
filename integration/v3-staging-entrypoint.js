"use strict";

// Entrypoint exclusivamente de STAGING V3: NO sustituye server.js / npm start.
// No inicia WhatsApp, no conecta Turso y no reutiliza secretos o datos V2.
const { randomBytes } = require("node:crypto");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PRODUCCION = "https://hogarstock.onrender.com";

function validarStaging(entorno = {}) {
  if (entorno.HOGARSTOCK_V3_STAGING !== "1") {
    throw new Error("V3_STAGING_NO_AUTORIZADO");
  }
  const prohibidas = [
    "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "HOGARSTOCK_V3_WHATSAPP_LIVE",
    "WA_MASTER_KEY", "WA_ALLOWED_NUMBERS", "WA_AUTOMATION",
    "HOGARSTOCK_STAGING_TURSO_URL", "HOGARSTOCK_STAGING_TURSO_TOKEN",
    "HOGARSTOCK_V3_SANDBOX",
  ];
  if (prohibidas.some(k => entorno[k] !== undefined && entorno[k] !== "")) {
    throw new Error("V3_STAGING_ENTORNO_NO_AISLADO");
  }
  const origen = entorno.HOGARSTOCK_V3_STAGING_ORIGIN;
  let url;
  try { url = new URL(origen); }
  catch (_) { throw new Error("V3_STAGING_ORIGEN_INVALIDO"); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.origin !== origen ||
      url.pathname !== "/" || url.search || url.hash ||
      url.username || url.password || origen === PRODUCCION ||
      !/(?:stage|staging)/.test(hostname) ||
      !(hostname.endsWith(".invalid") || hostname.endsWith(".onrender.com"))) {
    throw new Error("V3_STAGING_ORIGEN_INVALIDO");
  }
  const publico = entorno.HOGARSTOCK_V3_STAGING_PUBLIC === "S";
  if (entorno.HOGARSTOCK_V3_STAGING_PUBLIC &&
      !["S", "N"].includes(entorno.HOGARSTOCK_V3_STAGING_PUBLIC)) {
    throw new Error("V3_STAGING_PUBLICACION_INVALIDA");
  }
  if (publico && !hostname.endsWith(".onrender.com")) {
    throw new Error("V3_STAGING_PUBLICACION_REQUIERE_HOST_SEPARADO");
  }
  const password = entorno.HOGARSTOCK_V3_STAGING_PASSWORD;
  if (typeof password !== "string" || password.length < 16 ||
      Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("V3_STAGING_PASSWORD_INVALIDA");
  }
  const puertoTexto = entorno.PORT === undefined ? "0" : String(entorno.PORT);
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(puertoTexto) ||
      Number(puertoTexto) > 65535) {
    throw new Error("V3_STAGING_PUERTO_INVALIDO");
  }
  return Object.freeze({
    origen, puerto: Number(puertoTexto),
    host: publico ? "0.0.0.0" : "127.0.0.1",
    password,
  });
}

async function iniciarStagingV3({ entorno = process.env } = {}) {
  // Validar ANTES de cargar paquetes, abrir archivos, bases o sockets.
  const cfg = validarStaging(entorno);
  const { createClient } = require("@libsql/client");
  const { crearHashContrasena } = require("../security/access.js");
  const { prepararAplicacionV3 } = require("./v3-production-composition.js");

  const carpeta = mkdtempSync(join(tmpdir(), "hogarstock-v3-stage-"));
  const cliente = createClient({ url: "file:" + join(carpeta, "ficticios.sqlite") });
  let servidor;
  try {
    await cliente.batch([
      "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, categoria TEXT NOT NULL, agotado INTEGER DEFAULT 0)",
      "INSERT INTO productos(nombre,categoria,agotado) VALUES ('Leche FICTICIA','Ensayo',1),('Huevos FICTICIOS','Ensayo',1),('Arroz FICTICIO','Ensayo',0)",
    ], "write");
    const esquema = await cliente.execute("PRAGMA table_info(productos)");
    const campos = new Map(esquema.rows.map(c => [String(c.name), c]));
    if (["id", "nombre", "categoria", "agotado"].some(c => !campos.has(c)) ||
        Number(campos.get("id").pk) !== 1) {
      throw new Error("V3_STAGING_ESQUEMA_INVALIDO");
    }
    const tablas = await cliente.execute("SELECT name FROM sqlite_master WHERE type='table'");
    if (tablas.rows.some(r => !["productos", "sqlite_sequence"].includes(String(r.name)))) {
      throw new Error("V3_STAGING_BASE_NO_AISLADA");
    }
    const numero = await cliente.execute("SELECT COUNT(*) AS n FROM productos");
    if (Number(numero.rows[0].n) !== 3) {
      throw new Error("V3_STAGING_CATALOGO_INVALIDO");
    }
    const { app } = await prepararAplicacionV3({
      cliente, origen: cfg.origen,
      hashAdministrador: crearHashContrasena(cfg.password),
      claveHmacHex: randomBytes(32).toString("hex"),
      esquemaAuditado: true, escriturasAutorizadas: true,
    });
    servidor = await new Promise((resolve, reject) => {
      const s = app.listen(cfg.puerto, cfg.host, () => resolve(s));
      s.once("error", reject);
    });
    servidor.on("upgrade", (_req, socket) => socket.destroy());
    let cerrado = false;
    return Object.freeze({
      host: cfg.host, puerto: servidor.address().port, carpeta,
      async cerrar() {
        if (cerrado) return;
        cerrado = true;
        const cierre = new Promise((resolve, reject) =>
          servidor.close(err => err ? reject(err) : resolve()));
        servidor.closeAllConnections?.();
        await cierre;
        await cliente.close();
        // En Windows la eliminación dentro de Node puede dar EPERM.
        // Los datos ficticios se limpian DESPUÉS de terminar el proceso.
      },
    });
  } catch (error) {
    if (servidor?.listening) await new Promise(r => servidor.close(r));
    await cliente.close();
    throw error;
  }
}

if (require.main === module) {
  iniciarStagingV3().then(s => {
    process.stdout.write("V3_STAGING_ACTIVO=SI\n");
    process.stdout.write("V3_STAGING_HOST=" + s.host + "\n");
    process.stdout.write("V3_STAGING_PUERTO=" + s.puerto + "\n");
    process.stdout.write("WHATSAPP_REAL=NO\nTURSO_REMOTO=NO\n");
    let terminando = false;
    const cerrar = () => {
      if (terminando) return;
      terminando = true;
      void s.cerrar().then(() => {
        process.stdout.write("V3_STAGING_CERRADO=SI\n");
      }).catch(() => { process.exitCode = 1; });
    };
    process.once("SIGINT", cerrar);
    process.once("SIGTERM", cerrar);
  }).catch(error => {
    const codigo = /^V3_STAGING_[A-Z_]+$/.test(error?.message) ?
      error.message : "V3_STAGING_FALLO_ARRANQUE";
    process.stderr.write(codigo + "\n");
    process.exitCode = 1;
  });
}
module.exports = { validarStaging, iniciarStagingV3 };
