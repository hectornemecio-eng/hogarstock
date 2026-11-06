"use strict";

// Puente Baileys 7 -> almacén cifrado V3 -> coordinador -> bandeja.
// DEFAULT SIN RED. Nunca importa server.js ni instancia una sesión de producción.
// No es un punto de entrada ni se monta automáticamente en Render.
const { crearEstadoBaileysCifrado } = require("./auth-store.js");
const { crearAdaptadorEntradaBaileys } = require("./inbound-baileys.js");

function versionValida(version) {
  return Array.isArray(version) && version.length === 3 &&
    version.every(n => Number.isInteger(n) && n >= 0);
}

function crearPuenteBaileysV3({
  cliente, urlBaseDatos, claveMaestraHex, bandeja,
  cargarBiblioteca, consultarVersionWeb,
  modo = "sin_red", entorno = process.env,
} = {}) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.batch !== "function" ||
      typeof cargarBiblioteca !== "function" ||
      typeof consultarVersionWeb !== "function" ||
      !bandeja || typeof bandeja.recibir !== "function") {
    throw new TypeError("WA_PUENTE_DEPENDENCIAS_INVALIDAS");
  }
  // Sólo base LOCAL y de prueba. La integración con Turso remoto exige
  // otro control y otra batería de pruebas antes de habilitarse.
  if (typeof urlBaseDatos !== "string" ||
      !/^file:[A-Za-z0-9_./\\:-]+\.sqlite$/.test(urlBaseDatos) ||
      /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(urlBaseDatos)) {
    throw new Error("WA_PUENTE_REQUIERE_SQLITE_LOCAL");
  }
  if (!["sin_red", "conexion"].includes(modo)) {
    throw new TypeError("WA_PUENTE_MODO_INVALIDO");
  }
  if (modo === "conexion" &&
      (entorno?.HOGARSTOCK_V3_SANDBOX !== "1" ||
       entorno?.HOGARSTOCK_V3_WHATSAPP_LIVE !== "1" ||
       entorno?.TURSO_DATABASE_URL ||
       entorno?.TURSO_AUTH_TOKEN)) {
    throw new Error("WA_PUENTE_CONEXION_NO_AUTORIZADA");
  }
  if (typeof claveMaestraHex !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(claveMaestraHex)) {
    throw new Error("WA_PUENTE_CLAVE_INVALIDA");
  }

  let bibliotecaPendiente = null;
  const adaptadores = new Set();
  function biblioteca() {
    if (!bibliotecaPendiente) {
      bibliotecaPendiente = Promise.resolve().then(cargarBiblioteca).then(mod => {
        if (!mod || typeof mod.makeWASocket !== "function" ||
            typeof mod.initAuthCreds !== "function" ||
            typeof mod.BufferJSON?.replacer !== "function" ||
            typeof mod.BufferJSON?.reviver !== "function" ||
            typeof mod.proto?.Message?.AppStateSyncKeyData?.fromObject !== "function" ||
            !mod.logger || typeof mod.logger.child !== "function") {
          throw new Error("WA_PUENTE_BAILEYS_INCOMPATIBLE");
        }
        return mod;
      }).catch(err => {
        bibliotecaPendiente = null;
        throw err;
      });
    }
    return bibliotecaPendiente;
  }

  async function crearAuth() {
    const m = await biblioteca();
    return crearEstadoBaileysCifrado({
      cliente,
      masterKeyHex: claveMaestraHex,
      BufferJSON: m.BufferJSON,
      initAuthCreds: m.initAuthCreds,
      reviveAppStateSyncKey: m.proto.Message.AppStateSyncKeyData.fromObject,
    });
  }

  async function comprobarSinRed() {
    const a = await crearAuth();
    if (!a?.state?.creds || typeof a.state.keys?.get !== "function" ||
        typeof a.state.keys?.set !== "function" ||
        typeof a.saveCreds !== "function") {
      throw new Error("WA_PUENTE_AUTH_INCOMPATIBLE");
    }
    // No guardar nuevas credenciales y no crear ningún socket en esta fase.
    return Object.freeze({
      modo: "sin_red", autenticacionPreparada: true,
      socketCreado: false, whatsappConectado: false,
    });
  }

  async function consultarVersion() {
    if (modo !== "conexion") throw new Error("WA_PUENTE_RED_DESHABILITADA");
    const m = await biblioteca();
    // Deliberadamente no usar versiones hardcodeadas de otras fechas.
    // Se exige resultado verificado, sin intentar conectar si es desconocido.
    const v = await consultarVersionWeb(m);
    if (v?.isLatest !== true || !versionValida(v.version)) {
      throw new Error("WA_PUENTE_VERSION_NO_VERIFICADA");
    }
    return { version: [...v.version], isLatest: true };
  }

  async function fabricaSocket({ auth, version } = {}) {
    if (modo !== "conexion") throw new Error("WA_PUENTE_RED_DESHABILITADA");
    if (!auth?.creds || typeof auth.keys?.get !== "function" ||
        typeof auth.keys?.set !== "function" || !versionValida(version)) {
      throw new TypeError("WA_PUENTE_SOCKET_ARGUMENTOS_INVALIDOS");
    }
    const m = await biblioteca();
    // printQRInTerminal=false: los códigos QR nunca deben ir a logs.
    const sock = m.makeWASocket({
      auth, version, logger: m.logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    if (!sock?.ev || typeof sock.ev.on !== "function" ||
        typeof sock.ev.off !== "function" ||
        typeof sock.sendMessage !== "function" ||
        typeof sock.end !== "function") {
      if (typeof sock?.end === "function") sock.end(undefined);
      throw new Error("WA_PUENTE_SOCKET_INCOMPATIBLE");
    }
    const entrada = crearAdaptadorEntradaBaileys({
      eventos: sock.ev, bandeja,
    });
    entrada.iniciar();
    adaptadores.add(entrada);
    const endOriginal = sock.end.bind(sock);
    let cerrado = false;
    sock.end = (...args) => {
      if (cerrado) return;
      cerrado = true;
      adaptadores.delete(entrada);
      // La parada remueve el listener antes de que se reciban otros eventos.
      void entrada.detener().catch(() => {});
      return endOriginal(...args);
    };
    return sock;
  }

  async function detenerEntradas() {
    const activos = [...adaptadores];
    adaptadores.clear();
    await Promise.allSettled(activos.map(x => x.detener()));
  }

  return Object.freeze({
    comprobarSinRed, crearAuth, consultarVersion, fabricaSocket,
    detenerEntradas,
    conexionHabilitada: () => modo === "conexion",
  });
}
module.exports = { crearPuenteBaileysV3 };
