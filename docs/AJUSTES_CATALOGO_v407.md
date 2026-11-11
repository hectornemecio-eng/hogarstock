# HOGARSTOCK v4.07 — Actualización del catálogo (11/11/2026)

## Solicitud
Desdoblar cuatro productos y añadir siete. Nombres exactos:

- Panecillos mercadona e integral → Panecillos mercadona + Panecillos mercadona integral.
- Pan de molde 100% integral sin corteza Hacendado 0% azúcares añadidos → Pan de molde 100% integral + Pan de molde sin corteza blanco.
- Yogurt grande → Yogurt griego grande + Yogurt griego pequeño.
- Queso Mozarella Rebanado y rallado → Queso Mozzarella Rebanado + Queso Mozzarella rallado.
- Añadir: Chuleta; Leche de almendra; Leche entera; Harina de Trigo; Harina de pizzas; Muslos de pollo deshuesado; Contramuslos de pollo deshuesado.

## Seguridad y operación
- Aplicación automática **en producción** al arrancar o cuando termine la compra activa; sin necesidad de PC ni contraseña.
- Única transacción: cuatro cambios de nombre y once altas si las cuatro referencias originales están activas y los nuevos nombres no existen.
- Se conserva el ID y valor `agotado` de la variante original renombrada. Los productos adicionales comienzan `agotado=0` (disponibles); no se envían listas WhatsApp.
- Categorías históricas y archivados sin cambio; nuevas altas en categorías oficiales.
- Tabla auxiliar `hs_catalogo_revision_v407`: registra conteos, fecha, nombres antiguos y nuevos, IDs y estados para auditoría; bloquea ejecuciones repetidas.
- Si existe una compra compartida activa, se aplaza toda la operación hasta que finalice. Si hay un conflicto de nombre, se cancela la transacción sin cambios parciales y se avisa por log.
- Tras aplicar se envía actualización visual de productos por WebSocket.
- Conteo esperado: de 150 a **161**, condicionado a catálogo real de producción. Se comprueba en Render, no se supone.

## Límites
Se conserva el historial vinculado al ID, aunque una consulta histórica por ese ID mostrará el nombre actualizado. El registro auxiliar guarda su nombre anterior.
No hay modificaciones del motor WhatsApp, credenciales, proveedores, tareas ping ni interfaz ajena al catálogo.
