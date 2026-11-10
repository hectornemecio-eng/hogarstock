# HogarStock v4.03 — Respaldo y recuperación

## Alcance y estado

El panel administrativo permite **descargar una copia cifrada de la base Turso** mediante la ruta segura `POST /api/admin/respaldo`. No borra ni modifica registros. Las pruebas restauran una copia **únicamente en SQLite en memoria**. No existe ninguna ruta que restaure o sobrescriba datos de producción.

**Límite importante:** un archivo `.hsbk` no contiene ni puede sustituir las variables privadas necesarias para que WhatsApp, la autenticación o la sesión de compradores funcionen en un nuevo alojamiento. La restauración completa exige preservar también las claves de entorno.

## Descargar una copia (sin programación)

1. Entra en `https://hogarstock.onrender.com` como administrador.
2. Abre «Descargar copia de seguridad» en el panel lateral.
3. Introduce tu **contraseña actual de HogarStock** para confirmar tu identidad.
4. Elige una **clave del respaldo de 12 a 200 caracteres**, introdúcela dos veces y consérvala en un gestor de contraseñas. Puede ser distinta de la contraseña de acceso.
5. Pulsa «Descargar respaldo protegido». Debe generarse un archivo de nombre `HogarStock_respaldo_*.hsbk`.
6. Comprueba que el fichero está en Descargas. **Guárdalo en un lugar distinto de Render**, por ejemplo una unidad externa, sin publicar el contenido ni la clave.
7. No es necesario descifrar y volver a cifrar el mismo fichero: ya se ha creado cifrado y verificado de manera automática antes de la descarga.

Si aparece «respaldo incompleto bloqueado», no borres ni recrees tablas. Identifica primero la tabla faltante; una copia parcial podría provocar pérdida de acceso o WhatsApp.

## Qué incluye

El archivo almacena el esquema SQLite y todos los registros de todas las tablas no internas disponibles en la base, dentro de una transacción de lectura coherente: inventario, registros de compras, invitaciones, sesión cifrada de WhatsApp, tabla de contraseña administrativa rotada y posibles tablas heredadas. Conserva índices explícitos, tipos de valores y estado AUTOINCREMENT.

El formato es propio (`HSBK01`), con JSON comprimido, `scrypt` y `AES-256-GCM`, sal e IV aleatorios. El fichero **no es un ZIP ni es legible sin su clave**. No se crean copias SQL sin cifrar en disco de Render.

## Lo que NO incluye: variables de entorno privadas

Guardar de forma independiente y segura las variables necesarias para restablecer el servicio, especialmente:
- `HS_WA_AUTH_ENC_KEY` — **imprescindible** para descifrar la sesión de WhatsApp contenida en la tabla cifrada.
- `HS_V2_SESSION_SECRET` y `HS_V2_BUYER_SECRET` — secretos de autenticación; preservarlos o planificar rotación de sesiones y enlaces de compra.
- `HS_V2_ADMIN_PASSWORD_SALT` y `HS_V2_ADMIN_PASSWORD_HASH` — material inicial de arranque. No sustituir la contraseña actual restaurada desde Turso.
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — conexión a la base que se decida recuperar.
- `WA_ALLOWED_NUMBERS`, `WA_CONTACT_NAMES_JSON`, `HS_WA_AUTH_STORAGE`, `PUBLIC_BASE_URL`, y demás configuración necesaria para el servicio.

No pegar valores de estas variables en ChatGPT, GitHub, correos, documentos de continuidad ni archivos no cifrados. Verificar la presencia en Render sin imprimir su valor.

## Restauración de laboratorio y evidencia

Los tests `tests/backup-v403.test.js` crean una base SQLite **solo en memoria** con 150 productos falsos, tres tablas de compra, hash/salt administrativos ficticios, WhatsApp cifrado simulado, lease y datos heredados.

Comprueban exportación, cifrado, integridad, rechazo de una clave equivocada, detección de cambios en el archivo, cobertura de tablas, recuperación del esquema y registros en una *segunda base aislada*, y que la fuente no se modifica.

**No se ha restaurado la base Turso real.** Para hacerlo en el futuro se exige un plan específico y autorización expresa, respaldo verificado e identificación del destino. Un lease WhatsApp antiguo no debe reactivarse; los enlaces de compra expirados requieren revisión y quizá revocación.

## Verificaciones operativas

- [ ] Se ha descargado físicamente el archivo `.hsbk` desde el panel real.
- [ ] Se ha guardado la clave del respaldo por separado y sin compartirla.
- [ ] Se ha preservado el secreto `HS_WA_AUTH_ENC_KEY` fuera del servicio.
- [ ] Se han conservado los secretos de identidad y conexión.
- [x] Las restauraciones automatizadas funcionan contra datos ficticios en memoria (tras CI).
- [ ] Recuperación real en instalación independiente verificada (no autorizar implícitamente).

## Límites y riesgos

La captura es puntual, no automática. Los cambios posteriores requieren otro respaldo. Una exportación puede fallar durante un mantenimiento de Turso; no se entrega un archivo parcial. La sesión de WhatsApp depende de un proveedor no oficial y de sus políticas externas; disponer de las credenciales no garantiza reconexión futura.

El archivo contiene **datos sensibles cifrados**: custodiarlo como una copia de información privada. La clave perdida no se puede reconstruir. La prueba aislada del archivo no implica garantía de una recuperación completa en otro proveedor sin los secretos externos.
