# HOGARSTOCK v4.04 — Candidata de publicación

**Fecha:** 2026-11-11
**Rama:** `rc-v404-catalogo-2026-11-11`
**Base:** `main`, commit `efe728720673df5e7c16bcfd58f08d473db4f722`
**Estado:** no publicada; autorización del usuario para desplegar: **NO**.

## Funciones incluidas

- Crear productos y editar nombre/categoría desde el panel administrativo.
- Archivar productos sin eliminar físicamente las filas ni el historial.
- Evitar duplicados del catálogo activo.
- Bloquear edición o archivo de productos asociados a compras abiertas.
- Impedir reactivar productos archivados por rutas antiguas.
- Mostrar catálogo actualizado a administradores vía WebSocket.

## Diferencias respecto al laboratorio

El laboratorio Windows v4.04 ya existe en `feat-gestion-catalogo-v404-2026-11-11`.
Se excluye del código candidato el soporte de HTTP loopback para sesiones,
cookies especiales, servidor de demostración y paquete `.cmd`.
La configuración de seguridad de producción se conserva de `main`.

## Validación necesaria

- [ ] GitHub Actions CI candidata: sintaxis, 31 regresiones e inexistencia de cambios de laboratorio.
- [ ] Prueba práctica desde navegador **solo tras autorización de publicación**.
- [ ] Verificación real del recorrido de compra y envío WhatsApp tras publicar.
- [ ] Restauración completa desde respaldos, aplazada hasta recuperar USB.

## Riesgos y límites

- CI confirma comportamiento con datos ficticios, **no** pruebas reales en Turso ni WhatsApp.
- El primer despliegue crearía la tabla `hs_catalogo_archivados` en Turso. No
  se modifica ninguna tabla existente ni se ejecuta restauración.
- **Reversión:** volver al código v4.03 después de haber archivado productos
  podría hacer que esos productos reaparecieran, porque esa versión no conoce
  el registro de archivado. Evitar reversiones improvisadas si ya se ha usado la
  nueva funcionalidad; definir plan específico para conservar la semántica.
- El código actual no ofrece pantalla para restaurar un producto archivado.
- No hay disponibilidad 24/7 garantizada en Render Free ni garantías de
  continuidad para la integración no oficial con WhatsApp.

## Procedimiento de publicación futura (NO autorizado todavía)

1. Confirmar permiso explícito S/N para actualizar la rama `main` y Render.
2. Verificar el último respaldo cifrado disponible y la posibilidad de
   recuperar el servicio, indicando cualquier límite pendiente.
3. Promover solo el commit de esta RC a `main` sin incluir ramas de demo.
4. Confirmar Render `live` y el inventario sin cambios numéricos inesperados.
5. Verificar alta/edición/archivo sin interferir con compras activas, y
   un ciclo real de WhatsApp con los destinatarios autorizados.
6. No modificar secretos de Render ni contactos permitidos salvo autorización.

## Política local

No descargar archivos ni ejecutar pruebas en Windows salvo error que no
pueda verificarse en GitHub o autorización expresa. Mantener documento maestro
de continuidad actualizado por hito.
