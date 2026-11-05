# HogarStock V3 — Bandeja de entrada WhatsApp aislada

**Fecha:** 2026-11-05. **Ámbito:** diseño defensivo y pruebas con datos sintéticos. **No conexión real a WhatsApp ni modificaciones de producción.**

## Arquitectura implementada

- `whatsapp/inbox-store.js`: almacén persistente de recepción sobre libSQL, con nuevas tablas `hogarstock_wa_links_v3` y `hogarstock_wa_inbox_v3`.
- `tests/wa-inbox.test.js`: siete pruebas con libSQL real y SQLite local; cubren aislamiento de compras, vínculos, caducidad, revocación, duplicados, mensajes desconocidos y cambio de secreto HMAC.
- `.github/workflows/db-sqlite.yml`: incorpora comprobación de sintaxis y ejecución junto a la regresión.
- `main`, Render, Turso real y sesión Baileys actual permanecen intactos.

## Modelo de confianza

1. **Vincular un número a una compra no es autenticación suficiente por sí solo.** `vincularRemitente()` debe ser invocado exclusivamente por un servicio administrativo autorizado que compruebe compra y destinatario. No se ha expuesto una ruta pública.
2. **El mensaje entrante debe provenir de eventos de un socket Baileys autenticado**. El módulo recibe `telefono`, `mensajeId` y `texto` como argumentos de una función interna; por sí mismo NO comprueba que la red WhatsApp haya originado esos datos. Nunca aceptar estos parámetros directamente de una petición HTTP del comprador.
3. Las identidades se guardan como huellas HMAC con clave externa y el ID remoto del mensaje también se transforma con HMAC. No se almacenan números de teléfono, ID remotos ni contenido libre sin procesar en estas tablas; sí se conserva el estado y el ID/acción propuestos.
4. Un remitente con **más de una compra activa vinculada** produce un evento `ambigua`, sin adjudicarlo automáticamente a una compra.
5. Un remitente sin vínculo vigente, revocado, caducado o asociado a una compra finalizada es rechazado sin crear una entrada.
6. Mensajes con formato estricto `COMPRADO <id>`, `NO DISPONIBLE <id>`, `PENDIENTE <id>` son aceptados solamente si el artículo pertenece a la única compra abierta vinculada.
7. La propuesta se guarda como `pendiente_revision`, `ambigua` o `no_interpretable`. La operación `revisar()` marca `revisada` o `descartada` pero **no actualiza `compra_items` ni `productos`**. El mecanismo para autorizar y aplicar propuestas con control de versiones aún está pendiente.
8. La bandeja usa deduplicación SQL por huella del remitente más ID remoto. El comportamiento en presencia de eventos simultáneos y reinicios del proceso requiere ampliación de pruebas; la ejecución actual utiliza dos conexiones, con eventos secuenciales.

## Evidencia

GitHub Actions: https://github.com/hectornemecio-eng/hogarstock/actions/runs/42058620801

Commit probado: `5186b55283587a3bccf46ea1b97b78dddad8e2a9`.

Resultados: **117/117 pruebas**, cero fallidas; 55 pruebas componentes, 37 pruebas libSQL (7 nuevas de recepción), 18 API HTTP, 7 Chromium/HTTPS y frontera de rutas.

## Riesgos y trabajo pendiente para usar V3

- Adaptador de **eventos entrantes reales Baileys**, con identificación robusta del tipo de mensaje, `fromMe`, `remoteJid`, normalización, origen y duplicados. No basar permisos en un JID recibido de un cliente HTTP.
- Determinar con precisión a qué compra corresponde cada respuesta. El formato numérico de prueba no se considera todavía UX definitiva, ni permite distinguir varias compras del mismo remitente; habrá que diseñar referencias explícitas y comprobables.
- Protocolo de aceptación de propuestas por administrador: permisos, trazabilidad, versiones optimistas y aplicación segura al artículo.
- UI de seguimiento de respuestas, errores y confirmaciones. Actualización de estados entre dispositivos.
- Integración real de Baileys, almacenamiento cifrado de claves, persistencia de sesión tras reinicio de Render y tratamiento de caídas/cortes.
- Turso remoto de **pruebas**, migraciones sin borrado, restauración aislada del respaldo y rollback.
- Cierre de la superficie pública V2 antes de sustituir producción.
- La alternativa Google está aplazada y el coste adicional autorizado es 0 €.

## Regla de despliegue

**No fusionar ni desplegar** solo por superar las pruebas locales: la bandeja es un componente aislado sin verificación de origen WhatsApp real ni flujos de autorización de producción.
