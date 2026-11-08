# HogarStock V3 — Cierre, aviso único y devolución de faltantes (laboratorio)

**Fecha:** 2026-11-08  
**Ámbito:** rama `seguridad-pruebas-2026-11-05`, SQLite **ficticia** y transporte de salida **simulado**. No es un despliegue productivo ni un servicio de WhatsApp conectado.

## Objetivo funcional

Conectar el procesador `COMPRADO <itemId>` del laboratorio con un **cierre de compra transaccional**, una notificación que no se duplique tras reinicios y la devolución de faltantes **solo con cierre explícitamente autorizado**.

### Archivos

- `whatsapp/outbox-store.js`: operación `registrarSolicitudEnTransaccion` que permite registrar el mensaje cifrado dentro de la transacción propietaria de la compra, evitando separación temporal entre el cierre y la reserva.
- `whatsapp/v3-close-notify-lab.js`: `crearCierreNotificadorV3`, con método `cerrarYNotificar`; validación de destinatario, cierre de compra, mensaje de todos comprados o faltantes, encolado idempotente y despacho inyectado después del commit.
- `whatsapp/v3-auto-apply-verified.js`: callback opcional `notificarCierre` tras aplicar el último `COMPRADO`; no interfiere con revisión manual por defecto.
- `tests/v3-close-notify-lab.test.js`: 12 pruebas reales del almacenamiento y adaptador, usando SQLite ficticia y transporte simulado.
- `.github/workflows/v3-staging-smoke.yml`: incluye realmente la suite nueva; su ejecución se comprobó en los **logs**, no solo por el estado verde del workflow.

## Semántica exacta

1. **Habilitación:** ambas variables deben estar en el entorno aislado, `HOGARSTOCK_V3_SANDBOX=1` y `HOGARSTOCK_V3_CLOSE_NOTIFY_LAB=1`. Se rechaza `HOGARSTOCK_V3_WHATSAPP_LIVE`, staging remoto, variables Turso y variables `WA_*` con contenido. El módulo no abre sockets ni se monta en V2 o Render.
2. **Destinatario:** el método recibe el teléfono del evento interno verificado o de una acción administrativa autorizada, lo valida y exige `destinatarioPermitido(telefono) === true`. No aceptar teléfonos suministrados por HTTP público.
3. **Cierre completo:** únicamente si todos los artículos de la compra están en estado `comprado`; cierra y registra un aviso. Si quedan faltantes, requiere explícitamente `autorizarFaltantes:true` y devuelve un listado con nombres y estados. En caso contrario no cambia nada.
4. **Atomicidad:** la inserción OUTBOX y la actualización `hogarstock_compras_v3.estado='finalizada'` se realizan en una **misma transacción de escritura**. Un error o conflicto revierte la transacción.
5. **Idempotencia:** clave estable `HS-V3-CIERRE-UNICO-<compraId>` aplicada a **un único aviso por compra**, independiente del teléfono. Cambiar destinatario o contenido después de registrar el cierre provoca un conflicto, no otro mensaje.
6. **Despacho:** después de confirmar la transacción, `crearDespachador` intenta el envío por el emisor inyectado y persiste su resultado. La aceptación por proveedor **no demuestra entrega ni lectura**. Los errores inciertos quedan `indeterminado`, **sin reenvío automático**.
7. **Recuperación:** si el proceso se interrumpe después de confirmar la transacción y antes del despacho, el OUTBOX mantiene la operación pendiente. Un reintento explícito de `cerrarYNotificar` recupera el mismo ID y puede intentar el envío pendiente; no repite los ya aceptados o indeterminados.
8. **Catálogo:** el cierre actualiza la entidad compra, **no** modifica `productos.agotado`. Se requiere conciliación protegida para reflejar las reposiciones en el inventario.

**Límite relevante:** el modo automático solo se ensambla en una prueba aislada mediante el callback. No existe todavía un puente Baileys productivo que lo active. La acción de cierre con faltantes está disponible en el servicio interno para un operador autorizado, **no** como comando libre de cualquier mensaje entrante. La conciliación y el paso de resultado a WhatsApp real siguen pendientes.

## Evidencias GitHub Actions

**Commit de código validado:** `44b14a893bc1349b0b0d1062bd3c0088de2a131e`.  
**Staging CI:** https://github.com/hectornemecio-eng/hogarstock/actions/runs/42483302207  
**Regresión general:** https://github.com/hectornemecio-eng/hogarstock/actions/runs/42483302160

- Node **20.11.0**: `tests=50, pass=50, fail=0, cancelled=0, skipped=0`.
- Node **22**: `tests=50, pass=50, fail=0, cancelled=0, skipped=0`.
- Ambas ramas comprueban `MAIN_START_SIN_CAMBIOS=SI`.

Se trata de 50 casos distintos repetidos en dos versiones de Node; **no** de 100 casos diferentes. La primera ejecución del workflow solo había comprobado 38 por un error de inclusión; fue corregido antes de declarar superada esta fase.

## Riesgos y pruebas aún necesarias

- WhatsApp real: JID/LID, emisor autorizado, credenciales cifradas persistentes, reconexiones y acuses, sin reutilizar sesión V2 en laboratorio.
- Decisión de UX: el comprador necesitará una acción explícita y autenticada de `finalizar con faltantes`, no una interpretación automática de un texto ambiguo.
- Conciliación del inventario: evitar desmarcar como agotados productos compartidos por otras compras y verificar conflictos de concurrencia.
- Ensayo remoto Turso de prueba, respaldo restaurable y reversión de servicio Render independiente, **solo tras demostrar coste adicional cero** y obtener autorización.
- No copiar la configuración de simulación a Render. No exponer funciones internas de recepción ni despacho por HTTP sin autenticación.

**Estatus:** cierre y devolución de faltantes **validados exclusivamente en laboratorio**, no habilitados en producción.
