"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { DatabaseSync } = require("node:sqlite");

function crearEntorno(sqlInicial = "") {
  const sqlite = new DatabaseSync(":memory:");
  if (sqlInicial) sqlite.exec(sqlInicial);

  const consultas = [];
  const cliente = {
    async execute(consulta) {
      const sql = typeof consulta === "string" ? consulta : consulta.sql;
      const args = typeof consulta === "string" ? [] : consulta.args || [];
      consultas.push(sql);
      const sentencia = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
        return { rows: sentencia.all(...args) };
      }
      const resultado = sentencia.run(...args);
      return { rows: [], rowsAffected: resultado.changes };
    },
  };

  const cargaOriginal = Module._load;
  const rutaDb = require.resolve("../db.js");
  Module._load = function (solicitud, padre, principal) {
    if (solicitud === "@libsql/client") {
      return { createClient: () => cliente };
    }
    if (solicitud === "dotenv") {
      return { config: () => ({ parsed: {} }) };
    }
    return cargaOriginal.call(this, solicitud, padre, principal);
  };

  let modulo;
  try {
    delete require.cache[rutaDb];
    modulo = require("../db.js");
  } finally {
    Module._load = cargaOriginal;
    delete require.cache[rutaDb];
  }
  return { sqlite, consultas, initDB: modulo.initDB };
}

function contar(sqlite) {
  return sqlite.prepare("SELECT COUNT(*) AS total FROM productos").get().total;
}

function sinBorradoDestructivo(consultas) {
  assert.equal(
    consultas.some((sql) => /\b(DROP\s+TABLE|DELETE\s+FROM)\b/i.test(sql)),
    false,
    "La inicializacion no debe borrar registros ni tablas"
  );
}

const esquemaCompatible = [
  "CREATE TABLE productos (",
  " id INTEGER PRIMARY KEY AUTOINCREMENT,",
  " nombre TEXT NOT NULL,",
  " categoria TEXT NOT NULL,",
  " agotado INTEGER DEFAULT 0",
  ");",
].join("\n");

test("Base totalmente nueva: crea productos e inserta el catalogo inicial", async (t) => {
  const entorno = crearEntorno();
  t.after(() => entorno.sqlite.close());
  await entorno.initDB();
  assert.equal(contar(entorno.sqlite), 150);
  const columnas = entorno.sqlite.prepare("PRAGMA table_info(productos)").all();
  assert.deepEqual(
    columnas.map((columna) => columna.name),
    ["id", "nombre", "categoria", "agotado"]
  );
  sinBorradoDestructivo(entorno.consultas);
});

test("Tabla existente con datos: mantiene ID, nombre y estado", async (t) => {
  const entorno = crearEntorno(
    esquemaCompatible +
    " INSERT INTO productos(id,nombre,categoria,agotado)" +
    " VALUES (77,'Producto original','Pruebas',1);"
  );
  t.after(() => entorno.sqlite.close());
  await entorno.initDB();
  assert.equal(contar(entorno.sqlite), 1);
  const producto = entorno.sqlite.prepare("SELECT * FROM productos WHERE id = 77").get();
  assert.equal(producto.nombre, "Producto original");
  assert.equal(producto.categoria, "Pruebas");
  assert.equal(producto.agotado, 1);
  sinBorradoDestructivo(entorno.consultas);
});

test("Tabla existente vacia: no repuebla productos", async (t) => {
  const entorno = crearEntorno(esquemaCompatible);
  t.after(() => entorno.sqlite.close());
  await entorno.initDB();
  assert.equal(contar(entorno.sqlite), 0);
  sinBorradoDestructivo(entorno.consultas);
});

test("Esquema antiguo sin categoria: rechaza y conserva datos", async (t) => {
  const entorno = crearEntorno(
    "CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,agotado INTEGER);" +
    "INSERT INTO productos(id,nombre,agotado) VALUES (23,'Producto protegido',1);"
  );
  t.after(() => entorno.sqlite.close());
  await assert.rejects(entorno.initDB(), /ESQUEMA_INCOMPATIBLE.*categoria/);
  assert.equal(contar(entorno.sqlite), 1);
  assert.equal(
    entorno.sqlite.prepare("SELECT nombre FROM productos WHERE id = 23").get().nombre,
    "Producto protegido"
  );
  sinBorradoDestructivo(entorno.consultas);
});

test("Esquema sin agotado: rechaza y conserva datos", async (t) => {
  const entorno = crearEntorno(
    "CREATE TABLE productos (id INTEGER PRIMARY KEY,nombre TEXT NOT NULL,categoria TEXT NOT NULL);" +
    "INSERT INTO productos(id,nombre,categoria) VALUES (24,'Segundo producto','Pruebas');"
  );
  t.after(() => entorno.sqlite.close());
  await assert.rejects(entorno.initDB(), /ESQUEMA_INCOMPATIBLE.*agotado/);
  assert.equal(contar(entorno.sqlite), 1);
  assert.equal(
    entorno.sqlite.prepare("SELECT nombre FROM productos WHERE id = 24").get().nombre,
    "Segundo producto"
  );
  sinBorradoDestructivo(entorno.consultas);
});
