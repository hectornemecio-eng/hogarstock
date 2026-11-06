"use strict";

// Nucleo de autenticacion y autorizacion de HogarStock V3.
// Este modulo NO activa rutas ni modifica el servidor de produccion.
const {
  randomBytes,
  scryptSync,
  createHash,
  timingSafeEqual,
} = require("node:crypto");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_BYTES = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const TOKEN_BYTES = 32;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function comprobarContrasena(contrasena) {
  if (
    typeof contrasena !== "string" ||
    contrasena.length < 12 ||
    Buffer.byteLength(contrasena, "utf8") > 1024
  ) {
    throw new TypeError("La contrasena debe tener al menos 12 caracteres y un maximo de 1024 bytes");
  }
}

function crearHashContrasena(contrasena, sal) {
  comprobarContrasena(contrasena);
  const salt = sal === undefined ? randomBytes(16) : Buffer.from(sal);
  if (salt.length !== 16) throw new TypeError("Sal incorrecta");
  const derivada = scryptSync(contrasena, salt, SCRYPT_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("hex"),
    derivada.toString("hex"),
  ].join(":");
}

function parsearHashContrasena(formato) {
  if (typeof formato !== "string") return null;
  const partes = formato.split(":");
  if (partes.length !== 6 ||
      partes[0] !== "scrypt" ||
      partes[1] !== String(SCRYPT_N) ||
      partes[2] !== String(SCRYPT_R) ||
      partes[3] !== String(SCRYPT_P) ||
      !/^[a-f0-9]{32}$/.test(partes[4]) ||
      !/^[a-f0-9]{128}$/.test(partes[5])) {
    return null;
  }
  return {
    salt: Buffer.from(partes[4], "hex"),
    hash: Buffer.from(partes[5], "hex"),
  };
}

function verificarContrasena(contrasena, formato) {
  if (typeof contrasena !== "string" ||
      Buffer.byteLength(contrasena, "utf8") > 1024) return false;
  const datos = parsearHashContrasena(formato);
  if (!datos) return false;
  const intento = scryptSync(contrasena, datos.salt, SCRYPT_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(intento, datos.hash);
}

function huellaToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return null;
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function verificarDuracion(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TTL_MS) {
    throw new RangeError("Duracion de autorizacion fuera de los limites permitidos");
  }
}

function verificarIdCompra(compraId) {
  const id = String(compraId);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new TypeError("Identificador de compra no valido");
  }
  return id;
}

function comprobarAlmacen(almacen) {
  const funciones = [
    "guardarSesionAdmin",
    "leerSesionAdmin",
    "revocarSesionAdmin",
    "guardarPermisoCompra",
    "leerPermisoCompra",
    "revocarPermisoCompra",
  ];
  if (!almacen || funciones.some((nombre) => typeof almacen[nombre] !== "function")) {
    throw new TypeError("Almacen de autorizaciones incompleto");
  }
}

function crearServicioAcceso({ almacen, hashAdministrador, credenciales = null, reloj = Date.now }) {
  comprobarAlmacen(almacen);
  if (!parsearHashContrasena(hashAdministrador)) {
    throw new Error("HOGARSTOCK_ADMIN_PASSWORD_HASH ausente o invalido; acceso bloqueado");
  }
  if (typeof reloj !== "function") throw new TypeError("Reloj no valido");
  if(credenciales && (typeof credenciales.leerHash!=="function" || typeof credenciales.cambiar!=="function")){
    throw new TypeError("ADMIN_CREDENCIALES_SERVICIO_INVALIDO");
  }

  const instante = () => {
    const ahora = reloj();
    if (!Number.isSafeInteger(ahora) || ahora < 0) {
      throw new Error("Reloj del sistema no valido");
    }
    return ahora;
  };

  async function iniciarSesionAdmin({ contrasena, ttlMs }) {
    verificarDuracion(ttlMs);
    const hashActual=credenciales?await credenciales.leerHash():hashAdministrador;
    if (!verificarContrasena(contrasena, hashActual)) {
      return null;
    }
    const creado = instante();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expira = creado + ttlMs;
    await almacen.guardarSesionAdmin({
      huella: huellaToken(token), creado, expira,
    });
    return { token, expira };
  }

  async function autorizarAdmin({ token }) {
    const huella = huellaToken(token);
    if (!huella) return false;
    const sesion = await almacen.leerSesionAdmin({ huella });
    return Boolean(sesion && sesion.revocado == null && sesion.expira > instante());
  }

  async function cerrarSesionAdmin({ token }) {
    const huella = huellaToken(token);
    if (!huella) return false;
    await almacen.revocarSesionAdmin({ huella, revocado: instante() });
    return true;
  }

  // Este metodo debe llamarse UNICAMENTE desde una ruta autenticada
  // que haya comprobado que la compra existe y pertenece al contexto debido.
  async function emitirPermisoCompra({ compraId, ttlMs }) {
    verificarDuracion(ttlMs);
    const id = verificarIdCompra(compraId);
    const creado = instante();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expira = creado + ttlMs;
    await almacen.guardarPermisoCompra({
      huella: huellaToken(token), compraId: id, creado, expira,
    });
    return { token, compraId: id, expira };
  }

  async function autorizarCompra({ compraId, token }) {
    let id;
    try {
      id = verificarIdCompra(compraId);
    } catch (_) {
      return false;
    }
    const huella = huellaToken(token);
    if (!huella) return false;
    const permiso = await almacen.leerPermisoCompra({ huella });
    return Boolean(
      permiso &&
      String(permiso.compraId) === id &&
      permiso.revocado == null &&
      permiso.expira > instante()
    );
  }

  async function revocarPermisoCompra({ token }) {
    const huella = huellaToken(token);
    if (!huella) return false;
    await almacen.revocarPermisoCompra({ huella, revocado: instante() });
    return true;
  }

  async function cambiarContrasenaAdmin({token,contrasenaActual,contrasenaNueva}){
    if(!credenciales)throw new Error("ADMIN_CAMBIO_NO_CONFIGURADO");
    comprobarContrasena(contrasenaNueva);
    if(typeof contrasenaActual!=="string")throw new TypeError("CONTRASENA_ACTUAL_INVALIDA");
    const huellaSesion=huellaToken(token);
    if(!huellaSesion)return {estado:"sesion_no_valida"};
    const nuevoHash=crearHashContrasena(contrasenaNueva);
    return credenciales.cambiar({huellaSesion,contrasenaActual,nuevoHash});
  }

  return Object.freeze({
    iniciarSesionAdmin,
    autorizarAdmin,
    cerrarSesionAdmin,
    ...(credenciales?{cambiarContrasenaAdmin}:{}),
    emitirPermisoCompra,
    autorizarCompra,
    revocarPermisoCompra,
  });
}

module.exports = {
  crearHashContrasena,
  verificarContrasena,
  huellaToken,
  crearServicioAcceso,
};
