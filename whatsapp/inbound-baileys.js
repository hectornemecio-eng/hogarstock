"use strict";

// Frontera aislada de eventos entrantes Baileys V3.
// Solo procesa messages.upsert del EventEmitter de un socket autenticado
// previamente por el coordinador. NO es un endpoint ni una prueba
// criptografica de identidad del remitente; los vinculos de compra siguen
// requiriendo autorizacion administrativa y revision de propuestas.
const MAX_LOTE = 100;
const MAX_TEXTO_BYTES = 4096;

function remitenteTelefonico(jid) {
  // Grupos, estados, newsletters, LID y participantes no se transforman
  // implicitamente en telefonos: resolucion LID/PN pendiente y auditada.
  if (typeof jid !== "string") return null;
  const match = /^([0-9]{8,15})@s\.whatsapp\.net$/.exec(jid);
  return match ? match[1] : null;
}

function extraerTexto(msg) {
  let contenido = msg;
  if (contenido?.ephemeralMessage?.message) {
    contenido = contenido.ephemeralMessage.message;
  }
  if (!contenido || typeof contenido !== "object") return null;
  // Se rechaza cualquier multimodal, reaccion, edicion o protocolo.
  const tipos = Object.keys(contenido).filter((k) => k !== "messageContextInfo");
  if (tipos.length !== 1) return null;
  let texto;
  if (tipos[0] === "conversation") texto = contenido.conversation;
  else if (tipos[0] === "extendedTextMessage") {
    texto = contenido.extendedTextMessage?.text;
  } else return null;
  return typeof texto === "string" &&
    Buffer.byteLength(texto, "utf8") <= MAX_TEXTO_BYTES ? texto : null;
}

function crearAdaptadorEntradaBaileys({ eventos, bandeja } = {}) {
  if (!eventos || typeof eventos.on !== "function" ||
      typeof eventos.off !== "function" ||
      !bandeja || typeof bandeja.recibir !== "function") {
    throw new TypeError("WA_EVENTOS_DEPENDENCIAS_INVALIDAS");
  }
  let iniciado = false;
  const pendientes = new Set();
  const contadores = { aceptadas: 0, ignoradas: 0, errores: 0 };

  async function procesarPaquete(upsert) {
    if (!iniciado) return;
    // No consumir sincronizaciones historicas, sino notificaciones nuevas.
    if (!upsert || upsert.type !== "notify" ||
        !Array.isArray(upsert.messages) ||
        upsert.messages.length > MAX_LOTE) {
      contadores.ignoradas++;
      return;
    }
    for (const mensaje of upsert.messages) {
      if (!iniciado) break;
      const key = mensaje?.key;
      const telefono = remitenteTelefonico(key?.remoteJid);
      const id = key?.id;
      if (key?.fromMe !== false || !telefono ||
          typeof id !== "string" ||
          !/^[A-Za-z0-9_-]{4,160}$/.test(id) ||
          mensaje.messageStubType != null ||
          key.participant != null) {
        contadores.ignoradas++;
        continue;
      }
      const texto = extraerTexto(mensaje.message);
      if (texto === null) {
        contadores.ignoradas++;
        continue;
      }
      try {
        // Solo el resultado reducido; telefono, contenido, JID e ID del
        // proveedor NUNCA se registran ni se exponen en estado publico.
        await bandeja.recibir({ telefono, mensajeId: id, texto });
        contadores.aceptadas++;
      } catch (_) {
        contadores.errores++;
      }
    }
  }

  function listener(paquete) {
    const tarea = procesarPaquete(paquete);
    pendientes.add(tarea);
    void tarea.finally(() => pendientes.delete(tarea));
  }

  function iniciar() {
    if (iniciado) return false;
    iniciado = true;
    eventos.on("messages.upsert", listener);
    return true;
  }
  async function esperarPendientes() {
    // Los callbacks no se exponen al usuario y el drenaje no se espera
    // en la ruta HTTP: aqui solo se usa para pruebas y parada ordenada.
    while (pendientes.size) await Promise.allSettled([...pendientes]);
  }
  async function detener() {
    if (!iniciado) return;
    iniciado = false;
    eventos.off("messages.upsert", listener);
    await esperarPendientes();
  }

  return Object.freeze({
    iniciar, detener, esperarPendientes,
    estadisticas: () => Object.freeze({...contadores}),
  });
}

module.exports = { crearAdaptadorEntradaBaileys };
