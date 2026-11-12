# HogarStock v4.10 — Verificación de copias y plan de recuperación

## Principios vigentes
- **Sin gasto adicional.** Sin servicios contratados.
- No modificar productos, compras, mensajes ni credenciales para probar.
- No añadir ruta de restauración directa a Turso de producción.
- Los datos privados no se suben a GitHub, no se publican en logs y no se guardan en disco de Render durante la verificación.
- La verificación en línea solo se invoca explícitamente por el administrador sobre el archivo .hsbk que este seleccione.

## Dos archivos distintos
**.hsbk**: copia cifrada de las tablas de Turso, incluida la tabla cifrada de WhatsApp; contraseña propia (12-200 caracteres), distinta conceptualmente de la clave admin. **.hskeys**: bóveda previamente desarrollada para conservar parámetros secretos privados de Render, entre ellos `HS_WA_AUTH_ENC_KEY`, con su propia contraseña. Un .hsbk íntegro sin la clave de cifrado WA puede servir para recuperar inventario y compras, pero NO la sesión WA previa.

## Flujo en la interfaz
1. En **Descargar copia de seguridad**, se introduce la contraseña ADMIN para autorizar el acceso, la NUEVA frase para cifrar el .hsbk y su confirmación. El servidor crea un snapshot coherente, cifra con scrypt/AES-256-GCM, lo abre para validar y devuelve el archivo. No se modifica Turso.
2. En **Comprobar el respaldo descargado**, el administrador selecciona el .hsbk y su contraseña. El navegador envía un paquete binario por HTTPS al MISMO servidor Render, en una llamada autenticada con cookie + Origin + CSRF. La carga máxima web es **8 MiB**.
3. El servidor abre el archivo, valida hashes de todas las tablas, reconstruye SQLite **únicamente en memoria**, ejecuta `integrity_check` y `foreign_key_check`, verifica conteos y SHA-256; devuelve solo cifras generales y hash del archivo. No se crea archivo con el respaldo en Render, ni se hacen escrituras a Turso ni envíos WhatsApp.
4. Un archivo alterado, contraseña incorrecta, cuenta no autorizada, CSRF inválido, archivo grande o restauración incompatible generan errores controlados sin exponer contenido confidencial.

## Restauración de producción — procedimiento de recuperación ante desastre, NO automático
1. Identificar el motivo y comprobar estado/alcance de la incidencia. Evitar operar sobre una compra activa; documentar últimos mensajes WhatsApp sin reenviarlos.
2. Conservar intactos: .hsbk, .hskeys, contraseñas de ambos, copia del código (GitHub) y SHA-256 del .hsbk. No compartir en chats ni subir a repositorios.
3. Verificar .hsbk con la versión v4.10 antes de cualquier escritura en destino.
4. Crear **una base Turso nueva y vacía en cuenta gratuita** únicamente con autorización explícita. No reutilizar ni sobrescribir la base real. Restaurar primero ahí por un procedimiento aislado y auditable con credenciales independientes y validar tablas/conteos/foreign keys. No está automatizado en la aplicación.
5. Recuperar configuración de Render **en un entorno aislado**, con la bóveda .hskeys. `HS_WA_AUTH_ENC_KEY` debe coincidir exactamente con la utilizada para cifrar las credenciales incluidas en .hsbk.
6. Verificar sin envíos reales: acceso admin, inventario, archivados, compras, configuración cifrada WA. Eliminar concesiones caducadas y revisar leases antes de habilitar WhatsApp; nunca conectar simultáneamente dos instancias al mismo estado WA.
7. Solo después de comprobar y autorizar la operación, planificar cambio de instancia o base en ventana de mantenimiento, con rollback al estado anterior y verificación funcional final.

## Restricciones explícitas
- Pasar en memoria las pruebas NO valida aún un desastre real ni reemplaza un ensayo de recuperación aislado sobre una base separada.
- La prueba de servidor requiere disponer de la aplicación para usar la interfaz. Si Render no funciona, hacen falta la copia y un entorno de recuperación independiente.
- En la actualidad no hay copia .hsbk real proporcionada para verificación por el asistente; el usuario debe seleccionar el archivo en su navegador. No solicitar contraseñas al chat.
- La interfaz no incluye botón "restaurar producción": no debe añadirse sin procedimiento de autorización, protección contra pérdida de datos y rollback.

## Comprobación de aceptación
- CI completo sin errores, incluidos simulacros sobre datos inventados y pruebas de negativas.
- `main` actualizado, Render `live` con SHA de este hito.
- El usuario puede descargar un respaldo y volver a cargar ese archivo para verificar/restaurar en memoria.
