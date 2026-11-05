# HogarStock V3 — Servidor aislado y prueba de navegador

**Estado:** solo desarrollo y CI. **NO despliegue**. El servidor real `server.js` sigue fuera de esta integración.

## Arquitectura de pruebas

- `integration/v3-sandbox-server.js`: arranca Express dentro de HTTPS, exclusivamente en `127.0.0.1` y puerto dinámico. Monta la API V3 y sirve `admin-v3.html` y `comprador-v3.html`.
- `tests/v3-browser-e2e.test.js`: usa Chromium/Playwright con **contextos de navegador separados** para administrador y comprador.
- Base de datos SQLite local **temporal**, poblada con tres productos ficticios; el servidor no se conecta a Turso ni envía mensajes.
- Sesiones administrativas y de compra en tablas V3 dentro del archivo temporal. Cookie `Secure`, `HttpOnly` y `SameSite=Strict` sobre HTTPS con certificado de prueba.
- Al finalizar los tests se cierran conexiones y servidor y se elimina el directorio temporal.
- El proceso solo inicia con `HOGARSTOCK_V3_SANDBOX=1`; bloquea `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` presentes; requiere certificado y llave para TLS.
- El uso de una contraseña de prueba **publicada en el código** es admisible únicamente porque el servidor escucha en loopback, usa datos sintéticos y no se conecta a sistemas reales. **Nunca usar en un despliegue**.

## Reproducción

La ejecución reproducible está definida íntegramente en `.github/workflows/db-sqlite.yml` sobre Ubuntu 24.04, Node.js 22, `@libsql/client@0.14.0`, Express 4.21.2, Playwright/Chromium y certificado TLS efímero con SAN `IP:127.0.0.1`. El trabajo de GitHub Actions instala las dependencias de pruebas en un directorio temporal del agente, sin añadirlas al `package.json` de producción.

La prueba recorre: login administrador, selección de productos faltantes, creación de compra, invitación de un solo uso, activación de la sesión de comprador en otro contexto, marca de comprado, finalización, actualización del panel administrativo, lectura del informe de conciliación y comprobación de preservación del catálogo. Comprueba asimismo el rechazo de una invitación consumida y el rechazo del catálogo administrativo a un visitante.

## Restricciones de interpretación

Que una prueba HTTPS de Chromium en CI termine correctamente **no demuestra** compatibilidad con Safari/iOS/Android, proxy real de Render, Turso remoto, WebSockets ni WhatsApp. Tampoco sustituye auditoría de autorización de todas las rutas heredadas, recuperación del respaldo mediante restauración o verificación de costes y configuraciones de despliegue.

**NO publicar V3** ni fusionar esta rama en `main` hasta integrar y proteger el servidor real y establecer un proceso de restauración y rollback. No cargar secretos reales en la batería E2E.

## Incidencias de CI observadas

La ejecución inicial de navegador en Ubuntu 26.04 falló antes de las pruebas de Chromium por incompatibilidad del Playwright seleccionado con el SO del agente. Se fijó `ubuntu-24.04`.

La siguiente ejecución completó un flujo real de compra y la prueba de visitante, pero falló al intentar abrir una segunda sesión con un enlace vacío porque el test no esperó a la generación asíncrona de la invitación. La espera fue corregida en `tests/v3-browser-e2e.test.js`. Una ejecución con las tres pruebas correctas debe constar como `success` antes de declarar el hito validado.

## Próximos pasos

1. Confirmar ejecución E2E verde y registrar URL/commit exactos.
2. Ampliar pruebas de navegador (móvil, recuperación, acceso caducado, errores de red, concurrencia).
3. Auditoría previa a la integración con `server.js` de todas las rutas V2, WebSockets, QR y teléfonos incrustados. Integración coordinada, no parche parcial.
4. Definir envío de WhatsApp fiable, registro honesto de entrega e historial; nunca afirmar envío por el mero hecho de abrir el enlace.
5. Validar restauración de backups aislada y preparar despliegue autorizado con rollback.

**Migración a Google:** aplazada por decisión del usuario. **Coste adicional:** cero.
