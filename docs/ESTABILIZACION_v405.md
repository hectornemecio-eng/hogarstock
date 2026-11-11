# HogarStock v4.05 — estabilización candidata (sin publicar)

Fecha: 2026-11-11. Base: `ac36b81bc925446c5d673e0a8e3eda92105864b6` (v4.04 en Render).

## Propósito
Reducir falsas confirmaciones y duplicados al compartir listas por WhatsApp, y ejecutar toda la regresión de manera automática en solicitudes de incorporación a `main`.

## Cambios
- Se guarda el intento pendiente del primer destinatario en la misma transacción que crea la compra.
- Antes de enviar a un nuevo destinatario se escribe un estado pendiente (`enviado=0`).
- La confirmación de aceptación del envío se escribe tras completar `sendMessage`, incluido el contacto principal.
- Los estados pendientes y el primer destinatario heredado sin registro se consideran inciertos: **no se reenvían automáticamente**. Se requiere el reenvío explícito del administrador.
- Se mantiene el registro de envíos confirmados existente; no se eliminan contactos, compras ni claves.
- Se añade CI automático para PR hacia `main`, con cobertura de escenarios de interrupción.
- La ejecución `push main` sirve como detección posterior; NO sustituye una protección obligatoria de rama. Para impedir fusiones con pruebas fallidas, configurar protección/ruleset cuando exista acceso administrativo.

## Alcance y límites
No modifica estructura de tablas: reutiliza `hs_v2_security_envios` y su campo `enviado`; el valor `0` representa estado pendiente, un valor positivo representa aceptación del proveedor (no recepción del teléfono).

No se envían WhatsApps reales. No se toca Turso real, Render ni `main`.

## Validación
- CI en la solicitud de cambios, sin uso del PC local.
- No fusionar hasta revisar el resultado y obtener autorización de publicación.
- Siguientes frentes: errores de pre-keys de Baileys y recuperación real aislada.
