"use strict";

// Coordinador de WhatsApp V3: transporte inyectado, sin credenciales reales.
// NO conecta por sí solo a WhatsApp, no importa Baileys y no se monta en server.js.
// La autenticación del administrador debe aplicarse ANTES de exponer leerEstadoPrivado().
// El resultado de sendMessage acredita como mucho aceptación por el proveedor,
// NUNCA recepción/lectura por el destinatario.

function crearCoordinadorWhatsApp({
  crearAuth, fabricaSocket, consultarVersion, destinatarioPermitido,
  programar = (f, ms) => setTimeout(f, ms),
  cancelar = (id) => clearTimeout(id),
  codigoSesionCerrada = 401,
  notificarEstado = () => {},
} = {}) {
  if (typeof crearAuth !== "function" || typeof fabricaSocket !== "function" ||
      typeof consultarVersion !== "function" ||
      typeof destinatarioPermitido !== "function" ||
      typeof programar !== "function" || typeof cancelar !== "function" ||
      typeof notificarEstado !== "function") {
    throw new TypeError("WA_COORDINADOR_DEPENDENCIAS_INVALIDAS");
  }

  let fase = "inactivo";
  let qr = null;
  let socket = null;
  let inicioPendiente = null;
  let timer = null;
  let intentos = 0;
  let detenido = false;
  let bloqueado = false;
  let errorCodigo = null;
  let secuencia = 0;
  let credencialesPendientes = Promise.resolve();

  const vistaPublica = () => Object.freeze({
    fase,
    conectado: fase === "conectado",
    errorCodigo,
  });
  // La llamada del método es una frontera de confianza: montar SOLO
  // detrás de autorización administrativa, jamás en rutas o WS públicos.
  const leerEstadoPrivado = () => Object.freeze({
    ...vistaPublica(),
    qr: fase === "esperando_qr" ? qr : null,
  });
  function publicar() {
    try { notificarEstado(vistaPublica()); } catch (_) { /* no afectar socket */ }
  }
  function faseNueva(nombre, codigo = null) {
    fase = nombre;
    errorCodigo = codigo;
    publicar();
  }
  function cancelarReconexion() {
    if (timer !== null) {
      cancelar(timer);
      timer = null;
    }
  }
  function liberarSocket() {
    const anterior = socket;
    socket = null;
    qr = null;
    if (anterior && typeof anterior.end === "function") {
      try { anterior.end(undefined); } catch (_) { /* cierre idempotente */ }
    }
  }
  function pararPorCredenciales() {
    bloqueado = true;
    secuencia++;
    cancelarReconexion();
    liberarSocket();
    faseNueva("bloqueado", "WA_CREDENCIALES_NO_PERSISTIDAS");
  }
  function agendarReconexion() {
    if (detenido || bloqueado || timer !== null) return;
    intentos++;
    const ms = Math.min(30_000 * (2 ** Math.min(intentos - 1, 3)), 300_000);
    faseNueva("reconexion_programada", "WA_CONEXION_CERRADA");
    timer = programar(() => {
      timer = null;
      if (!detenido && !bloqueado) void iniciar().catch(() => {});
    }, ms);
  }
  function codigoDesconexion(update) {
    const codigo = update?.lastDisconnect?.error?.output?.statusCode;
    return Number.isInteger(codigo) ? codigo : null;
  }
  async function iniciar() {
    if (detenido || bloqueado) throw new Error("WA_COORDINADOR_BLOQUEADO");
    if (inicioPendiente) return inicioPendiente;
    if (socket) return;
    cancelarReconexion();
    const epoch = ++secuencia;
    qr = null;
    faseNueva("iniciando");
    inicioPendiente = (async () => {
      try {
        const auth = await crearAuth();
        if (!auth?.state || typeof auth.saveCreds !== "function") {
          throw new Error("WA_AUTH_INVALIDA");
        }
        const v = await consultarVersion();
        const version = v?.version;
        if (v?.isLatest !== true ||
            !Array.isArray(version) || version.length !== 3 ||
            !version.every(n => Number.isInteger(n) && n >= 0)) {
          throw new Error("WA_VERSION_NO_VERIFICADA");
        }
        if (epoch !== secuencia || detenido || bloqueado) return;
        const nuevo = await fabricaSocket({ auth: auth.state, version });
        if (!nuevo?.ev || typeof nuevo.ev.on !== "function" ||
            typeof nuevo.sendMessage !== "function") {
          throw new Error("WA_SOCKET_INVALIDO");
        }
        if (epoch !== secuencia || detenido || bloqueado) {
          if (typeof nuevo.end === "function") nuevo.end(undefined);
          return;
        }
        socket = nuevo;
        nuevo.ev.on("creds.update", () => {
          if (socket !== nuevo || detenido || bloqueado) return;
          const trabajo = credencialesPendientes.then(() => auth.saveCreds());
          credencialesPendientes = trabajo.catch(() => {
            if (socket === nuevo) pararPorCredenciales();
          });
        });
        nuevo.ev.on("connection.update", (update = {}) => {
          if (socket !== nuevo || detenido || bloqueado) return;
          if (typeof update.qr === "string" && update.qr.length) {
            qr = update.qr;
            faseNueva("esperando_qr");
          }
          if (update.connection === "open") {
            qr = null;
            intentos = 0;
            cancelarReconexion();
            faseNueva("conectado");
          } else if (update.connection === "close") {
            qr = null;
            if (codigoDesconexion(update) === codigoSesionCerrada) {
              bloqueado = true;
              secuencia++;
              liberarSocket();
              cancelarReconexion();
              faseNueva("bloqueado", "WA_SESION_CERRADA");
            } else {
              secuencia++;
              liberarSocket();
              agendarReconexion();
            }
          }
        });
        faseNueva("conectando");
      } catch (_) {
        // No registrar errores crudos: algunas librerías incluyen URL,
        // identificadores de sesión, claves o QR en las excepciones.
        if (!detenido && !bloqueado && epoch === secuencia) {
          agendarReconexion();
        }
      }
    })();
    try { await inicioPendiente; }
    finally { inicioPendiente = null; }
  }

  function normalizarTelefono(telefono) {
    if (typeof telefono !== "string") throw new TypeError("WA_DESTINATARIO_INVALIDO");
    const numero = telefono.replace(/[\s()+-]/g, "");
    if (!/^[0-9]{8,15}$/.test(numero)) throw new TypeError("WA_DESTINATARIO_INVALIDO");
    return numero;
  }

  async function enviarInterno({ telefono, mensaje } = {}, incluirReferencia = false) {
    // NO pasar teléfonos o mensajes a logs, callbacks de estado ni excepciones.
    const numero = normalizarTelefono(telefono);
    if (typeof mensaje !== "string" || !mensaje.trim() ||
        Buffer.byteLength(mensaje, "utf8") > 4096) {
      throw new TypeError("WA_MENSAJE_INVALIDO");
    }
    if (detenido || bloqueado || fase !== "conectado" || !socket) {
      return { estado: "no_iniciado", codigo: "WA_NO_CONECTADO" };
    }
    if (!(await destinatarioPermitido(numero))) {
      return { estado: "rechazado", codigo: "WA_DESTINATARIO_NO_AUTORIZADO" };
    }
    const activo = socket;
    try {
      const respuesta = await activo.sendMessage(
        numero + "@s.whatsapp.net", { text: mensaje }
      );
      if (socket !== activo || detenido || bloqueado) {
        return { estado: "indeterminado", codigo: "WA_CONEXION_CAMBIO_DURANTE_ENVIO" };
      }
      const id = respuesta?.key?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{4,160}$/.test(id)) {
        return { estado: "indeterminado", codigo: "WA_SIN_ACUSE_DEL_PROVEEDOR" };
      }
      const resultado = {
        estado: "aceptado_por_proveedor",
        codigo: "WA_PROVEEDOR_ACEPTO_SOLICITUD",
        entregado: false,
      };
      // Referencia exclusivamente para la capa interna; nunca mostrarla
      // directamente en HTTP, WebSocket, interfaz o logs.
      return incluirReferencia ? {...resultado, proveedorId: id} : resultado;
    } catch (_) {
      // Puede haber sido enviado justo antes de una caída de conexión.
      // No reintentar automáticamente: riesgo de mensajes duplicados.
      return { estado: "indeterminado", codigo: "WA_ENVIO_NO_VERIFICABLE" };
    }
  }
  async function enviarTexto(datos) { return enviarInterno(datos, false); }
  async function enviarTextoParaRegistro(datos) { return enviarInterno(datos, true); }
  async function detener() {
    detenido = true;
    secuencia++;
    cancelarReconexion();
    liberarSocket();
    await credencialesPendientes;
    faseNueva("detenido");
  }

  return Object.freeze({
    iniciar,
    detener,
    enviarTexto,
    enviarTextoParaRegistro,
    leerEstadoPublico: vistaPublica,
    leerEstadoPrivado,
  });
}

module.exports = { crearCoordinadorWhatsApp };
