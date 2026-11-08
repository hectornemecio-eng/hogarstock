"use strict";

// Recuperacion OFFLINE de un snapshot SQLite FICTICIO de HogarStock V3.
// Nunca abre Turso ni WhatsApp. Nunca modifica ni reemplaza el respaldo.
// Crea una copia aislada en el directorio temporal indicado por el operador.
// No elimina la copia desde Node: Windows puede mantener handles SQLite.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createClient } = require("@libsql/client");
const { auditarEsquemaSinEscritura } = require("./v3-readonly-schema-audit.js");

const HOST_RE = /^hogarstock-v3-test-[a-z0-9-]+\.turso\.io$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PROOF_RE = /^[0-9a-f]{32}$/;
const HEADER = "SQLite format 3\u0000";
const REQUIRED = [
  "hogarstock_admin_sessions_v3",
  "hogarstock_compras_v3",
  "hogarstock_compra_items_v3",
  "hogarstock_wa_inbox_v3",
  "hogarstock_wa_outbox_v3",
];
function hashArchivo(archivo) {
  const buf = fs.readFileSync(archivo);
  return createHash("sha256").update(buf).digest("hex");
}
function validarFichero(archivo) {
  if (typeof archivo !== "string" || !path.isAbsolute(archivo) ||
      !archivo.toLowerCase().endsWith(".sqlite") ||
      !fs.existsSync(archivo) || fs.lstatSync(archivo).isSymbolicLink() ||
      !fs.statSync(archivo).isFile()) {
    throw Error("V3_BACKUP_ARCHIVO_INVALIDO");
  }
  const normal = path.resolve(archivo);
  const raizRepo = path.resolve(__dirname, "..");
  const rel = path.relative(raizRepo, normal);
  if (!path.isAbsolute(rel) && (rel === "" ||
      (rel !== ".." && !rel.startsWith(".." + path.sep)))) {
    throw Error("V3_BACKUP_DENTRO_REPOSITORIO");
  }
  const fd = fs.openSync(normal, "r");
  try {
    const cabecera = Buffer.alloc(16);
    if (fs.readSync(fd, cabecera, 0, 16, 0) !== 16 ||
        cabecera.toString("utf8") !== HEADER) {
      throw Error("V3_BACKUP_NO_ES_SQLITE");
    }
  } finally { fs.closeSync(fd); }
  return normal;
}

async function verificarRespaldoStaging({
  archivo, sha256Esperado, hostEsperado, proofIdEsperado,
  directorioTemporal,
} = {}) {
  // Validacion sin efectos secundarios antes de copiar/abrir archivos.
  if (!HOST_RE.test(hostEsperado || "") ||
      !PROOF_RE.test(proofIdEsperado || "")) {
    throw Error("V3_BACKUP_IDENTIDAD_CONFIG_INVALIDA");
  }
  if (!HASH_RE.test(sha256Esperado || "")) {
    throw Error("V3_BACKUP_SHA_CONFIG_INVALIDO");
  }
  const fuente = validarFichero(archivo);
  if (hashArchivo(fuente) !== sha256Esperado) {
    throw Error("V3_BACKUP_SHA_NO_COINCIDE");
  }
  if (typeof directorioTemporal !== "string" ||
      !path.isAbsolute(directorioTemporal) ||
      !fs.existsSync(directorioTemporal) ||
      !fs.statSync(directorioTemporal).isDirectory()) {
    throw Error("V3_BACKUP_TEMPORAL_INVALIDO");
  }
  const temp = path.resolve(directorioTemporal);
  if (temp === path.resolve(__dirname, "..") ||
      temp.startsWith(path.resolve(__dirname, "..") + path.sep)) {
    throw Error("V3_BACKUP_TEMPORAL_DENTRO_REPO");
  }
  const carpeta = fs.mkdtempSync(path.join(temp, "hs-v3-restore-proof-"));
  const destino = path.join(carpeta, "recuperado.sqlite");
  fs.copyFileSync(fuente, destino, fs.constants.COPYFILE_EXCL);
  if (hashArchivo(destino) !== sha256Esperado) {
    throw Error("V3_BACKUP_COPIA_DIFERENTE");
  }
  const cliente = createClient({ url: "file:" + destino });
  try {
    const integrity = await cliente.execute("PRAGMA integrity_check");
    if (String(integrity.rows?.[0]?.integrity_check) !== "ok") {
      throw Error("V3_BACKUP_INTEGRIDAD_SQLITE_INCORRECTA");
    }
    let proof;
    try {
      const r = await cliente.execute(
        "SELECT host,proof_id FROM hogarstock_v3_stage_proof WHERE id=1"
      );
      if (r.rows?.length !== 1) throw Error("missing");
      proof = r.rows[0];
    } catch (_) {
      throw Error("V3_BACKUP_MARCA_NO_ENCONTRADA");
    }
    if (String(proof.host) !== hostEsperado ||
        String(proof.proof_id) !== proofIdEsperado) {
      throw Error("V3_BACKUP_IDENTIDAD_NO_COINCIDE");
    }
    const audit = await auditarEsquemaSinEscritura(cliente);
    if (!audit.catalogoCompatible ||
        REQUIRED.some(name => !audit.tablasV3Detectadas.includes(name))) {
      throw Error("V3_BACKUP_ESQUEMA_INCORRECTO");
    }
    const n = await cliente.execute("SELECT COUNT(*) AS n FROM productos");
    if (Number(n.rows?.[0]?.n) < 3) {
      throw Error("V3_BACKUP_CATALOGO_INCOMPLETO");
    }
    return Object.freeze({
      restauracionLocalVerificada: true,
      sha256: sha256Esperado,
      tablasV3: audit.tablasV3Detectadas.length,
      productos: Number(n.rows[0].n),
      carpetaCopia: carpeta,
      // NO incluir el token, HMAC, URL, contenido de usuarios ni proof_id.
    });
  } finally { await cliente.close(); }
}

if (require.main === module) {
  verificarRespaldoStaging({
    archivo: process.env.HOGARSTOCK_STAGING_BACKUP_FILE,
    sha256Esperado: process.env.HOGARSTOCK_STAGING_BACKUP_SHA256,
    hostEsperado: process.env.HOGARSTOCK_STAGING_TURSO_HOST,
    proofIdEsperado: process.env.HOGARSTOCK_STAGING_PROOF_ID,
    directorioTemporal: process.env.TMP || process.env.TEMP || os.tmpdir(),
  }).then(r => {
    process.stdout.write("V3_BACKUP_RESTAURACION_LOCAL=VERIFICADA\n");
    process.stdout.write("V3_BACKUP_SHA256=" + r.sha256 + "\n");
    process.stdout.write("V3_BACKUP_TABLAS_V3=" + r.tablasV3 + "\n");
    process.stdout.write("V3_BACKUP_PRODUCTOS=" + r.productos + "\n");
    process.stdout.write("TURSO_REMOTO=NO\nWHATSAPP_REAL=NO\n");
    // Carpeta copia se conserva para limpieza EXTERNA tras terminar Node.
  }).catch(e => {
    // No mostrar rutas ni excepciones del SDK.
    const code = /^V3_BACKUP_[A-Z_]+$/.test(e?.message) ?
      e.message : "V3_BACKUP_VERIFICACION_FALLIDA";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
}
module.exports = { verificarRespaldoStaging };
