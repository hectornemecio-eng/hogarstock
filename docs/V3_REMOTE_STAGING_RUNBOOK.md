# HogarStock V3 — preparación de staging remoto (sin producción)

Fecha: 2026-11-08. Rama: `seguridad-pruebas-2026-11-05`.

## Estado confirmado

La integración remota está **implementada, pero NO desplegada**. Las pruebas de CI son OFFLINE, con un cliente Turso simulado mediante SQLite local. `npm start` sigue iniciando V2 (`server.js`) y no hay cambio en `main`, Render V2, Turso productivo ni WhatsApp real.

Entrypoint exclusivo de futuro staging:

`node integration/v3-remote-staging-entrypoint.js`

No usar como comando de arranque del servicio V2.

## Coste cero: condiciones de precedencia

**No crear ni activar recursos** antes de verificar las cuotas libres y que la cuenta no puede generar cobros.

- Render documenta un plan Free y **750 horas de instancia Free por workspace y mes**, compartidas. Los servicios gratuitos hibernan tras inactividad y no disponen de disco persistente. Un segundo servicio de staging podría consumir horas del mismo cupo que V2. Verificar cuotas reales, método de pago y límites antes de crear otro.
- Turso ofrece un plan Free, sujeto a cuotas de bases, almacenamiento y operaciones. Verificar que la base de ensayo adicional cabe en el plan gratuito.
- Si existe un método de pago asociado a Render, agotamiento de ancho de banda o minutos de build puede generar cargos; comprobar y restringir el gasto antes de utilizar staging.
- No activar ningún plan pagado, prueba de pago, recarga ni tarjeta nueva. Si no se puede garantizar ausencia de cobros, **no desplegar**.

Fuentes oficiales: https://render.com/docs/free y https://turso.tech/pricing (consultadas 2026-11-08).

## Aislamiento obligatorio

1. Servicio Render **nuevo y diferente** de `hogarstock.onrender.com`, por ejemplo `https://hogarstock-v3-stage.onrender.com` si ese nombre está disponible. No cambiar el servicio actual.
2. Base Turso **nueva y vacía** con hostname que cumpla `hogarstock-v3-test-*.turso.io`. No usar un duplicado con las credenciales productivas ni una base V2.
3. Inicializar esa base únicamente con el script `integration/run-turso-stage.js`, que bloquea la red y la escritura salvo confirmaciones `S` independientes. El inicializador crea tres productos ficticios y una tabla `hogarstock_v3_stage_proof` con hostname y un comprobante aleatorio. Si la base contiene tablas, aborta sin modificarla.
4. Confirmar y guardar de manera **privada** un respaldo independiente y restaurable de la base de ensayo. Su SHA-256 se declara al servicio: **el proceso de inicio comprueba la forma del digest, pero NO verifica por sí mismo la existencia o restaurabilidad del respaldo**. Eso requiere una operación externa de verificación.
5. Consultar, en la base **de ensayo**, únicamente `SELECT host, proof_id FROM hogarstock_v3_stage_proof WHERE id=1;` y proporcionar ese identificador al servicio separado. La aplicación compara el host y el comprobante **antes de iniciar operaciones de escritura**.
6. No permitir WhatsApp real en esta fase. El puente Baileys V3 sigue sujeto a pruebas de integración remota específicas.

## Configuración privada para el futuro servicio Render de staging

Definir las siguientes variables **en la configuración privada del nuevo servicio**; nunca en el repositorio, capturas, registros o conversaciones compartidas:

| Variable | Requisito |
|---|---|
| `HOGARSTOCK_V3_REMOTE_STAGE` | `1` |
| `HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN` | URL HTTPS del servicio nuevo, nombre `hogarstock-*-stage.onrender.com` |
| `HOGARSTOCK_STAGING_TURSO_URL` | URL `libsql://` exclusiva de base de ensayo |
| `HOGARSTOCK_STAGING_TURSO_HOST` | Host Turso de ensayo exacto |
| `HOGARSTOCK_PRODUCTION_TURSO_HOST` | Host de producción, solo para comparación: **sin token** |
| `HOGARSTOCK_STAGING_TURSO_TOKEN` | Token **solo** de la base de ensayo |
| `HOGARSTOCK_STAGING_ADMIN_HASH` | Hash scrypt V3 creado localmente, **no** contraseña en claro |
| `HOGARSTOCK_STAGING_INBOX_KEY` | Clave de bandeja de ensayo, 64 hex, igual a la usada al inicializar la base de ensayo |
| `HOGARSTOCK_STAGING_PROOF_ID` | 32 hex de la marca guardada en la base de ensayo |
| `HOGARSTOCK_STAGING_BACKUP_SHA256` | SHA-256 de respaldo independiente verificado (64 hex) |
| `HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_CONNECT` | `N` por defecto; `S` solo tras validar separación y coste |
| `HOGARSTOCK_V3_REMOTE_STAGE_BACKUP_CONFIRMED` | `N` por defecto; `S` tras recuperación comprobada |
| `HOGARSTOCK_V3_REMOTE_STAGE_ALLOW_WRITE` | `N` por defecto; `S` únicamente con permiso expreso |
| `PORT` | Puerto indicado por Render |

**No** establecer `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `WA_MASTER_KEY`, `WA_ALLOWED_NUMBERS`, `WA_AUTOMATION`, `HOGARSTOCK_V3_WHATSAPP_LIVE` ni `HOGARSTOCK_V3_SANDBOX` en este servicio. El código rechaza cualquier perfil mixto.

**La mera presencia de una etiqueta de staging o un SHA-256 no acredita propiedad ni respaldo real.** La identidad remota y el respaldo deben comprobarse fuera del proceso. No habilitar las tres banderas de autorización en `S` sin esa evidencia.

## Validaciones previstas tras obtener autorización

- Confirmar que el servicio V3 nuevo responde `/health` con `version: 3`, que las rutas V2 devuelven `410`, y que el administrador V3 inicia sesión en el dominio de staging.
- Reiniciar el servicio y verificar persistencia de datos ficticios en Turso de ensayo.
- Probar una restauración de respaldo en **otra** base de ensayo nueva, sin borrar o sobrescribir el origen.
- Verificar que el servicio V2 y su base de datos permanecen intactos; no reutilizar credenciales, QR, tokens o números reales.
- Mantener una ruta de reversión del **servicio nuevo**, sin modificar `main` ni el servicio V2.

## Evidencia automatizada

CI ejecuta `tests/v3-remote-staging.test.js` con base **SQLite local inyectada**. Esto comprueba aislamiento, rechazo de claves productivas, prueba de identidad, requisitos de respaldo/confirmación y HTTP de V3. **No** prueba latencia/estabilidad en Render, red Turso real ni WhatsApp.

Próxima puerta de autorización: validar en cuentas Render y Turso **existencia de cuota gratuita** y que el usuario acepta crear recursos externos independientes. Nunca presentar este documento como una migración ya realizada.
