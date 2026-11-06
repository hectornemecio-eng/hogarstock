# HogarStock V3 — Preparación de Turso de ensayo

**Fecha:** 2026-11-06. **Ámbito:** rama `seguridad-pruebas-2026-11-05`, sin alterar `main`, Render ni la base Turso real.

## Resultado del hito

Se implementó un preflight de identidad del destino y una inicialización independiente de todos los esquemas V3 sobre libSQL, validada mediante SQLite local y datos ficticios. **No se ha creado ni conectado ninguna base Turso remota**: no hay URL ni token de ensayo confirmados, y no debe utilizarse la base de producción como sustituto.

Archivos:
- `integration/turso-stage-guard.js`: valida estructura de URL y nombre esperado, exige dominio `*.turso.io`, distingue hostname de producción, no crea una conexión sin permiso explícito; inspecciona nombres de tablas en modo de solo lectura.
- `integration/turso-stage-bootstrap.js`: únicamente en una base totalmente vacía, confirmada como ensayo, crea `productos` con tres artículos ficticios y los esquemas de compras, sesiones, comprador, outbox, bandeja de entrada, aplicaciones administrativas y credenciales cifradas. No persiste una identidad WhatsApp ficticia. Rechaza secretos mal formados o reutilizados.
- `integration/run-turso-stage.js`: ejecutable manual con tres modos, controlados mediante `S`: sin red (predeterminado), solo lectura remota y creación explícita de esquema en una base vacía. Silencia errores que pudieran contener URLs, tokens o información privada.
- `tests/turso-stage.test.js`: pruebas con `@libsql/client` local que verifican bloqueo de destinos incorrectos, datos sintéticos, preservación de una base no vacía, apertura en segunda conexión y rechazo de claves distintas.
- `tests/turso-stage-cli.test.js`: pruebas del comando manual que verifican ausencia de actividad de red y escrituras mientras no se den las confirmaciones.
- `.github/workflows/db-sqlite.yml`: incluye estas comprobaciones en la regresión.

## Precondiciones para conectar un Turso remoto

1. El usuario debe tener una **base Turso SEPARADA de producción**, vacía y con nombre que empiece por `hogarstock-v3-test-`. Debe comprobarse que crearla y utilizarla no produce gastos o conversiones a plan de pago.
2. Confirmar el hostname exacto de ensayo y el hostname distinto de producción. Esta comparación es una barrera, **no verifica por sí sola la titularidad real o si hay un alias apuntando a producción**. La comprobación de identidad del recurso en el panel de Turso sigue siendo imprescindible.
3. Crear credenciales y tres secretos hexadecimales de 32 bytes **diferentes** para autenticación Baileys, registro de salida y bandeja de entrada. Deben conservarse en un gestor de secretos. **Nunca enviarlos por chat, commit, captura o informe.**
4. Instalar las dependencias en un entorno de ensayo aislado. No modificar el equipo del usuario ni Render sin autorización.
5. Sin esos requisitos, permanecer en modo `sin_red`.

## Modos del comando manual

`node integration/run-turso-stage.js`

La ejecución solo busca las variables de entorno; **no copia claves al repositorio**.

| Variable de entorno | Finalidad |
|---|---|
| `HOGARSTOCK_STAGING_TURSO_URL` | URL de Turso de ensayo, `libsql://...` o `https://...` |
| `HOGARSTOCK_STAGING_TURSO_TOKEN` | Token válido únicamente para esa base |
| `HOGARSTOCK_STAGING_TURSO_HOST` | Hostname exacto de la base de ensayo |
| `HOGARSTOCK_PRODUCTION_TURSO_HOST` | Hostname de producción para bloquear coincidencias |
| `HOGARSTOCK_STAGING_PERMITIR_RED` | Solo `S` abre conexión remota; cualquier otro valor mantiene el modo sin red |
| `HOGARSTOCK_STAGING_PERMITIR_ESCRITURA` | Solo `S` y además red permitida habilitan creación de esquemas, y solamente si la base está vacía |
| `HOGARSTOCK_STAGING_AUTH_KEY` | Clave exclusiva de credenciales cifradas Baileys V3 |
| `HOGARSTOCK_STAGING_OUTBOX_KEY` | Clave exclusiva del registro de salida cifrado |
| `HOGARSTOCK_STAGING_INBOX_KEY` | Clave exclusiva de identidad seudonimizada de remitentes |

En modo solo lectura, el programa ejecuta únicamente una consulta de nombres de tablas. En modo escritura, ejecuta la inicialización V3 únicamente si no existe ninguna tabla de usuario. **No hay comando de borrado, sobreescritura o restauración de la base productiva**. Si la operación se interrumpe, la base de ensayo puede quedar parcialmente inicializada y el comando se negará a repetirla sobre una base ya no vacía: el operador debe inspeccionar y reconstruir su *base de ensayo* fuera de este procedimiento; no se permite borrarla desde el script.

## Evidencia y límites

- CI con cliente libSQL auténtico y archivo SQLite local confirma que el esquema nuevo se inicializa con tres productos ficticios y puede volver a abrirse conservando compras y mensajes cifrados.
- El *preflight* remoto está implementado pero **NO se ha ejecutado contra Turso remoto**; no están comprobados latencia, TLS real, límites de plan, autenticación, backups, eventos concurrentes en Turso, restricciones de conexión o persistencia tras reinicios de Render.
- Antes de usar V3 sigue pendiente un ensayo autorizado con Turso de pruebas, cuenta WhatsApp de pruebas independiente, cierre de rutas V2, restauración efectiva de un respaldo, y despliegue con rollback.
- El límite económico es **cero cargos adicionales**, no una promesa de que cualquier servicio gratuito permita todos los ensayos. No activar servicios que requieran tarjeta, depósito o posibilidad de cobro.

## Política de seguridad

Este script no es un mecanismo de aprobación para usar producción ni una garantía criptográfica de que el hostname corresponde a una base separada; constituye una segunda barrera adicional a la verificación administrativa de identidad del recurso. `main` no se modifica ni se fusiona automáticamente. La migración a Google sigue pospuesta.
