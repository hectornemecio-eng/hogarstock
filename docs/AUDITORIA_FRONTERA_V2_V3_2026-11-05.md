# HogarStock — Auditoría de superficie V2 y frontera de integración V3

**Fecha:** 2026-11-05  
**Alcance:** revisión estática de `server.js`, `public/index.html`, `public/comprador.html`, `db.js` y módulos V3 en la rama `seguridad-pruebas-2026-11-05`.  
**Naturaleza de la evidencia:** el código expone los comportamientos descritos; no se han realizado peticiones ofensivas ni se ha accedido al servicio publicado. **No se ha cambiado `main`, Render, Turso ni la sesión real de WhatsApp.**

## 1. Veredicto

**No es seguro añadir las rutas V3 al `server.js` de V2 sin cerrar simultáneamente los accesos anteriores.** La autenticación de `/api/v3` no protege `/api/productos`, `/api/whatsapp-status`, `/api/agotar/:id`, `/api/iniciar-compra`, `/api/comprado/:id`, `/api/finalizar-compra` ni el WebSocket global. Un comprador podría entrar por V3 y otro visitante continuar utilizando V2 sin ningún permiso.

## 2. Inventario verificable de rutas heredadas

| Método | Ruta | Comportamiento en código | Autenticación declarada | Riesgo |
|---|---|---|---|---|
| GET | `/api/productos` | Lista completa del catálogo y estados | Ninguna | P1 — divulgación de inventario |
| GET | `/api/whatsapp-status` | Devuelve `conectado`, `qr`, `error` | Ninguna | P0 — exposición de QR de vinculación |
| POST | `/api/agotar/:id` | Invierte estado `agotado` | Ninguna | P0 — modificación arbitraria |
| POST | `/api/iniciar-compra` | Construye enlace con `?tel=` y solicita envío por Baileys | Ninguna | P0 — envío no autorizado y exposición de identificadores |
| POST | `/api/comprado/:id` | Cambia `productos.agotado=0` sin identificar compra | Ninguna | P0 — pérdida de semántica/historial |
| POST | `/api/finalizar-compra` | Consulta faltantes globales y puede emitir resumen al teléfono aportado | Ninguna | P0 — cierre sin identidad ni compra aislada |

El servidor monta `express.static("public")` sin autorización. `index.html` incluye destinatarios predefinidos con datos telefónicos en el HTML público; este documento omite sus valores deliberadamente. `comprador.html` almacena el teléfono recibido por URL en `localStorage`, y el identificador telefónico no equivale a un token de autorización.

## 3. WebSocket heredado

`new WebSocketServer({ server })` acepta conexiones sobre el servidor HTTP compartido. `broadcast()` transmite el mismo mensaje a todos los clientes; no valida sesión administrativa ni pertenencia a compra. El navegador de V2 abre un WebSocket desde las dos interfaces, y los mensajes `update` incluyen `productos`. Los eventos `qr_update` obligan a consultar el endpoint de estado, que a su vez es público.

**Bloqueo mínimo para una instalación V3 segura:** no exponer un canal WebSocket legado; si se habilita un canal nuevo, autenticación durante el upgrade, validación de origen y autorización por compra o rol antes de publicar mensajes. Mientras eso no esté construido, preferir actualización manual/polling autorizado.

## 4. WhatsApp y persistencia

La sesión Baileys de V2 utiliza `useMultiFileAuthState("auth_info_baileys")`, basada en archivos locales que pueden no persistir tras reinicios de Render Free. `sendMessage` puede fallar, mientras `/api/finalizar-compra` captura el error de envío y aun así responde `ok:true`; esta respuesta **no prueba entrega al destinatario**.

El `db.js` de la rama de pruebas fue corregido para no borrar `productos` ni repoblar tablas existentes vacías. Esa corrección **no está en `main`** a la fecha indicada. Debe mantenerse su verificación y completarse una prueba de restauración de backup.

## 5. Integración segura: requisitos no negociables

1. **No mezclar V2 pública y V3 protegida.** La nueva entrada deberá utilizar lista blanca: servir exclusivamente pantallas V3, `/api/v3` y `/health` sin contenido privado. Las rutas antiguas deben devolver `410 Gone` o `404` sin ejecutar funciones heredadas.
2. Rechazar upgrades WebSocket hasta existir autorización por rol/compra.
3. No cargar Baileys ni importar el servidor V2 en el entorno de ensayo. No exponer QR como parte de la prueba.
4. Usar exclusivamente base `file:` temporal/de ensayo con catálogo ficticio; no aceptar variables de Turso de producción ni credenciales reales.
5. Las páginas V3 no pueden depender de rutas V2. El envío por WhatsApp queda explícitamente **no implementado**: compartir una URL manualmente no es confirmación de envío.
6. Comprobar con peticiones reales que todas las rutas V2 quedan denegadas, que WebSocket no puede abrirse y que el login + compra V3 siguen funcionando.
7. Para un despliegue posterior se requiere integración formal de almacenamiento, protección de secretos, proxy HTTPS, restauración de copia verificable, flujo WhatsApp y posibilidad de rollback. **No despliegue automático.**

## 6. Alcance de este hito

Diseñar y validar un **servidor de staging V3 separado**. No equivale a integrar `server.js` real de producción ni a resolver el envío de WhatsApp. El cambio de entrada definitivo debe hacerse de forma coordinada y autorizada cuando la versión V3 esté completa.

## 7. Principales riesgos residuales

- El servidor V2 publicado sigue con el comportamiento heredado si `main` no ha cambiado.
- Tokens de compra y sesiones deben probarse con proxy HTTPS real y navegadores móviles.
- El limitador de contraseñas del router V3 es local a proceso; necesita defensa distribuida antes de producción.
- Los enlaces enviados manualmente pueden compartirse o filtrarse; el canje de un solo uso reduce pero no elimina ese riesgo.
- Sin canal push autorizado, V3 necesitará sincronización/polling con validación de sesión y resolución de conflictos.
- La actualización de `productos.agotado` permanece deliberadamente sujeta a conciliación administrativa, no automática.
