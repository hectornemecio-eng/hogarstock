"use strict";

// Persistencia RESTRINGIDA A STAGING FICTICIO. No red, no Turso ni WhatsApp.
// No borra, sobrescribe ni restaura sobre bases existentes.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { createClient } = require("@libsql/client");
const MARCA = ".hogarstock-v3-staging.json";
const DB = "v3-ficticia.sqlite";
const TIPO = "HOGARSTOCK_V3_STAGING_FICTICIO_V1";
const BACKUP_RE = /^backup-[0-9]{13}-[0-9a-f]{16}\.sqlite$/;

function validarRuta(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("V3_PERSISTENCIA_RUTA_ABSOLUTA_REQUERIDA");
  }
  const normal = path.resolve(dir);
  const raizRepositorio = path.resolve(__dirname, "..");
  const relativo = path.relative(raizRepositorio, normal);
  if (!path.isAbsolute(relativo) &&
      (relativo === "" ||
       (relativo !== ".." && !relativo.startsWith(".." + path.sep)))) {
    throw new Error("V3_PERSISTENCIA_DENTRO_REPOSITORIO");
  }
  if (normal === path.parse(normal).root) {
    throw new Error("V3_PERSISTENCIA_RAIZ_PROHIBIDA");
  }
  // Rechazar enlaces simbolicos existentes en toda la cadena de directorios.
  let p = normal;
  while (true) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) {
      throw new Error("V3_PERSISTENCIA_ENLACE_PROHIBIDO");
    }
    const siguiente = path.dirname(p);
    if (siguiente === p) break;
    p = siguiente;
  }
  return normal;
}
function rutaDB(dir) { return path.join(dir, DB); }
function leerMarca(dir) {
  const m = path.join(dir, MARCA);
  if (!fs.existsSync(m) || fs.lstatSync(m).isSymbolicLink()) {
    throw new Error("V3_PERSISTENCIA_MARCA_AUSENTE");
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(m, "utf8")); }
  catch (_) { throw new Error("V3_PERSISTENCIA_MARCA_INVALIDA"); }
  if (doc.tipo !== TIPO || doc.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(doc.id || "")) {
    throw new Error("V3_PERSISTENCIA_MARCA_INVALIDA");
  }
  return doc;
}
function crearMarca(dir, atributos = {}) {
  const documento = {
    tipo: TIPO, version: 1, id: randomBytes(16).toString("hex"),
    ...atributos,
  };
  fs.writeFileSync(path.join(dir, MARCA),
    JSON.stringify(documento, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function prepararCarpeta(dir) {
  const normal = validarRuta(dir);
  if (!fs.existsSync(normal)) {
    fs.mkdirSync(normal); // padre preexistente; sin recursive
  }
  if (!fs.statSync(normal).isDirectory()) {
    throw new Error("V3_PERSISTENCIA_NO_ES_DIRECTORIO");
  }
  const archivos = fs.readdirSync(normal);
  const existeMarca = archivos.includes(MARCA);
  const existeDB = archivos.includes(DB);
  if (!existeMarca) {
    if (archivos.length !== 0) {
      throw new Error("V3_PERSISTENCIA_DIRECTORIO_AJENO");
    }
    crearMarca(normal);
    return { directorio: normal, nuevo: true, db: rutaDB(normal) };
  }
  leerMarca(normal);
  if (!existeDB || fs.lstatSync(rutaDB(normal)).isSymbolicLink() ||
      !fs.statSync(rutaDB(normal)).isFile()) {
    throw new Error("V3_PERSISTENCIA_DB_INEXISTENTE");
  }
  return { directorio: normal, nuevo: false, db: rutaDB(normal) };
}
async function inspeccionarCliente(cliente) {
  const integridad = await cliente.execute("PRAGMA integrity_check");
  if (String(integridad.rows[0]?.integrity_check) !== "ok") {
    throw new Error("V3_PERSISTENCIA_INTEGRIDAD_INCORRECTA");
  }
  const esquema = await cliente.execute("PRAGMA table_info(productos)");
  const columnas = new Map(esquema.rows.map(r => [String(r.name), r]));
  if (["id", "nombre", "categoria", "agotado"].some(c => !columnas.has(c)) ||
      Number(columnas.get("id").pk) !== 1) {
    throw new Error("V3_PERSISTENCIA_ESQUEMA_INCORRECTO");
  }
}
async function abrirPersistencia(dir) {
  const previo = prepararCarpeta(dir);
  const cliente = createClient({ url: "file:" + previo.db });
  try {
    if (previo.nuevo) {
      await cliente.batch([
        "CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, categoria TEXT NOT NULL, agotado INTEGER DEFAULT 0)",
        "INSERT INTO productos(nombre,categoria,agotado) VALUES ('Leche FICTICIA','Ensayo',1),('Huevos FICTICIOS','Ensayo',1),('Arroz FICTICIO','Ensayo',0)",
      ], "write");
    }
    await inspeccionarCliente(cliente);
    return Object.freeze({ ...previo, cliente });
  } catch (error) {
    await cliente.close();
    throw error;
  }
}
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
async function crearRespaldo({ directorio, cliente }) {
  const base = validarRuta(directorio);
  leerMarca(base);
  if (!fs.existsSync(rutaDB(base)) ||
      fs.lstatSync(rutaDB(base)).isSymbolicLink()) {
    throw new Error("V3_PERSISTENCIA_DB_INEXISTENTE");
  }
  if (!cliente || typeof cliente.execute !== "function") {
    throw new Error("V3_RESPALDO_CLIENTE_INVALIDO");
  }
  await inspeccionarCliente(cliente);
  const dir = path.join(base, "respaldos");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) {
    throw new Error("V3_RESPALDO_RUTA_NO_SEGURA");
  }
  const archivo = "backup-" + Date.now() + "-" +
    randomBytes(8).toString("hex") + ".sqlite";
  const destino = path.join(dir, archivo);
  if (fs.existsSync(destino)) throw new Error("V3_RESPALDO_YA_EXISTE");
  await cliente.execute({ sql: "VACUUM INTO ?", args: [destino] });
  const hash = sha256(destino);
  return Object.freeze({ archivo, sha256: hash, ruta: destino });
}
function restaurarEnDirectorioNuevo({ origen, archivo, sha256Esperado, destino }) {
  const root = validarRuta(origen);
  leerMarca(root);
  if (typeof archivo !== "string" || !BACKUP_RE.test(archivo)) {
    throw new Error("V3_RESTAURAR_ARCHIVO_INVALIDO");
  }
  if (typeof sha256Esperado !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256Esperado)) {
    throw new Error("V3_RESTAURAR_HASH_INVALIDO");
  }
  const fuenteDir = path.join(root, "respaldos");
  if (!fs.existsSync(fuenteDir) || fs.lstatSync(fuenteDir).isSymbolicLink()) {
    throw new Error("V3_RESTAURAR_ORIGEN_INVALIDO");
  }
  const fuente = path.join(fuenteDir, archivo);
  if (!fs.existsSync(fuente) || fs.lstatSync(fuente).isSymbolicLink() ||
      !fs.statSync(fuente).isFile()) {
    throw new Error("V3_RESTAURAR_ARCHIVO_AUSENTE");
  }
  if (sha256(fuente) !== sha256Esperado ||
      fs.readFileSync(fuente).subarray(0,16).toString("utf8") !==
        "SQLite format 3\u0000") {
    throw new Error("V3_RESTAURAR_INTEGRIDAD_INVALIDA");
  }
  const nueva = validarRuta(destino);
  if (nueva === root || nueva.startsWith(root + path.sep) ||
      root.startsWith(nueva + path.sep)) {
    throw new Error("V3_RESTAURAR_DESTINO_SOLAPADO");
  }
  // Prohibido reemplazar directorios ya existentes, incluso si están vacíos.
  if (fs.existsSync(nueva)) throw new Error("V3_RESTAURAR_DESTINO_EXISTENTE");
  fs.mkdirSync(nueva);
  fs.copyFileSync(fuente, rutaDB(nueva), fs.constants.COPYFILE_EXCL);
  if (sha256(rutaDB(nueva)) !== sha256Esperado) {
    throw new Error("V3_RESTAURAR_COPIA_NO_VERIFICADA");
  }
  crearMarca(nueva, { restauradoDesdeSha256: sha256Esperado });
  return Object.freeze({ directorio: nueva, sha256: sha256Esperado });
}
module.exports = {
  validarRuta, leerMarca, abrirPersistencia, crearRespaldo,
  restaurarEnDirectorioNuevo, inspeccionarCliente,
};
