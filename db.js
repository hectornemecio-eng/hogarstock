const { createClient } = require("@libsql/client");
require("dotenv").config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  try {
    await db.execute("SELECT categoria FROM productos LIMIT 1");
  } catch (e) {
    if (e.message.includes("no such column")) {
      console.log("⚠️ Tabla antigua detectada sin categorías. Borrando para recrear...");
      await db.execute("DROP TABLE IF EXISTS productos");
    }
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      agotado INTEGER DEFAULT 0
    )
  `);
  
  const count = await db.execute("SELECT COUNT(*) as c FROM productos");
  if (count.rows[0].c === 0) {
    const productos = [
      { n: "Aguacates", c: "Frutas y Verduras" }, { n: "Ajos", c: "Frutas y Verduras" }, { n: "Auyama", c: "Frutas y Verduras" }, { n: "Arandanos", c: "Frutas y Verduras" }, { n: "Cambur", c: "Frutas y Verduras" }, { n: "Canónigos", c: "Frutas y Verduras" }, { n: "Cebollas", c: "Frutas y Verduras" }, { n: "Cilantro", c: "Frutas y Verduras" }, { n: "Cebollín", c: "Frutas y Verduras" }, { n: "Champiñon", c: "Frutas y Verduras" }, { n: "Ciruelas sin hueso", c: "Frutas y Verduras" }, { n: "Guisante fino Hacendado ultracongelado", c: "Frutas y Verduras" }, { n: "Jengibre Hacendado", c: "Frutas y Verduras" }, { n: "Lechoza", c: "Frutas y Verduras" }, { n: "Limón", c: "Frutas y Verduras" }, { n: "Manzanas rojas dulces", c: "Frutas y Verduras" }, { n: "Papas", c: "Frutas y Verduras" }, { n: "Patilla", c: "Frutas y Verduras" }, { n: "Pimentón Rojo", c: "Frutas y Verduras" }, { n: "Pimentón Verde", c: "Frutas y Verduras" }, { n: "Plátanos", c: "Frutas y Verduras" }, { n: "Tomate Canario (Unidad)", c: "Frutas y Verduras" }, { n: "Uvas roja sin semillas", c: "Frutas y Verduras" }, { n: "Verduras", c: "Frutas y Verduras" }, { n: "Yuca", c: "Frutas y Verduras" }, { n: "Zanahoria", c: "Frutas y Verduras" },
      { n: "Atún claro al natural Hacendado", c: "Carnes y Pescados" }, { n: "Caldo pescado", c: "Carnes y Pescados" }, { n: "Chuleta de pavo", c: "Carnes y Pescados" }, { n: "Chuleta aguja", c: "Carnes y Pescados" }, { n: "Jamón", c: "Carnes y Pescados" }, { n: "Jamón serrano", c: "Carnes y Pescados" }, { n: "Lomo de cerdo", c: "Carnes y Pescados" }, { n: "Medallones de merluza Hacendado ultracongelados", c: "Carnes y Pescados" }, { n: "Muslos de Pollo", c: "Carnes y Pescados" }, { n: "Pechugas enteras de pollo", c: "Carnes y Pescados" }, { n: "Pechuga de pavo", c: "Carnes y Pescados" }, { n: "Preparado de carne picada vacuno", c: "Carnes y Pescados" }, { n: "Tacos de cerdo", c: "Carnes y Pescados" }, { n: "Tacos de Pavo", c: "Carnes y Pescados" },
      { n: "Actimel (Lechita)", c: "Lácteos y Huevos" }, { n: "Huevos grandes XL", c: "Lácteos y Huevos" }, { n: "Leche semidesnatada sin lactosa Hacendado", c: "Lácteos y Huevos" }, { n: "Leche en polvo", c: "Lácteos y Huevos" }, { n: "Proteinas leche", c: "Lácteos y Huevos" }, { n: "Queso fresco para untar", c: "Lácteos y Huevos" }, { n: "Queso Feta", c: "Lácteos y Huevos" }, { n: "Queso Mozarella Bolitas", c: "Lácteos y Huevos" }, { n: "Queso Mozarella Rebanado y rallado", c: "Lácteos y Huevos" }, { n: "Tequeños de queso", c: "Lácteos y Huevos" }, { n: "Yogurt griego", c: "Lácteos y Huevos" }, { n: "Yogurt grande", c: "Lácteos y Huevos" },
      { n: "Aceite de oliva virgen extra Hacendado", c: "Despensa" }, { n: "Aceitunas negras Hacendado sin hueso", c: "Despensa" }, { n: "Aceitunas verdes", c: "Despensa" }, { n: "Alcohol", c: "Despensa" }, { n: "Anacardos", c: "Despensa" }, { n: "Almendras fileteadas", c: "Despensa" }, { n: "Arroz largo Hacendado", c: "Despensa" }, { n: "Arroz integral", c: "Despensa" }, { n: "Bicarbonato", c: "Despensa" }, { n: "Café en cápsulas doble espresso Hacendado", c: "Despensa" }, { n: "Café molido natural Hacendado", c: "Despensa" }, { n: "Caramelos jengibre", c: "Despensa" }, { n: "Cereal Espelta", c: "Despensa" }, { n: "Cacao", c: "Despensa" }, { n: "Galletas Espelta", c: "Despensa" }, { n: "Gelatina", c: "Despensa" }, { n: "Granos", c: "Despensa" }, { n: "Harina de maíz blanco precocida Hacendado", c: "Despensa" }, { n: "Harina de espelta", c: "Despensa" }, { n: "Hierbas provenzales Hacendado", c: "Despensa" }, { n: "Infusión frutos rojos Hacendado", c: "Despensa" }, { n: "Infusión Manzanilla sabor a miel Hacendado", c: "Despensa" }, { n: "Infusión te verde", c: "Despensa" }, { n: "Levadura", c: "Despensa" }, { n: "Macarrón Hacendado", c: "Despensa" }, { n: "Masa", c: "Despensa" }, { n: "Maicena", c: "Despensa" }, { n: "Maíz para cotufas", c: "Despensa" }, { n: "Miel", c: "Despensa" }, { n: "Nachos", c: "Despensa" }, { n: "Orégano", c: "Despensa" }, { n: "Nuez natural", c: "Despensa" }, { n: "Pan de molde 100% integral sin corteza Hacendado 0% azúcares añadidos", c: "Despensa" }, { n: "Panecillos mercadona e integral", c: "Despensa" }, { n: "Pasta corta tornillitos", c: "Despensa" }, { n: "Papel vegetal para tosty", c: "Despensa" }, { n: "Panela", c: "Despensa" }, { n: "Pimentón rojo en polvo", c: "Despensa" }, { n: "Pistacho", c: "Despensa" }, { n: "Preparado crepes", c: "Despensa" }, { n: "Sal", c: "Despensa" }, { n: "Tomate triturado", c: "Despensa" }, { n: "Semillas de chía Hacendado", c: "Despensa" }, { n: "Semillas sésamo tostado Hacendado", c: "Despensa" }, { n: "Vino Blanco y tinto", c: "Despensa" },
      { n: "Ambientador spray 03", c: "Limpieza y Hogar" }, { n: "Bolsas de basura mini Bosque Verde 10L cubo pequeño", c: "Limpieza y Hogar" }, { n: "Bolsas de congelación medianas Bosque Verde", c: "Limpieza y Hogar" }, { n: "Estropajo suciedad resistente Bosque Verde", c: "Limpieza y Hogar" }, { n: "Envase aluminio", c: "Limpieza y Hogar" }, { n: "Enjuague Ropa", c: "Limpieza y Hogar" }, { n: "Friegasuelos Spa Bosque Verde líquido", c: "Limpieza y Hogar" }, { n: "Jabón Ropa", c: "Limpieza y Hogar" }, { n: "Lavaplatos", c: "Limpieza y Hogar" }, { n: "Lampazos", c: "Limpieza y Hogar" }, { n: "Limpiador Baños desinfectante Bosque Verde", c: "Limpieza y Hogar" }, { n: "Mopa", c: "Limpieza y Hogar" }, { n: "Papel Aluminio", c: "Limpieza y Hogar" }, { n: "Papel higiénico Doble Rollo Bosque Verde", c: "Limpieza y Hogar" }, { n: "Papel higiénico húmedo WC Bosque Verde", c: "Limpieza y Hogar" }, { n: "Recipientes", c: "Limpieza y Hogar" }, { n: "Servilletas 2 capas", c: "Limpieza y Hogar" }, { n: "Toallitas multiuso limpiador baños", c: "Limpieza y Hogar" }, { n: "Toallitas húmedas wc", c: "Limpieza y Hogar" }, { n: "Toallitas para limpiar multiuso", c: "Limpieza y Hogar" }, { n: "Toallitas para limpiar vidrio", c: "Limpieza y Hogar" },
      { n: "Afeitadoras", c: "Higiene Personal" }, { n: "Cepillo dental", c: "Higiene Personal" }, { n: "Champú Anticaída Deliplus", c: "Higiene Personal" }, { n: "Champú ac mentol", c: "Higiene Personal" }, { n: "Compresa con alas noche plegada Deliplus Classic", c: "Higiene Personal" }, { n: "Compresa sin alas super plegada Deliplus Classic", c: "Higiene Personal" }, { n: "Compresa uso diario", c: "Higiene Personal" }, { n: "Contorno de ojos", c: "Higiene Personal" }, { n: "Corrector Stick Deliplus 01", c: "Higiene Personal" }, { n: "Crema Dental", c: "Higiene Personal" }, { n: "Desodorante mi Bella", c: "Higiene Personal" }, { n: "Desodorante Sanex barra Hector", c: "Higiene Personal" }, { n: "Desodorante papi y mami", c: "Higiene Personal" }, { n: "Desmaquillante", c: "Higiene Personal" }, { n: "Discos de algodón", c: "Higiene Personal" }, { n: "Enjuague Bucal", c: "Higiene Personal" }, { n: "Exfoliante", c: "Higiene Personal" }, { n: "Gel de afeitar Sensitive Deliplus", c: "Higiene Personal" }, { n: "Gel de limpiadora mimi y adri", c: "Higiene Personal" }, { n: "Hisopos", c: "Higiene Personal" }, { n: "Jabón de manos avena Deliplus líquido", c: "Higiene Personal" }, { n: "Jabón Dove", c: "Higiene Personal" }, { n: "Loción para el cuerpo nutre", c: "Higiene Personal" }, { n: "Máscara 24 horas", c: "Higiene Personal" }, { n: "Mascarilla Hidra Hialurónico Elvive cabello deshidratado", c: "Higiene Personal" }, { n: "Multicorrector", c: "Higiene Personal" }, { n: "Polvo maquillaje", c: "Higiene Personal" }, { n: "Rimel", c: "Higiene Personal" }, { n: "Sérum Plex Repair Deliplus cabello muy dañado", c: "Higiene Personal" }, { n: "Talco", c: "Higiene Personal" }, { n: "Toallitas desmaquillantes Micelar & Oil Deliplus para todo tipo de pieles", c: "Higiene Personal" }, { n: "Tinte", c: "Higiene Personal" }
    ];
    
    for (const p of productos) {
      await db.execute({
        sql: "INSERT INTO productos (nombre, categoria) VALUES (?, ?)",
        args: [p.n, p.c],
      });
    }
    console.log(`Catálogo inicial creado con ${productos.length} productos.`);
  }
}
module.exports = { db, initDB };
