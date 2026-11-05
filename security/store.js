"use strict";

// Adaptador SQLite/libSQL de autorizaciones HogarStock V3.
// Se requiere un cliente con execute({sql,args}); no se conectan servicios reales.

const TABLAS = Object.freeze({
  admin: "hogarstock_admin_sessions_v3",
  compra: "hogarstock_purchase_grants_v3",
});

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hogarstock_admin_sessions_v3 (" +
    "huella TEXT PRIMARY KEY NOT NULL, " +
    "creado INTEGER NOT NULL, expira INTEGER NOT NULL, revocado INTEGER)",
  "CREATE TABLE IF NOT EXISTS hogarstock_purchase_grants_v3 (" +
    "huella TEXT PRIMARY KEY NOT NULL, compra_id TEXT NOT NULL, " +
    "creado INTEGER NOT NULL, expira INTEGER NOT NULL, revocado INTEGER)",
];
const INDICES = [
  "CREATE INDEX IF NOT EXISTS idx_admin_sessions_v3_expira ON hogarstock_admin_sessions_v3(expira)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_grants_v3_expira ON hogarstock_purchase_grants_v3(expira)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_grants_v3_compra ON hogarstock_purchase_grants_v3(compra_id)",
];

function validarHuella(huella) {
  if (typeof huella !== "string" || !/^[0-9a-f]{64}$/.test(huella)) {
    throw new TypeError("Huella de token invalida");
  }
}
function validarInstante(instante) {
  if (!Number.isSafeInteger(instante) || instante < 0) {
    throw new TypeError("Fecha de autorizacion invalida");
  }
}

function crearAlmacenSeguridad(cliente) {
  if (!cliente || typeof cliente.execute !== "function") {
    throw new TypeError("Se necesita un cliente SQLite/libSQL con metodo execute()");
  }
  let inicializado = false;
  function exigirInicializacion() {
    if (!inicializado) {
      throw new Error("ALMACEN_NO_INICIALIZADO: ejecutar init() antes de usar el almacen");
    }
  }
  async function ejecutar(sql, args = []) {
    return cliente.execute({ sql, args });
  }
  async function verificarTabla(tabla, esperadas) {
    const datos = await cliente.execute("PRAGMA table_info(" + tabla + ")");
    const columnas = new Map(datos.rows.map((c) => [String(c.name), c]));
    const faltantes = esperadas.filter((nombre) => !columnas.has(nombre));
    if (faltantes.length > 0) {
      throw new Error(
        "ESQUEMA_SEGURIDAD_INCOMPATIBLE: " + tabla +
        " sin las columnas " + faltantes.join(", ") +
        ". Se requiere migracion explicita; no se borraran datos."
      );
    }
    if (Number(columnas.get("huella").pk) !== 1) {
      throw new Error(
        "ESQUEMA_SEGURIDAD_INCOMPATIBLE: " + tabla +
        " requiere huella como clave primaria; no se borraran datos."
      );
    }
  }
  async function init() {
    // Una tabla incompatible existente no se borra ni se reemplaza.
    for (const sentencia of SCHEMA) {
      await cliente.execute(sentencia);
    }
    await verificarTabla(TABLAS.admin, ["huella", "creado", "expira", "revocado"]);
    await verificarTabla(TABLAS.compra, ["huella", "compra_id", "creado", "expira", "revocado"]);
    for (const sentencia of INDICES) {
      await cliente.execute(sentencia);
    }
    inicializado = true;
  }
  async function guardarSesionAdmin({ huella, creado, expira }) {
    exigirInicializacion();
    validarHuella(huella);
    validarInstante(creado);
    validarInstante(expira);
    if (expira <= creado) throw new RangeError("Caducidad invalida");
    await ejecutar(
      "INSERT INTO hogarstock_admin_sessions_v3 (huella, creado, expira, revocado) VALUES (?, ?, ?, NULL)",
      [huella, creado, expira]
    );
  }
  async function leerSesionAdmin({ huella }) {
    exigirInicializacion();
    if (typeof huella !== "string" || !/^[0-9a-f]{64}$/.test(huella)) return null;
    const respuesta = await ejecutar(
      "SELECT huella, creado, expira, revocado FROM hogarstock_admin_sessions_v3 WHERE huella = ? LIMIT 1",
      [huella]
    );
    return respuesta.rows[0] ?? null;
  }
  async function revocarSesionAdmin({ huella, revocado }) {
    exigirInicializacion();
    validarHuella(huella);
    validarInstante(revocado);
    await ejecutar(
      "UPDATE hogarstock_admin_sessions_v3 SET revocado = ? WHERE huella = ? AND revocado IS NULL",
      [revocado, huella]
    );
  }
  async function guardarPermisoCompra({ huella, compraId, creado, expira }) {
    exigirInicializacion();
    validarHuella(huella);
    validarInstante(creado);
    validarInstante(expira);
    const id = String(compraId);
    if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new TypeError("ID de compra invalido");
    }
    if (expira <= creado) throw new RangeError("Caducidad invalida");
    await ejecutar(
      "INSERT INTO hogarstock_purchase_grants_v3 (huella, compra_id, creado, expira, revocado) VALUES (?, ?, ?, ?, NULL)",
      [huella, id, creado, expira]
    );
  }
  async function leerPermisoCompra({ huella }) {
    exigirInicializacion();
    if (typeof huella !== "string" || !/^[0-9a-f]{64}$/.test(huella)) return null;
    const respuesta = await ejecutar(
      "SELECT huella, compra_id AS compraId, creado, expira, revocado FROM hogarstock_purchase_grants_v3 WHERE huella = ? LIMIT 1",
      [huella]
    );
    return respuesta.rows[0] ?? null;
  }
  async function revocarPermisoCompra({ huella, revocado }) {
    exigirInicializacion();
    validarHuella(huella);
    validarInstante(revocado);
    await ejecutar(
      "UPDATE hogarstock_purchase_grants_v3 SET revocado = ? WHERE huella = ? AND revocado IS NULL",
      [revocado, huella]
    );
  }
  // La eliminacion de expirados se planificara por separado con respaldo.
  return Object.freeze({
    init,
    guardarSesionAdmin,
    leerSesionAdmin,
    revocarSesionAdmin,
    guardarPermisoCompra,
    leerPermisoCompra,
    revocarPermisoCompra,
  });
}

module.exports = { crearAlmacenSeguridad };
