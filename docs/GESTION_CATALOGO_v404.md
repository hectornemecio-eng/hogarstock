# HogarStock v4.04 — Gestión del catálogo (rama de prueba)

## Alcance
Alta, edición de nombre/categoría y archivado lógico de productos desde el panel
administrativo. No se borra físicamente ningún producto ni se cambia la tabla
original: se crea la tabla auxiliar `hs_catalogo_archivados`.

## Controles
- Todas las escrituras exigen `http.adminWrite` (sesión + origen + CSRF).
- Nombre de 1–120 caracteres y categoría de 1–60, espacios normalizados, sin controles.
- Evita duplicados activos con coincidencia insensible a mayúsculas según SQLite.
- Edición y archivado se bloquean si el ID figura en una compra abierta no expirada.
- Alta durante compra abierta no añade automáticamente el nuevo producto a la compra.
- Archivo lógico oculta el producto del catálogo, sin eliminar su fila ni su historial.
- Consultas parametrizadas y transacciones de escritura contra la base seleccionada.
- Notificación por WebSocket exclusivamente a administradores después de confirmar cambio.
- La tabla auxiliar queda incluida en futuras exportaciones dinámicas v4.03.

## Limitaciones
- No existe pantalla para recuperar productos archivados todavía.
- El archivado no sustituye una política de retención de datos.
- El filtrado de duplicados depende de la semántica `lower()` de SQLite.
- No se crean compras ni se envían mensajes de WhatsApp por estas operaciones.
- En producción un despliegue requeriría crear la nueva tabla auxiliar al iniciar.
- La UI y la lógica requieren validación funcional manual tras eventual publicación.

## Validación y publicación
`tests/catalogo-v404.test.js` valida altas, errores, edición, archivo e integridad
referencial con SQLite ficticio en memoria. La CI de la rama ejecuta además
toda la batería de regresión existente. **No fusionar ni desplegar sin S/N.**
