"use strict";
// Presentación no destructiva v4.06: sin cambios de estructura ni UPDATE de Turso.
const CATEGORIAS=Object.freeze(["Frutas","Verduras y tubérculos","Carnes, pescados y embutidos","Lácteos y huevos","Despensa y cocina","Desayunos, snacks y bebidas","Limpieza y lavandería","Papel y artículos del hogar","Higiene personal","Cosmética y belleza"]);
const simplificar=s=>String(s||"").trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
const conjunto=a=>new Set(a.map(simplificar));
const FR=conjunto(["Aguacates","Arandanos","Cambur","Ciruelas sin hueso","Lechoza","Limón","Manzanas rojas dulces","Patilla","Plátanos","Uvas roja sin semillas"]),DE=conjunto(["Anacardos","Almendras fileteadas","Café en cápsulas doble espresso Hacendado","Café molido natural Hacendado","Caramelos jengibre","Cereal Espelta","Cacao","Galletas Espelta","Infusión frutos rojos Hacendado","Infusión Manzanilla sabor a miel Hacendado","Infusión te verde","Nachos","Nuez natural","Pan de molde 100% integral sin corteza Hacendado 0% azúcares añadidos","Panecillos mercadona e integral","Pistacho","Vino Blanco y tinto"]),PA=conjunto(["Bolsas de basura mini Bosque Verde 10L cubo pequeño","Bolsas de congelación medianas Bosque Verde","Envase aluminio","Papel Aluminio","Papel higiénico Doble Rollo Bosque Verde","Papel higiénico húmedo WC Bosque Verde","Recipientes","Servilletas 2 capas","Toallitas húmedas wc","Papel vegetal para tosty"]),BE=conjunto(["Contorno de ojos","Corrector Stick Deliplus 01","Desmaquillante","Discos de algodón","Exfoliante","Gel de limpiadora mimi y adri","Máscara 24 horas","Mascarilla Hidra Hialurónico Elvive cabello deshidratado","Multicorrector","Polvo maquillaje","Rimel","Sérum Plex Repair Deliplus cabello muy dañado","Toallitas desmaquillantes Micelar & Oil Deliplus para todo tipo de pieles","Tinte"]);
const ORDEN=new Map(CATEGORIAS.map((c,i)=>[c,i]));
function categoriaVisible(nombre,categoria){
  const c=String(categoria||"").trim();
  if(ORDEN.has(c))return c;
  const n=simplificar(nombre);
  switch(simplificar(c)){
    case "frutas y verduras":return FR.has(n)?CATEGORIAS[0]:CATEGORIAS[1];
    case "carnes y pescados":return CATEGORIAS[2];
    case "lacteos y huevos":return CATEGORIAS[3];
    case "despensa":return PA.has(n)?CATEGORIAS[7]:DE.has(n)?CATEGORIAS[5]:CATEGORIAS[4];
    case "limpieza y hogar":return PA.has(n)?CATEGORIAS[7]:CATEGORIAS[6];
    case "higiene personal":return BE.has(n)?CATEGORIAS[9]:CATEGORIAS[8];
    default:return c; // no sobrescribir categorías personalizadas
  }
}
function ordenarProductos(items){
  const col=new Intl.Collator("es",{sensitivity:"base",numeric:true});
  return items.map(p=>({...p,categoria:categoriaVisible(p.nombre,p.categoria)}))
    .sort((a,b)=>(ORDEN.get(a.categoria)??100)-(ORDEN.get(b.categoria)??100)||
      col.compare(a.categoria,b.categoria)||col.compare(a.nombre,b.nombre)||
      Number(a.id)-Number(b.id));
}
module.exports={CATEGORIAS,categoriaVisible,ordenarProductos};
