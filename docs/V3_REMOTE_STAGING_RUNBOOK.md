# HogarStock V3 — preparación de staging remoto (sin producción)

## DECISIÓN VIGENTE: RENDER (08/11/2026)

> El usuario ha decidido **continuar con Render**. Northflank, Enzonic y otros proveedores quedan **en pausa** hasta nueva instrucción explícita. Los análisis históricos de alternativas que aparecen a continuación no son una recomendación de migración ni autorizan nuevas cuentas, recursos, tarjetas o cargos. El alojamiento V2 en Render, la rama `main` y sus datos siguen intactos. Para el plan operativo vigente, consultar `docs/V3_RENDER_CONTINUIDAD_DECISION_2026-11-08.md`.

---


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


## Verificación offline de respaldo — implementada 2026-11-08

Existe un verificador independiente: `integration/v3-verify-staging-backup.js`.

**Entrada:** un archivo `.sqlite` autocontenido, obtenido de una exportación autorizada y coherente de la **base de ensayo**, el SHA-256 real del archivo, el hostname y el comprobante de esa base, y un directorio temporal fuera del repositorio. **No utilizar jamás un respaldo de V2/productivo.**

El verificador:
1. Rechaza rutas inexistentes, formatos no SQLite, SHA-256 distintos y etiquetas de identidad incorrectas.
2. Copia el respaldo a un directorio temporal de ensayo y comprueba que la copia tiene el mismo SHA-256.
3. Abre la COPIA con libSQL local, ejecuta `PRAGMA integrity_check`, valida la tabla `hogarstock_v3_stage_proof`, revisa las tablas V3 y confirma el catálogo.
4. No imprime tokens, credenciales, filas de usuarios, contraseñas ni el comprobante `proof_id`.
5. Conserva la copia temporal para que pueda eliminarse **después de terminar Node**, evitando el problema Windows `EPERM`. Nunca borra ni sobrescribe el archivo original.

**Ejecución de futuro ensayo:** el operador configura en un proceso local aislado `HOGARSTOCK_STAGING_BACKUP_FILE`, `HOGARSTOCK_STAGING_BACKUP_SHA256`, `HOGARSTOCK_STAGING_TURSO_HOST`, `HOGARSTOCK_STAGING_PROOF_ID` y `TMP` apuntando a D:, y ejecuta `node integration/v3-verify-staging-backup.js`. No introducir estos valores en GitHub ni en el chat. La verificación local del snapshot es condición **necesaria, no suficiente**: además se debe acreditar que dicho snapshot procede realmente de la base Turso remota de ensayo y es recuperable en una segunda base separada. La restauración Turso real no se ha efectuado.

**CI de evidencia:** `tests/v3-verify-staging-backup.test.js` contiene seis casos de verificación/restauración ficticia, hash falso, identidad errónea, archivo corrupto, directorio inseguro y parámetros inválidos. El workflow `v3-staging-smoke.yml` ejecutó **29/29** con Node 20.11.0 y **29/29** con Node 22 en run **42482030742**, commit `1daae58e13c2c6f93b409406f19f577b1f9e651b`; el workflow general run **42482030550** también pasó. No hubo conexión remota ni despliegue.

**Barrera económica:** Render API permite consultar plan Free del servicio `hogarstock`, pero no las cuotas de instancias Free del workspace ni su facturación. Las 750 horas mensuales son compartidas y agotar el cupo suspende TODOS los servicios Free. No crear otro Render sin revisar Billing ni el riesgo para V2. El plan Turso Free es público, pero las cuotas/overages de la cuenta no se han comprobado.


## Ampliación v3.54 — hosting alternativo con DNS explícito (2026-11-08)

**Evidencia de código:** commit `c8c4803b0b330c7c94e899e0312db0fe6b4b9155`; workflow staging `42496038877`, **78/78** en Node 20.11.0 y **78/78** en Node 22; regresión general `42496038676` completada correctamente. Solo ensayos offline con SQLite ficticia.

El perfil de origen remoto dispone ahora de **dos variables nuevas, obligatorias y privadas**:

| Variable | Ejemplo puramente ilustrativo |
|---|---|
| `HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER` | `render`, `northflank` o `enzonic` |
| `HOGARSTOCK_V3_REMOTE_STAGE_HOST` | Host exacto del futuro dominio de staging, sin esquema ni puerto |

El validador exige coincidencia exacta entre el proveedor, el host declarado y el host de `HOGARSTOCK_V3_REMOTE_STAGE_ORIGIN`, con `https://`, sin puerto, usuario, contraseña, ruta, parámetros ni fragmento. Solo permite nombres específicos de staging:

- Render: `hogarstock-v3-stage.onrender.com` (solo ejemplo).
- Northflank: `p01--hogarstock-v3-stage--aleatorio.region.code.run`; el nombre exacto se obtendrá del panel si se autoriza su creación.
- Enzonic: `hogarstock-v3-stage.spain.free.enzonic.com` o `hogarstock-v3-stage.us.free.enzonic.com`, si el proveedor asigna realmente esos nombres.

**No hay dominios ni cuentas creadas.** Un host aceptado sintácticamente no implica verificación de propiedad, seguridad operativa, disponibilidad ni aprobación de pago. Sigue prohibido usar credenciales de producción y las tres banderas de conexión, respaldo y escritura permanecen en `N` hasta autorización separada.

**Actualización de la evaluación de proveedores:**

- Northflank: la página de precios de 2026 declara Sandbox **sin tarjeta**, dos servicios, uno de base de datos y hasta 20 USD mensuales incluidos; su documentación de facturación accesible al mismo tiempo sigue diciendo que **todos** los usuarios deben añadir un método de pago para crear recursos. No hay prueba de límite duro de gasto. **No dar de alta recursos ni introducir tarjeta.**
- Enzonic: `https://www.enzonic.com/nodejs` ofrece, según su propia publicidad, un servidor Node 22 de 512 MB, 50 % CPU, 10 GB SSD, sin tarjeta y sin suspensión por inactividad. Otra página oficial (`https://enzonic.com/es/web-hosting`) menciona **3,5 GB RAM** para el nivel gratis, una discrepancia comercial no resuelta. No se ha demostrado fiabilidad, capacidad real disponible, política de límites o soporte operativo. **Candidato bajo verificación, no aprobado**.
- Render actual: Free hiberna tras 15 minutos sin tráfico entrante, comparte 750 horas mensuales por workspace, disco efímero. No crear un segundo servicio que pudiera consumir las horas de V2.

**Próximo paso económico:** confirmar en cada proveedor, **sin tarjeta, pagos, recargas ni depósitos**, la cuota asignada por el panel y la política de agotamiento (si bloquea/suspende o genera deuda). Si no se puede garantizar ausencia total de cargos, no desplegar. Hasta entonces pueden seguir avanzando pruebas y auditorías locales.

Fuentes oficiales verificadas:
- https://northflank.com/pricing
- https://northflank.com/docs/v1/application/billing/pricing-on-northflank
- https://northflank.com/docs/v1/application/network/configure-ports
- https://www.enzonic.com/nodejs
- https://enzonic.com/es/web-hosting
- https://render.com/docs/free
