# HogarStock V3 — Coordinador WhatsApp desacoplado

**Fecha:** 2026-11-05. **Estado:** implementado y probado con un transporte falso; NO integrado en `server.js` ni conectado a una cuenta real. **Rama:** `seguridad-pruebas-2026-11-05`.

## 1. Archivos y alcance

- `whatsapp/auth-store.js`: almacena credenciales y claves Signal en SQLite/libSQL con AES-256-GCM, autenticación adicional vinculada a tipo/ID y clave externa `WA_MASTER_KEY`. Comprobado con Baileys 7.0.0-rc11 real y datos ficticios, sin enlazar una cuenta. Las pruebas de credenciales son independientes del coordinador.
- `whatsapp/coordinator.js`: orquesta un socket Baileys **inyectado** y el almacén sin importar ni instanciar Baileys. Controla inicio, parada, QR privado, reconexión, bloqueo tras logout y bloqueo por fallo de persistencia. `crearAuth()` debe conectar al almacén cifrado en una integración futura; `fabricaSocket()` debe aportar el transporte verdadero. **No hacen ninguna conexión en este módulo por sí solas.**
- `tests/wa-coordinator.test.js`: diez pruebas con `EventEmitter` y transporte falso: privacidad QR, arranque idempotente, reconexión, cierre de sesión, fallo de persistencia, whitelist, teléfono inválido, ausencia de acuse, error indeterminado, parada y versión incorrecta.
- `.github/workflows/db-sqlite.yml`: ejecuta estas pruebas en CI junto con la regresión existente.

## 2. Máquina de estados

`inactivo` → `iniciando` → `conectando` → `esperando_qr` o `conectado`; cierres recuperables → `reconexion_programada` → nuevo inicio. Logout o error de escritura de credenciales → `bloqueado`; parada explícita → `detenido`.

Los tiempos de reconexión empiezan en 30 segundos y aumentan con límite de 300 segundos. Nunca se borra el almacén al recibir logout. Se limpia el QR al conectarse o cerrarse una sesión. Eventos de sockets antiguos se ignoran.

## 3. Seguridad del QR

- `leerEstadoPublico()` devuelve exclusivamente fase, conectado y código de error abstracto.
- `leerEstadoPrivado()` devuelve además el QR, pero **NO autentica por sí mismo al llamante**. Integrar exclusivamente detrás del middleware administrativo V3, nunca desde una ruta pública, un WebSocket global o logs.
- `notificarEstado` solo recibe estado público, sin QR, tokens ni teléfonos.

## 4. Mensajería

`enviarTexto({telefono,mensaje})` exige un teléfono internacional validado y una función externa de destinatarios permitidos. Los mensajes tienen límite de 4096 bytes; las respuestas nunca exponen JIDs ni contenido. El resultado `aceptado_por_proveedor` significa solamente que `sendMessage` devolvió identificador del mensaje: **no prueba entrega ni lectura**. Si falla la operación, se devuelve `indeterminado`, no `fallido` definitivo, porque la respuesta puede perderse después de un envío exitoso.

No hay reintentos automáticos de envío para evitar duplicados; tampoco existe en este módulo una cola duradera de mensajes, historial de entrega, recepción de mensajes ni acuses. Esos componentes están **pendientes**.

## 5. Límites del hito

Las diez pruebas utilizan un socket simulado. **No se ha demostrado conexión real a WhatsApp**, QR operativo, persistencia real de conexión tras reinicios de Render ni intercambio bidireccional. La prueba aislada de serialización con Baileys real verifica compatibilidad del almacén, no del transporte completo.

El token de cifrado, almacenamiento de sesiones y administración de destinatarios requieren una política de secretos y recuperación. La clave no debe publicarse en Git ni incluirse en documentos de continuidad.

## 6. Trabajo siguiente

1. Implementar registro durable de envíos con identificador de operación y estados distinguibles (`pendiente`, `aceptado_por_proveedor`, `indeterminado`, `confirmado_por_acuse` si existe evidencia); evitar reenvíos automáticos ambiguos.
2. Implementar recepción protegida de mensajes con lista de confianza, mensajes duplicados e identificación de compra; sin conceder permisos por teléfono sin control adicional.
3. Unir almacén cifrado y coordinador mediante `fabricaSocket` adaptada a Baileys real y confirmar eventos `creds.update` y `connection.update` en entorno de pruebas, **sin conectar sesión productiva**.
4. Exponer estado/QR únicamente mediante API administrativa V3 autorizada; probar ausencia de QR en rutas públicas.
5. Integración completa y pruebas funcionales, respaldo restaurable, simulaciones de reinicio, autorización de despliegue y rollback.
6. Mantener `main`, Render y Turso productivos intactos hasta autorización explícita. Presupuesto monetario incremental cero. Alternativa Google aplazada.
