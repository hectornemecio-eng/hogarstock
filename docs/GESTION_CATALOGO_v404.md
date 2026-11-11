# HogarStock v4.04 — Gestión del catálogo (candidata de publicación sin desplegar)

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
- Archivo lógico oculta el producto del catálogo y desmarca agotado, sin eliminar su fila ni su historial. Impide que el producto entre en una compra posterior.
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

## Revisión de consistencia (11/11/2026)
- Corregida vía administrativa alternativa: `POST /api/agotar/:id` comprueba
  en la **misma transacción** que el producto no está archivado.
- No se marca como agotado ni se incorpora a una compra futura un producto archivado,
  aunque se invoque manualmente una ruta antigua.
- Si el cambio ya quedó confirmado, un fallo posterior del broadcast o de la lectura
  del catálogo no devuelve un falso error; el cliente puede resincronizar.
- Cobertura mediante pruebas de laboratorio con libSQL, sin Turso real ni WhatsApp.

## Candidata limpia (11/11/2026)
Esta versión RC se construye desde el commit v4.03 de `main`, incluyendo
solo el módulo de catálogo, el panel, los permisos/consistencia de compra y las pruebas.

**NO incorpora** la configuración de demostración HTTP en bucle local, ni las
alteraciones de cookies de laboratorio, ni el iniciador Windows. El laboratorio
permanece en su rama experimental original, totalmente separada.

La candidata debe superar el CI en GitHub antes de solicitar autorización
para publicar. En ausencia de autorización, no modificar `main` ni Render.
