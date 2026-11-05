"use strict";

// Adaptador experimental de credenciales y claves Baileys en libSQL.
// NO se conecta a WhatsApp; NO se monta en server.js.
// Nunca migrar la sesion real sin respaldo restaurado y pruebas de compatibilidad.
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");

const TABLA = "hogarstock_wa_auth_v3";
const AAD_PREFIX = "HogarStock:Baileys:auth:v3";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BATCH = 1500;

function claveMaestra(hex) {
  if (typeof hex !== "string" || !/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error("WA_MASTER_KEY_INVALIDA: se requieren exactamente 32 bytes en hex");
  }
  return Buffer.from(hex, "hex");
}

function nombreSeguro(valor, nombre) {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(valor)) {
    throw new TypeError(nombre + " no valido");
  }
  return valor;
}

function aad(tipo, id) {
  return Buffer.from(JSON.stringify([AAD_PREFIX, tipo, id]), "utf8");
}

function crearCifrador(masterKey) {
  function cifrar(objeto, tipo, id, codec) {
    const json = JSON.stringify(objeto, codec.replacer);
    if (typeof json !== "string") throw new Error("WA_DATO_NO_SERIALIZABLE");
    const plano = Buffer.from(json, "utf8");
    if (!plano.length || plano.length > MAX_JSON_BYTES) {
      throw new Error("WA_DATO_TAMANO_INVALIDO");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    cipher.setAAD(aad(tipo, id));
    const ciphertext = Buffer.concat([cipher.update(plano), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: ciphertext.toString("base64"),
    });
  }

  function descifrar(valor, tipo, id, codec) {
    try {
      const paquete = JSON.parse(valor);
      if (!paquete || paquete.v !== 1 ||
          !/^[A-Za-z0-9+/=]+$/.test(paquete.iv || "") ||
          !/^[A-Za-z0-9+/=]+$/.test(paquete.tag || "") ||
          !/^[A-Za-z0-9+/=]+$/.test(paquete.data || "")) {
        throw new Error("Formato cifrado invalido");
      }
      const iv = Buffer.from(paquete.iv, "base64");
      const tag = Buffer.from(paquete.tag, "base64");
      const data = Buffer.from(paquete.data, "base64");
      if (iv.length !== 12 || tag.length !== 16 || !data.length ||
          data.length > MAX_JSON_BYTES + 128) {
        throw new Error("Paquete de cifrado invalido");
      }
      const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
      decipher.setAAD(aad(tipo, id));
      decipher.setAuthTag(tag);
      const plano = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(plano.toString("utf8"), codec.reviver);
    } catch (_) {
      // Evitar que se expongan contraseñas, claves, ciphertext o trazas al frontend.
      throw new Error("WA_AUTH_NO_DESCIFRABLE: clave equivocada o registro corrupto");
    }
  }
  return { cifrar, descifrar };
}

function comprobarCodec(codec) {
  if (!codec || typeof codec.replacer !== "function" ||
      typeof codec.reviver !== "function") {
    throw new TypeError("Se requiere BufferJSON.replacer y BufferJSON.reviver de Baileys");
  }
}

async function crearEstadoBaileysCifrado({
  cliente, masterKeyHex, BufferJSON, initAuthCreds,
  reviveAppStateSyncKey = (value) => value,
}) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.batch !== "function") {
    throw new TypeError("Cliente libSQL incompleto");
  }
  comprobarCodec(BufferJSON);
  if (typeof initAuthCreds !== "function" ||
      typeof reviveAppStateSyncKey !== "function") {
    throw new TypeError("Adaptadores de Baileys invalidos");
  }
  const crypto = crearCifrador(claveMaestra(masterKeyHex));

  const previo = await cliente.execute("PRAGMA table_info(" + TABLA + ")");
  if (previo.rows.length) {
    const mapa = new Map(previo.rows.map(r => [String(r.name), r]));
    const necesarias = ["tipo", "identificador", "contenido", "actualizado"];
    if (necesarias.some(c => !mapa.has(c)) ||
        Number(mapa.get("tipo").pk) !== 1 ||
        Number(mapa.get("identificador").pk) !== 2) {
      throw new Error("WA_AUTH_ESQUEMA_INCOMPATIBLE: no se borra ni migra la tabla");
    }
  }

  await cliente.execute(
    "CREATE TABLE IF NOT EXISTS " + TABLA + " (" +
    "tipo TEXT NOT NULL, identificador TEXT NOT NULL," +
    "contenido TEXT NOT NULL, actualizado INTEGER NOT NULL," +
    "PRIMARY KEY (tipo, identificador))"
  );

  async function leer(tipo, id) {
    nombreSeguro(tipo, "tipo");
    nombreSeguro(id, "identificador");
    const respuesta = await cliente.execute({
      sql: "SELECT contenido FROM " + TABLA +
        " WHERE tipo=? AND identificador=? LIMIT 1",
      args: [tipo, id],
    });
    if (!respuesta.rows.length) return null;
    return crypto.descifrar(String(respuesta.rows[0].contenido), tipo, id, BufferJSON);
  }

  async function persistirLote(datos) {
    if (!Array.isArray(datos) || !datos.length || datos.length > MAX_BATCH) {
      throw new TypeError("Lote Signal invalido");
    }
    // Preparar todo el cifrado ANTES de escribir. batch(write) es atomico.
    const ahora = Date.now();
    const instrucciones = datos.map(({ tipo, id, valor }) => {
      nombreSeguro(tipo, "tipo");
      nombreSeguro(id, "identificador");
      if (valor === null || valor === undefined) {
        return {
          sql: "DELETE FROM " + TABLA +
            " WHERE tipo=? AND identificador=?",
          args: [tipo, id],
        };
      }
      const contenido = crypto.cifrar(valor, tipo, id, BufferJSON);
      return {
        sql: "INSERT INTO " + TABLA +
          " (tipo,identificador,contenido,actualizado) VALUES (?,?,?,?) " +
          "ON CONFLICT(tipo,identificador) DO UPDATE SET " +
          "contenido=excluded.contenido,actualizado=excluded.actualizado",
        args: [tipo, id, contenido, ahora],
      };
    });
    await cliente.batch(instrucciones, "write");
  }

  // Una cola unica garantiza que las escrituras no se reordenen y
  // que una lectura posterior espere las actualizaciones ya solicitadas.
  let cola = Promise.resolve();
  function encolarOperacion(tarea) {
    const trabajo = cola.then(tarea);
    cola = trabajo.catch(() => {});
    return trabajo;
  }
  async function esperarEscrituras() {
    await cola;
  }

  let creds = await leer("creds", "principal");
  if (creds === null) creds = initAuthCreds();
  if (!creds || typeof creds !== "object") {
    throw new Error("WA_CREDENCIALES_INVALIDAS");
  }

  const saveCreds = () => encolarOperacion(() =>
    persistirLote([{ tipo: "creds", id: "principal", valor: creds }])
  );

  const keys = {
    async get(type, ids) {
      nombreSeguro(type, "tipo");
      if (!Array.isArray(ids) || ids.length > MAX_BATCH) {
        throw new TypeError("IDs Signal invalidos");
      }
      await esperarEscrituras();
      const result = Object.create(null);
      for (const id of ids) {
        nombreSeguro(id, "id Signal");
        let value = await leer(type, id);
        if (type === "app-state-sync-key" && value !== null) {
          value = reviveAppStateSyncKey(value);
        }
        result[id] = value === null ? undefined : value;
      }
      return result;
    },
    async set(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new TypeError("Actualizacion Signal invalida");
      }
      const cambios = [];
      for (const [tipo, items] of Object.entries(data)) {
        nombreSeguro(tipo, "tipo");
        if (!items || typeof items !== "object" || Array.isArray(items)) {
          throw new TypeError("Claves Signal invalidas");
        }
        for (const [id, valor] of Object.entries(items)) {
          cambios.push({ tipo, id, valor });
          if (cambios.length > MAX_BATCH) throw new TypeError("Lote Signal demasiado grande");
        }
      }
      if (cambios.length) await encolarOperacion(() => persistirLote(cambios));
    },
  };

  return Object.freeze({
    state: { creds, keys },
    saveCreds,
  });
}

module.exports = { crearEstadoBaileysCifrado };
