const { createClient } = require("@libsql/client");
require("dotenv").config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  // Crear tabla si no existe
  await db.execute(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      agotado INTEGER DEFAULT 0
    )
  `);
  
  // Insertar los 10 productos si la tabla está vacía
  const count = await db.execute("SELECT COUNT(*) as c FROM productos");
  if (count.rows[0].c === 0) {
    const productos = [
      "Escoba", "Trapeador", "Detergente", "Jabón de platos",
      "Esponja", "Bolsas de basura", "Papel higiénico",
      "Toallas de cocina", "Basurero", "Ambientador"
    ];
    for (const p of productos) {
      await db.execute({
        sql: "INSERT INTO productos (nombre) VALUES (?)",
        args: [p],
      });
    }
    console.log("Catálogo inicial de 10 productos creado en Turso.");
  }
}

module.exports = { db, initDB };
