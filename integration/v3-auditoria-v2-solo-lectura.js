"use strict";

// Auditor de metadatos y agregados V2: no importa db.js, no abre red,
// no expone productos, contactos, credenciales, nombres ni teléfonos.
// Requiere un cliente inyectado por el operador y solo usa SQL de lectura.
// NO constituye respaldo, autorización de escritura ni prueba de facturación.
const TABLAS = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
const COLUMNAS = "PRAGMA table_info(productos)";
const RESUMEN = "SELECT COUNT(*) AS total,"+
  " SUM(CASE WHEN agotado=1 THEN 1 ELSE 0 END) AS agotados,"+
  " SUM(CASE WHEN agotado=0 THEN 1 ELSE 0 END) AS disponibles,"+
  " SUM(CASE WHEN agotado IS NULL OR agotado NOT IN (0,1) THEN 1 ELSE 0 END) AS estados_invalidos,"+
  " SUM(CASE WHEN nombre IS NULL OR TRIM(nombre)='' OR categoria IS NULL OR TRIM(categoria)='' THEN 1 ELSE 0 END) AS textos_invalidos,"+
  " COUNT(DISTINCT id) AS ids_distintos,"+
  " SUM(CASE WHEN id IS NULL OR id<=0 THEN 1 ELSE 0 END) AS ids_invalidos"+
  " FROM productos";
const QUERIES = Object.freeze([TABLAS,COLUMNAS,RESUMEN]);
const REQUERIDAS = Object.freeze(["id","nombre","categoria","agotado"]);
function numero(x) {
  const n=Number(x);
  if(!Number.isSafeInteger(n)||n<0)throw Error("V2_AUDITORIA_CONTEO_INVALIDO");
  return n;
}
async function auditarV2SoloLectura(cliente,{maxProductos=10000}={}) {
  if(!cliente||typeof cliente.execute!=="function") {
    throw new TypeError("V2_AUDITORIA_CLIENTE_INVALIDO");
  }
  if(!Number.isSafeInteger(maxProductos)||maxProductos<1||maxProductos>100000) {
    throw new TypeError("V2_AUDITORIA_LIMITE_INVALIDO");
  }
  const tablas=await cliente.execute(TABLAS);
  if(!Array.isArray(tablas?.rows)) throw Error("V2_AUDITORIA_METADATOS_INVALIDOS");
  const names=tablas.rows.map(x=>String(x.name));
  if(names.some(x=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) ||
      new Set(names).size!==names.length) {
    throw Error("V2_AUDITORIA_METADATOS_INVALIDOS");
  }
  const hayProducto=names.includes("productos");
  if(!hayProducto) return Object.freeze({
    esquema:"PRODUCTOS_AUSENTE",compatible:false,
    autorizaMigracion:false,respaldoVerificado:false,
    soloLectura:true,consultasEjecutadas:1,
  });
  const columnas=await cliente.execute(COLUMNAS);
  if(!Array.isArray(columnas?.rows))throw Error("V2_AUDITORIA_COLUMNAS_INVALIDAS");
  const m=new Map(columnas.rows.map(x=>[String(x.name),x]));
  const faltan=REQUERIDAS.filter(x=>!m.has(x));
  if(faltan.length||Number(m.get("id").pk)!==1) return Object.freeze({
    esquema:"PRODUCTOS_INCOMPATIBLE",compatible:false,
    columnasAusentes:faltan,
    autorizaMigracion:false,respaldoVerificado:false,
    soloLectura:true,consultasEjecutadas:2,
  });
  const conteos=await cliente.execute(RESUMEN);
  if(!Array.isArray(conteos?.rows)||conteos.rows.length!==1) {
    throw Error("V2_AUDITORIA_RESPUESTA_INVALIDA");
  }
  const r=conteos.rows[0];
  const total=numero(r.total), agotados=numero(r.agotados??0);
  const disponibles=numero(r.disponibles??0);
  const estadosInvalidos=numero(r.estados_invalidos??0);
  const textosInvalidos=numero(r.textos_invalidos??0);
  const idsDistintos=numero(r.ids_distintos);
  const idsInvalidos=numero(r.ids_invalidos??0);
  if(total>maxProductos)throw Error("V2_AUDITORIA_LIMITE_SUPERADO");
  if(agotados+disponibles+estadosInvalidos!==total ||
      idsDistintos>total||idsDistintos+idsInvalidos<total) {
    throw Error("V2_AUDITORIA_CONTEOS_INCONSISTENTES");
  }
  return Object.freeze({
    esquema:"PRODUCTOS_V2_COMPATIBLE",
    compatible:estadosInvalidos===0&&textosInvalidos===0&&
      idsInvalidos===0&&idsDistintos===total,
    catalogo:Object.freeze({total,agotados,disponibles,
      estadosInvalidos,textosInvalidos,idsDistintos,idsInvalidos}),
    // No se leen filas ni columnas de estas tablas.
    hayTablasAuthBaileys: names.some(x=>
      ["baileys_auth","baileys_auth_v2"].includes(x)),
    hayTablasV3: names.some(x=>
      x.startsWith("hogarstock_")&&x.endsWith("_v3")),
    soloLectura:true,consultasEjecutadas:3,
    autorizaMigracion:false,respaldoVerificado:false,
    aptoDespliegue:false,
  });
}
module.exports={auditarV2SoloLectura,SQL_PERMITIDO:QUERIES};
