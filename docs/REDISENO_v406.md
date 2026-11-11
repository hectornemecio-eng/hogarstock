# HogarStock v4.06 — Interfaz responsive y 10 categorías

## Cambios realizados
- 10 categorías visibles sin subcategorías, con iconos homogéneos y colores de identificación.
- Estilos accesibles y adaptativos en ordenador y móvil, sin añadir controles ficticios.
- Alta y edición de productos mediante selector con diez opciones; categorías personalizadas preexistentes conservables.
- Categorías del comprador y del administrador coherentes.
- Contadores dinámicos (no los números simulados de la maqueta).

## Protección de datos
**No se migran los registros de Turso.** Las categorías antiguas se convierten solo para su presentación, sin modificar ID, agotado, compras, WhatsApp ni historiales. Volver a la v4.05 resulta posible sin reversión de datos. Las nuevas altas usan la categoría oficial; una edición deliberada de un producto puede guardar la categoría seleccionada.

## Reparto de los 150 productos originales
Frutas 10; Verduras y tubérculos 16; Carnes, pescados y embutidos 14; Lácteos y huevos 12; Despensa y cocina 27; Desayunos, snacks y bebidas 17; Limpieza y lavandería 12; Papel y artículos del hogar 10; Higiene personal 18; Cosmética y belleza 14.

## Advertencias
La fuente de clasificación es el catálogo inicial incluido en db.js. Los recuentos reales se obtienen de la base al consultar y pueden variar si hay productos añadidos o archivados. Las categorías personalizadas quedan preservadas, por lo que podrían mostrarse más de diez grupos en ese caso.

La interfaz del comprador conserva la funcionalidad de compra compartida; el panel de compra y WhatsApp no se alteran.
