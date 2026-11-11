# HogarStock v4.08 — eliminar y recuperar productos sin perder historial

Fecha: 2026-11-11. Base publicada anterior: `c60e2892dbd3d9e3bbac7f8b20b54bb74bc55c0c`.

## Decisión funcional
"Eliminar" significa **retirar del inventario activo de forma recuperable**, usando la función de archivado ya existente. No se hace DELETE físico, lo que preserva historial, compras y datos para restauración. No se elimina ningún artículo al desplegar.

## Cambios
- Un botón de papelera accesible junto a cada producto (pantalla administrador, escritorio y móvil), separado del botón de marcarlo por comprar.
- Un segundo botón **Eliminar del inventario** dentro de Gestionar productos.
- Modal nativo de confirmación con el nombre exacto y explicación de recuperación.
- Errores claros ante intento de eliminar un producto de compra compartida activa.
- Panel de **Productos eliminados** con consulta y recuperación, sin perder IDs.
- Mensaje de resultado visible en la sección de inventario.
- Reutiliza la ruta `/api/admin/catalogo/archivar`, protegida como escritura administrativa y con comprobación transaccional de compra activa.
- Sin cambios en tablas, compras o WhatsApp; sin costos adicionales.

## Ping de Render
La auditoría GitHub Actions mostró **0 ejecuciones con event=schedule** hasta la comprobación previa. Los disparos push funcionaron, pero eso NO prueba que el cron se ejecute. Se modifica el cron a minutos UTC 09,19,29,39,49,59 para re-registrar el planificador en `main`. Se comprobará en GitHub tras publicación (push HTTP 200; programadas podrían seguir sin ejecutarse). GitHub advierte que los schedules pueden retrasarse, perderse o desactivarse por inactividad. No se promete disponibilidad 24/7.

## Validación
Pruebas de archivado reversible, protección de compras, permisos adminWrite, consistencia de UI, HTML seguro y responsive, regresión completa del proyecto. No ejecutar archivado real de productos durante validación.

## Verificación postpublicación
Confirmar CI éxito; Render `live`; endpoint público disponible; GitHub Actions push de ping HTTP 200; verificar si hay eventos schedule reales. Documentar que la función de eliminar está lista, aunque ningún producto se elimina sin acción del usuario.

## Límites
La modalidad seleccionada es reversible y no representa eliminación física definitiva. Si se necesita purga legal/definitiva de datos e historial, requiere una funcionalidad separada y revisión de integridad de claves externas antes de implementarla.
