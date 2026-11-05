"use strict";

// Canje de invitaciones y sesiones de comprador V3.
// Modulo aislado: no monta rutas ni usa credenciales de produccion.
// La invitacion se consume una sola vez mediante una transaccion de escritura.
const { randomBytes } = require("node:crypto");
const { huellaToken } = require("./access.js");

const TABLA = "hogarstock_buyer_sessions_v3";
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function idValido(valor) {
  const id = String(valor);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new TypeError("ID_COMPRA_INVALIDO");
  }
  return id;
}

function tiempoValido(valor) {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new Error("RELOJ_INVALIDO");
  }
  return valor;
}

function ttlValido(valor) {
  if (!Number.isSafeInteger(valor) || valor < 60000 || valor > MAX_TTL_MS) {
    throw new RangeError("TTL_INVALIDO");
  }
  return valor;
}

async function transaccion(cliente, tarea) {
  const tx = await cliente.transaction("write");
  try {
    const resultado = await tarea(tx);
    await tx.commit();
    return resultado;
  } catch (error) {
    try { await tx.rollback(); } catch (_) { /* no esconder error original */ }
    throw error;
  } finally {
    tx.close();
  }
}

function crearSesionesComprador({ cliente, reloj = Date.now }) {
  if (!cliente || typeof cliente.execute !== "function" ||
      typeof cliente.transaction !== "function") {
    throw new TypeError("Cliente libSQL incompleto");
  }
  if (typeof reloj !== "function") throw new TypeError("Reloj invalido");
  let listo = false;
  const ahora = () => tiempoValido(reloj());

  async function comprobarTabla(nombre, requeridas) {
    const resultado = await cliente.execute("PRAGMA table_info(" + nombre + ")");
    const mapa = new Map(resultado.rows.map((r) => [String(r.name), r]));
    if (!mapa.size) return false;
    const faltan = requeridas.filter((r) => !mapa.has(r));
    if (faltan.length || Number(mapa.get("huella")?.pk) !== (nombre === TABLA ? 1 : Number(mapa.get("huella")?.pk))) {
      throw new Error("ESQUEMA_SESIONES_COMPRADOR_INCOMPATIBLE:" + nombre);
    }
    return true;
  }

  async function init() {
    await comprobarTabla("hogarstock_purchase_grants_v3", [
      "huella", "compra_id", "creado", "expira", "revocado",
    ]);
    const grants = await cliente.execute(
      "PRAGMA table_info(hogarstock_purchase_grants_v3)"
    );
    if (!grants.rows.length) {
      throw new Error("ESQUEMA_INVITACIONES_NO_INICIALIZADO");
    }
    const compras = await cliente.execute("PRAGMA table_info(hogarstock_compras_v3)");
    if (!compras.rows.some((r) => String(r.name) === "estado")) {
      throw new Error("ESQUEMA_COMPRAS_NO_INICIALIZADO");
    }
    await comprobarTabla(TABLA, [
      "huella", "compra_id", "creado", "expira", "revocado",
    ]);
    await cliente.execute(
      "CREATE TABLE IF NOT EXISTS " + TABLA + " (" +
        "huella TEXT PRIMARY KEY NOT NULL, compra_id TEXT NOT NULL, " +
        "creado INTEGER NOT NULL, expira INTEGER NOT NULL, revocado INTEGER)"
    );
    const result = await cliente.execute("PRAGMA table_info(" + TABLA + ")");
    const columnas = new Map(result.rows.map((r) => [String(r.name), r]));
    for (const nombre of ["huella", "compra_id", "creado", "expira", "revocado"]) {
      if (!columnas.has(nombre)) {
        throw new Error("ESQUEMA_SESIONES_COMPRADOR_INCOMPATIBLE");
      }
    }
    if (Number(columnas.get("huella").pk) !== 1) {
      throw new Error("ESQUEMA_SESIONES_COMPRADOR_INCOMPATIBLE");
    }
    await cliente.execute(
      "CREATE INDEX IF NOT EXISTS idx_hs_buyer_sessions_v3_compra " +
      "ON " + TABLA + "(compra_id)"
    );
    listo = true;
  }

  function exigirInit() {
    if (!listo) throw new Error("SESIONES_COMPRADOR_NO_INICIALIZADAS");
  }

  async function canjearInvitacion({ compraId, invitacion, ttlMs = 12 * 60 * 60 * 1000 }) {
    exigirInit();
    const id = idValido(compraId);
    ttlValido(ttlMs);
    const huella = huellaToken(invitacion);
    if (!huella) throw new Error("INVITACION_INVALIDA");
    return transaccion(cliente, async (tx) => {
      const fecha = ahora();
      const permiso = await tx.execute({
        sql: "SELECT huella,compra_id,expira,revocado " +
          "FROM hogarstock_purchase_grants_v3 WHERE huella=? LIMIT 1",
        args: [huella],
      });
      const p = permiso.rows[0];
      if (!p || String(p.compra_id) !== id || p.revocado != null ||
          Number(p.expira) <= fecha) {
        throw new Error("INVITACION_INVALIDA");
      }
      const compra = await tx.execute({
        sql: "SELECT estado FROM hogarstock_compras_v3 WHERE id=? LIMIT 1",
        args: [Number(id)],
      });
      if (compra.rows[0]?.estado !== "abierta") {
        throw new Error("INVITACION_INVALIDA");
      }
      const invalidacion = await tx.execute({
        sql: "UPDATE hogarstock_purchase_grants_v3 SET revocado=? " +
          "WHERE huella=? AND compra_id=? AND revocado IS NULL AND expira>?",
        args: [fecha, huella, id, fecha],
      });
      if (Number(invalidacion.rowsAffected) !== 1) {
        throw new Error("INVITACION_INVALIDA");
      }
      const sesion = randomBytes(32).toString("base64url");
      const vencimiento = Math.min(Number(p.expira), fecha + ttlMs);
      if (vencimiento <= fecha) throw new Error("INVITACION_INVALIDA");
      await tx.execute({
        sql: "INSERT INTO " + TABLA +
          " (huella,compra_id,creado,expira,revocado) VALUES (?,?,?,?,NULL)",
        args: [huellaToken(sesion), id, fecha, vencimiento],
      });
      return { sesion, compraId: Number(id), expira: vencimiento };
    });
  }

  async function autorizarSesion({ compraId, sesion }) {
    exigirInit();
    let id;
    try { id = idValido(compraId); } catch (_) { return false; }
    const huella = huellaToken(sesion);
    if (!huella) return false;
    const resultado = await cliente.execute({
      sql: "SELECT expira,revocado FROM " + TABLA +
        " WHERE huella=? AND compra_id=? LIMIT 1",
      args: [huella, id],
    });
    const fila = resultado.rows[0];
    return Boolean(fila && fila.revocado == null && Number(fila.expira) > ahora());
  }

  async function revocarSesion({ compraId, sesion }) {
    exigirInit();
    const id = idValido(compraId);
    const huella = huellaToken(sesion);
    if (!huella) return false;
    const cambio = await cliente.execute({
      sql: "UPDATE " + TABLA +
        " SET revocado=? WHERE huella=? AND compra_id=? AND revocado IS NULL",
      args: [ahora(), huella, id],
    });
    return Number(cambio.rowsAffected) === 1;
  }

  return Object.freeze({ init, canjearInvitacion, autorizarSesion, revocarSesion });
}

module.exports = { crearSesionesComprador };
