"use strict";

// Arranque REMOTO de staging V3 con Turso separado; deshabilitado por defecto.
// No se importa desde server.js ni desde npm start. Sin puente WhatsApp.
// Se exige URL aislada, prueba de identidad en BD, respaldo declarado y dos
// autorizaciones explicitas ANTES de abrir conexion y ANTES de escribir.
const { validarDestinoEnsayo } = require("./turso-stage-guard.js");
const { validarOrigen } = require("./v3-production-app.js");
const { auditarEsquemaSinEscritura } = require("./v3-readonly-schema-audit.js");

const REQUERIDAS = Object.freeze([
  "hogarstock_admin_sessions_v3",
  "hogarstock_compras_v3",
  "hogarstock_compra_items_v3",
  "hogarstock_wa_inbox_v3",
  "hogarstock_wa_outbox_v3",
]);

function validarPerfilRemoto(entorno = {}) {
  if (entorno.HOGARSTOCK_V3_REMOTE_STAGE !== "1") {
    throw new Error("V3_REMOTO_STAGING_NO_HABILITADO");
  }
  const prohibidas = [
    "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "HOGARSTOCK_V3_WHATSAPP_LIVE", "HOGARSTOCK_V3_SANDBOX",
    "HOGARSTOCK_V3_STAGING_PUBLIC", "WA_MASTER_KEY",
    "WA_ALLOWED_NUMBERS", "WA_AUTOMATION",
  ];
  if (prohibidas.some(k => Boolean(entorno[k])) ||
      Object.keys(entorno).some(k =>
        (k.startsWith("WHATSAPP_") || (k.startsWith("WA_") &&
        !prohibidas.includes(k))) && Boolean(entorno[k]))) {
    throw new Error("V3_REMOTO_ENTORNO_MIXTO_PROHIBIDO");
  }

  const origen = entorno.HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN;
  try { validarOrigen(origen); }
  catch (_) { throw new Error("V3_REMOTO_ORIGEN_INVALIDO"); }
  const urlPublica = new URL(origen);
  const hostWeb = urlPublica.hostname.toLowerCase();
  // Aislamiento estricto: solo DNS publicos de un servicio V3 de ensayo.
  // No se aceptan comodines arbitrarios, dominios propios ni puertos publicos
  // hasta disponer de una auditoria de TLS/ingress independiente.
  const patrones = Object.freeze({
    render: /^hogarstock(?:-[a-z0-9]+)*-(?:stage|staging)(?:-[a-z0-9]+)*\.onrender\.com$/,
    northflank: /^[a-z][a-z0-9-]{0,19}--hogarstock-v3-(?:stage|staging)(?:-[a-z0-9]+)*--[a-z0-9-]+(?:\.[a-z0-9-]+)?\.code\.run$/,
    enzonic: /^hogarstock-v3-(?:stage|staging)(?:-[a-z0-9]+)*\.(?:spain|us)\.free\.enzonic\.com$/,
  });
  const proveedor = Object.entries(patrones).find(([, patron]) =>
    patron.test(hostWeb))?.[0];
  if (!proveedor || urlPublica.port !== "" ||
      hostWeb === "hogarstock.onrender.com") {
    throw new Error("V3_REMOTO_ORIGEN_NO_AISLADO");
  }
  // Decisión vigente del usuario: seguir solo con Render.
  // Conservar soporte experimental para otros proveedores, pero inactivo
  // salvo autorización futura explícita. No afecta al servicio Render V2.
  if (proveedor !== "render" &&
      entorno.HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER !== "S") {
    throw new Error("V3_REMOTO_ALTERNATIVAS_PAUSADAS");
  }
  // La seleccion del proveedor es explicita, para evitar permitir un dominio
  // distinto del que el operador cree haber auditado.
  if (entorno.HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER !== proveedor) {
    throw new Error("V3_REMOTO_PROVEEDOR_NO_COINCIDE");
  }
  if (entorno.HOGARSTOCK_V3_REMOTE_STAGE_HOST !== hostWeb) {
    throw new Error("V3_REMOTO_HOST_NO_COINCIDE");
  }

  const bd = {
    url: entorno.HOGARSTOCK_STAGING_TURSO_URL,
    hostEsperado: entorno.HOGARSTOCK_STAGING_TURSO_HOST,
    hostProduccion: entorno.HOGARSTOCK_PRODUCTION_TURSO_HOST,
    authToken: entorno.HOGARSTOCK_STAGING_TURSO_TOKEN,
  };
  let identidad;
  try { identidad = validarDestinoEnsayo(bd); }
  catch (_) { throw new Error("V3_REMOTO_BASE_NO_VERIFICADA"); }

  const adminHash = entorno.HOGARSTOCK_STAGING_ADMIN_HASH;
  if (typeof adminHash !== "string" ||
      !/^scrypt:16384:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(adminHash)) {
    throw new Error("V3_REMOTO_HASH_ADMIN_INVALIDO");
  }
  const hmac = entorno.HOGARSTOCK_STAGING_INBOX_KEY;
  if (typeof hmac !== "string" || !/^[a-fA-F0-9]{64}$/.test(hmac)) {
    throw new Error("V3_REMOTO_HMAC_INVALIDA");
  }
  const comprobante = entorno.HOGARSTOCK_STAGING_PROOF_ID;
  if (typeof comprobante !== "string" || !/^[a-f0-9]{32}$/.test(comprobante)) {
    throw new Error("V3_REMOTO_IDENTIDAD_AUSENTE");
  }
  const shaRespaldo = entorno.HOGARSTOCK_STAGING_BACKUP_SHA256;
  if (typeof shaRespaldo !== "string" ||
      !/^[a-f0-9]{64}$/.test(shaRespaldo)) {
    throw new Error("V3_REMOTO_RESPALDO_NO_DECLARADO");
  }
  for (const nombre of [
    "HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT",
    "HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_WRITE",
    "HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED",
  ]) {
    if (!["S", "N", undefined].includes(entorno[nombre])) {
      throw new Error("V3_REMOTO_AUTORIZACION_INVALIDA");
    }
  }
  const puertoStr = String(entorno.PORT ?? "");
  if (!/^(0|[1-9][0-9]{0,4})$/.test(puertoStr) ||
      Number(puertoStr) > 65535) {
    throw new Error("V3_REMOTO_PUERTO_INVALIDO");
  }
  return Object.freeze({
    origen, hostWeb, proveedor, puerto: Number(puertoStr),
    hostBase: identidad.host,
    url: bd.url, authToken: bd.authToken,
    adminHash, hmac, comprobante,
    shaRespaldo,
    permitirConexion: entorno.HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT === "S",
    permitirEscritura: entorno.HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_WRITE === "S",
    respaldoConfirmado: entorno.HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED === "S",
  });
}

