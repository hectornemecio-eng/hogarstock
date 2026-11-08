"use strict";

// Ensayo V2 -> V3 SOLO sobre clientes inyectados y datos ficticios.
// Este modulo NO importa db.js, no abre conexiones externas, no lee secretos
// ni migra credenciales Baileys, contactos, sesiones o supuestos historiales.
// Una llamada real requiere guardas de entorno y origen/destino independientes.
const { createHash } = require("node:crypto");

const REQUERIDAS = Object.freeze(["id", "nombre", "categoria", "agotado"]);
const TABLAS = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
const COLUMNAS = "PRAGMA table_info(productos)";
const FILAS = "SELECT id,nombre,categoria,agotado FROM productos ORDER BY id";
const TABLA_PRUEBA = "hogarstock_v3_migration_dryrun_proof";

function validarCliente(cliente, nombre) {
  if (!cliente || typeof cliente.execute !== "function") {
    throw new TypeError("V3_MIGRACION_"+nombre+"_INVALIDO");
  }
}
function nombresDeTablas(resultado) {
  if (!Array.isArray(resultado?.rows)) {
    throw Error("V3_MIGRACION_METADATOS_INVALIDOS");
  }
  return resultado.rows.map(x=>String(x.name));
}
function normalizar(filas) {
  if (!Array.isArray(filas) || filas.length > 10000) {
    throw Error("V3_MIGRACION_CATALOGO_NO_VALIDO");
  }
  let anterior=0;
  return filas.map(f=>{
    const id=Number(f.id),agotado=Number(f.agotado);
    if (!Number.isSafeInteger(id) || id<=anterior ||
        typeof f.nombre!=="string" || !f.nombre.trim() ||
        typeof f.categoria!=="string" || !f.categoria.trim() ||
        ![0,1].includes(agotado)) {
      throw Error("V3_MIGRACION_CATALOGO_NO_VALIDO");
    }
    anterior=id;
    return Object.freeze({id,nombre:f.nombre,categoria:f.categoria,agotado});
  });
}
function huella(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows.map(x=>[x.id,x.nombre,x.categoria,x.agotado])))
    .digest("hex");
}
function validarEntorno(entorno) {
  if (entorno?.HOGARSTOCK_V3_SANDBOX!=="1" ||
      entorno?.HOGARSTOCK_V3_MIGRACION_LAB!=="1" ||
      [
        "TURSO_DATABASE_URL","TURSO_AUTH_TOKEN",
        "HOGARSTOCK_STAGING_TURSO_URL","HOGARSTOCK_STAGING_TURSO_TOKEN",
        "HOGARSTOCK_V3_REMOTE_STAGE","HOGARSTOCK_V3_WHATSAPP_LIVE",
        "WA_MASTER_KEY","WA_ALLOWED_NUMBERS",
      ].some(k=>Boolean(entorno[k])) ||
      Object.keys(entorno).some(k=>
        (k.startsWith("WA_") || k.startsWith("WHATSAPP_")) &&
        Boolean(entorno[k]))) {
    throw Error("V3_MIGRACION_SOLO_SANDBOX_FICTICIO");
  }
}

async function leerCatalogoV2(origen) {
  validarCliente(origen,"ORIGEN");
  const tablas=nombresDeTablas(await origen.execute(TABLAS));
  if (!tablas.includes("productos")) {
    throw Error("V3_MIGRACION_TABLA_PRODUCTOS_AUSENTE");
  }
  if (tablas.some(n=>n.startsWith("hogarstock_") && n.endsWith("_v3"))) {
    throw Error("V3_MIGRACION_ORIGEN_CONTIENE_V3");
  }
  const columns=await origen.execute(COLUMNAS);
  const m=new Map((columns?.rows||[]).map(x=>[String(x.name),x]));
  if (REQUERIDAS.some(x=>!m.has(x))||Number(m.get("id").pk)!==1) {
    throw Error("V3_MIGRACION_ESQUEMA_V2_INCOMPATIBLE");
  }
  const data=await origen.execute(FILAS);
  const productos=normalizar(data?.rows);
  const digest=huella(productos);
  const reporte=Object.freeze({
    productos:productos.length,
    agotados:productos.filter(x=>x.agotado===1).length,
    huellaSha256:digest,
    soloLecturaOrigen:true,
    copioCredencialesWhatsApp:false,
    historialComprasReconstruido:false,
    tablasLegacyBaileysPresentes:tablas.filter(x=>
      ["baileys_auth","baileys_auth_v2"].includes(x)).length,
  });
  return Object.freeze({reporte,productos});
}

async function simularMigracionCatalogo({
  origen, destino, entorno={}, confirmacion=false, huellaEsperada,
}={}) {
  validarEntorno(entorno);
  if (confirmacion!==true) {
    throw Error("V3_MIGRACION_CONFIRMACION_REQUERIDA");
  }
  validarCliente(origen,"ORIGEN");
  validarCliente(destino,"DESTINO");
  if (origen===destino || typeof destino.batch!=="function") {
    throw Error("V3_MIGRACION_DESTINO_NO_SEPARADO");
  }
  const datos=await leerCatalogoV2(origen);
  if (!/^[a-f0-9]{64}$/.test(huellaEsperada||"") ||
      datos.reporte.huellaSha256!==huellaEsperada) {
    throw Error("V3_MIGRACION_HUELLA_NO_COINCIDE");
  }
  const existentes=nombresDeTablas(await destino.execute(TABLAS))
    .filter(x=>!x.startsWith("sqlite_"));
  if (existentes.length!==0) {
    throw Error("V3_MIGRACION_DESTINO_NO_VACIO");
  }
  // batch(...,"write") transaccional sobre DESTINO. Origen: SELECT y PRAGMA.
  // Conserva IDs y texto exactos, pero no la historia no persistida por V2.
  const sentencias=[
    "CREATE TABLE productos ("+
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"+
      "nombre TEXT NOT NULL,categoria TEXT NOT NULL,"+
      "agotado INTEGER DEFAULT 0 CHECK(agotado IN (0,1)))",
    ...datos.productos.map(x=>({
      sql:"INSERT INTO productos(id,nombre,categoria,agotado) VALUES(?,?,?,?)",
      args:[x.id,x.nombre,x.categoria,x.agotado],
    })),
    "CREATE TABLE "+TABLA_PRUEBA+" ("+
      "id INTEGER PRIMARY KEY CHECK(id=1),"+
      "source_sha256 TEXT NOT NULL,productos INTEGER NOT NULL)",
    {sql:"INSERT INTO "+TABLA_PRUEBA+"(id,source_sha256,productos) VALUES(1,?,?)",
      args:[huellaEsperada,datos.productos.length]},
  ];
  await destino.batch(sentencias,"write");
  const verificacion=normalizar((await destino.execute(FILAS)).rows);
  if (huella(verificacion)!==huellaEsperada) {
    throw Error("V3_MIGRACION_VERIFICACION_DESTINO_FALLIDA");
  }
  const respuesta=Object.freeze({
    operacion:"ENSAYO_SQLITE_AISLADO",
    origenSoloLectura:true,
    destinoNuevoFicticio:true,
    productosMigrados:verificacion.length,
    agotadosPreservados:verificacion.filter(x=>x.agotado===1).length,
    sha256:huellaEsperada,
    idPreservados:true,
    credencialesWhatsAppMigradas:false,
    historialComprasLegacyMigrado:false,
    aptoParaProduccion:false,
    requiereRestauracionReal:true,
  });
  return respuesta;
}
module.exports={leerCatalogoV2,simularMigracionCatalogo};
