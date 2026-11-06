"use strict";
// Auditoría estructural de SOLO LECTURA. Sin conexión implícita, sin migraciones,
// sin credenciales y sin inspección de filas de usuario. El llamante inyecta cliente.
// Resultado deliberadamente no constituye autorización de despliegue.
const TABLAS_V3 = Object.freeze([
  "hogarstock_admin_sessions_v3",
  "hogarstock_purchase_grants_v3",
  "hogarstock_admin_credentials_v3",
  "hogarstock_buyer_sessions_v3",
  "hogarstock_compras_v3",
  "hogarstock_compra_items_v3",
  "hogarstock_wa_links_v3",
  "hogarstock_wa_inbox_v3",
  "hogarstock_wa_inbox_aplicaciones_v3",
  "hogarstock_wa_outbox_v3",
]);
const SQL_TABLAS = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
const SQL_COLUMNAS = "PRAGMA table_info(productos)";
const REQUERIDAS = Object.freeze(["id","nombre","categoria","agotado"]);

function nombreSeguro(x) {
  return typeof x === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
}
async function auditarEsquemaSinEscritura(cliente) {
  if (!cliente || typeof cliente.execute !== "function")
    throw new TypeError("AUDITORIA_CLIENTE_INVALIDO");
  // Intencionadamente SOLO dos consultas constantes. No SELECT de productos.
  const t = await cliente.execute(SQL_TABLAS);
  if (!t || !Array.isArray(t.rows))
    throw new Error("AUDITORIA_RESPUESTA_INVALIDA");
  const tablas = t.rows.map(x=>x.name);
  if (tablas.some(x=>!nombreSeguro(x)))
    throw new Error("AUDITORIA_METADATOS_INVALIDOS");
  const unica = new Set(tablas);
  if (unica.size !== tablas.length)
    throw new Error("AUDITORIA_METADATOS_DUPLICADOS");
  const existeProductos = unica.has("productos");
  const detectadasV3 = TABLAS_V3.filter(x=>unica.has(x));
  const columnas = existeProductos
    ? await cliente.execute(SQL_COLUMNAS)
    : null;
  if (existeProductos && (!columnas || !Array.isArray(columnas.rows)))
    throw new Error("AUDITORIA_COLUMNAS_INVALIDAS");
  const presentes = new Set(existeProductos ? columnas.rows.map(x=>String(x.name)) : []);
  const faltantes = REQUERIDAS.filter(x=>!presentes.has(x));
  const idCol = existeProductos
    ? columnas.rows.find(x=>String(x.name)==="id")
    : null;
  const idEsPk = idCol && Number(idCol.pk) === 1;
  const catalogoCompatible = Boolean(existeProductos && !faltantes.length && idEsPk);
  const estado = !existeProductos ? "SIN_TABLA_PRODUCTOS" :
    !catalogoCompatible ? "CATALOGO_INCOMPATIBLE" :
    detectadasV3.length ? "V3_PREEXISTENTE_A_REVISAR" :
    "CATALOGO_V2_COMPATIBLE_EN_ESTRUCTURA";
  // Nunca afirma que el DB remoto sea staging ni que un backup exista.
  return Object.freeze({
    estado,
    catalogoCompatible,
    productosExiste: existeProductos,
    columnasRequeridasAusentes: Object.freeze([...faltantes]),
    tablasV3Detectadas: Object.freeze([...detectadasV3]),
    tablasUsuario: tablas.filter(x=>!x.startsWith("sqlite_")).length,
    aptoParaDespliegue: false,
    respaldoVerificado: false,
    operacion: "SOLO_LECTURA",
  });
}
module.exports = { auditarEsquemaSinEscritura };