async function comprobarIdentidadRemota(cliente, cfg) {
  if (!cliente || typeof cliente.execute !== "function") {
    throw new Error("V3_REMOTO_CLIENTE_INVALIDO");
  }
  let id;
  try {
    const r = await cliente.execute(
      "SELECT host,proof_id FROM hogarstock_v3_stage_proof WHERE id=1");
    if (r.rows?.length !== 1) throw new Error("invalido");
    id = r.rows[0];
  } catch (_) {
    throw new Error("V3_REMOTO_MARCA_NO_VERIFICADA");
  }
  if (String(id.host) !== cfg.hostBase ||
      String(id.proof_id) !== cfg.comprobante) {
    throw new Error("V3_REMOTO_IDENTIDAD_NO_COINCIDE");
  }
  const auditoria = await auditarEsquemaSinEscritura(cliente);
  if (!auditoria.catalogoCompatible ||
      REQUERIDAS.some(t => !auditoria.tablasV3Detectadas.includes(t))) {
    throw new Error("V3_REMOTO_ESQUEMA_INCOMPATIBLE");
  }
  return Object.freeze({ identidadVerificada: true, esquemaVerificado: true });
}

async function iniciarStagingRemoto({
  entorno = process.env,
  fabricaCliente,
} = {}) {
  const cfg = validarPerfilRemoto(entorno);
  if (!cfg.permitirConexion) throw new Error("V3_REMOTO_RED_BLOQUEADA");
  if (!cfg.respaldoConfirmado) throw new Error("V3_REMOTO_RESPALDO_PENDIENTE");
  if (!cfg.permitirEscritura) throw new Error("V3_REMOTO_ESCRITURA_BLOQUEADA");

  // Solo aqui, tras autorizar, se permite crear cliente externo.
  const crearCliente = fabricaCliente || require("@libsql/client").createClient;
  if (typeof crearCliente !== "function") {
    throw new Error("V3_REMOTO_FABRICA_INVALIDA");
  }
  let cliente, servidor;
  try {
    cliente = crearCliente({ url: cfg.url, authToken: cfg.authToken });
    await comprobarIdentidadRemota(cliente, cfg); // solo lectura
    const { prepararAplicacionV3 } =
      require("./v3-production-composition.js");
    const { app } = await prepararAplicacionV3({
      cliente, origen: cfg.origen,
      hashAdministrador: cfg.adminHash,
      claveHmacHex: cfg.hmac,
      esquemaAuditado: true, escriturasAutorizadas: true,
    });
    servidor = await new Promise((resolver, rechazar) => {
      const s = app.listen(cfg.puerto, "0.0.0.0", () => resolver(s));
      s.once("error", rechazar);
    });
    servidor.on("upgrade", (_req, socket) => socket.destroy());
    let cerrado = false;
    return Object.freeze({
      puerto: servidor.address().port,
      async cerrar() {
        if (cerrado) return;
        cerrado = true;
        const cerradoHttp = new Promise((resolver, rechazar) =>
          servidor.close(e => e ? rechazar(e) : resolver()));
        servidor.closeAllConnections?.();
        await cerradoHttp;
        await cliente.close();
      },
    });
  } catch (error) {
    if (servidor?.listening) {
      await new Promise(r => servidor.close(r));
    }
    if (cliente && typeof cliente.close === "function") {
      await cliente.close();
    }
    throw error;
  }
}

if (require.main === module) {
  iniciarStagingRemoto().then(s => {
    process.stdout.write("V3_STAGING_REMOTO_ACTIVO=SI\n");
    process.stdout.write("PUERTO=" + s.puerto + "\n");
    process.stdout.write("WHATSAPP_REAL=NO\n");
    let cerrando = false;
    function cerrar() {
      if (cerrando) return;
      cerrando = true;
      void s.cerrar().then(() => {
        process.stdout.write("V3_STAGING_REMOTO_CERRADO=SI\n");
      }).catch(() => { process.exitCode = 1; });
    }
    process.once("SIGINT", cerrar);
    process.once("SIGTERM", cerrar);
  }).catch(e => {
    // Nunca imprimir excepciones del SDK, URL ni secretos.
    const msg = typeof e?.message === "string" &&
      /^V3_REMOTO_[A-Z_]+$/.test(e.message) ?
      e.message : "V3_REMOTO_ARRANQUE_NO_CONFIRMADO";
    process.stderr.write(msg + "\n");
    process.exitCode = 1;
  });
}
module.exports = {
  validarPerfilRemoto, comprobarIdentidadRemota, iniciarStagingRemoto,
};
