"use strict";

// Servidor V3 de staging PERSISTENTE y SOLO LOCAL. No reemplaza npm start.
// Certificado HTTPS y proxy de produccion NO forman parte de este ensayo.
const { validarStaging } = require("./v3-staging-entrypoint.js");
const { abrirPersistencia, crearRespaldo, validarRuta } =
  require("./v3-staging-persistence.js");

function validarStagingPersistente(entorno = {}) {
  const cfg = validarStaging(entorno);
  if (cfg.host !== "127.0.0.1" ||
      entorno.HOGARSTOCK_V3_STAGING_PUBLIC === "S") {
    throw new Error("V3_PERSISTENTE_SOLO_LOOPBACK");
  }
  const directorio = validarRuta(entorno.HOGARSTOCK_V3_STAGING_PERSIST_DIR);
  const hmac = entorno.HOGARSTOCK_V3_STAGING_HMAC_HEX;
  if (typeof hmac !== "string" || !/^[a-fA-F0-9]{64}$/.test(hmac)) {
    throw new Error("V3_PERSISTENTE_HMAC_REQUERIDA");
  }
  return Object.freeze({ ...cfg, directorio, hmac });
}

async function iniciarStagingPersistente({ entorno = process.env } = {}) {
  const cfg = validarStagingPersistente(entorno);
  // No abrir archivos hasta superar TODAS las condiciones de aislamiento.
  const { crearHashContrasena } = require("../security/access.js");
  const { prepararAplicacionV3 } = require("./v3-production-composition.js");
  const estado = await abrirPersistencia(cfg.directorio);
  let servidor;
  try {
    const { app } = await prepararAplicacionV3({
      cliente: estado.cliente,
      origen: cfg.origen,
      hashAdministrador: crearHashContrasena(cfg.password),
      claveHmacHex: cfg.hmac,
      // Preflight de SQLite local y marca verificadas en abrirPersistencia.
      esquemaAuditado: true,
      escriturasAutorizadas: true,
    });
    servidor = await new Promise((resolve, reject) => {
      const s = app.listen(cfg.puerto, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    servidor.on("upgrade", (_req, socket) => socket.destroy());
    let cerrado = false;
    return Object.freeze({
      host: "127.0.0.1", puerto: servidor.address().port,
      directorio: estado.directorio, nuevo: estado.nuevo,
      async respaldo() {
        if (cerrado) throw new Error("V3_PERSISTENTE_YA_CERRADO");
        return crearRespaldo({
          directorio: estado.directorio, cliente: estado.cliente,
        });
      },
      async cerrar() {
        if (cerrado) return;
        cerrado = true;
        const fin = new Promise((resolve, reject) =>
          servidor.close(error => error ? reject(error) : resolve()));
        servidor.closeAllConnections?.();
        await fin;
        await estado.cliente.close();
        // Los datos y respaldos se conservan intencionadamente.
      },
    });
  } catch (error) {
    if (servidor?.listening) {
      await new Promise(resolve => servidor.close(resolve));
    }
    await estado.cliente.close();
    throw error;
  }
}

if (require.main === module) {
  iniciarStagingPersistente().then(server => {
    process.stdout.write("V3_PERSISTENTE_ACTIVO=SI\n");
    process.stdout.write("HOST=" + server.host + "\n");
    process.stdout.write("PUERTO=" + server.puerto + "\n");
    process.stdout.write("BD_FICTICIA_PERSISTENTE=SI\n");
    process.stdout.write("TURSO_REMOTO=NO\nWHATSAPP_REAL=NO\n");
    let cerrando = false;
    function cerrar() {
      if (cerrando) return;
      cerrando = true;
      void server.cerrar().then(() => {
        process.stdout.write("V3_PERSISTENTE_CERRADO=SI\n");
      }).catch(() => { process.exitCode = 1; });
    }
    process.once("SIGINT", cerrar);
    process.once("SIGTERM", cerrar);
  }).catch(error => {
    process.stderr.write("V3_PERSISTENTE_NO_INICIADO=" +
      (/^V3_[A-Z_]+$/.test(error?.message) ?
        error.message : "FALLO_SEGURO") + "\n");
    process.exitCode = 1;
  });
}
module.exports = { validarStagingPersistente, iniciarStagingPersistente };
