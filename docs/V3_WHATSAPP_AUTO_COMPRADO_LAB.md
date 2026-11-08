# HogarStock V3 — Respuesta automática COMPRADO en sandbox (2026-11-08)

## Alcance demostrado

Módulo `whatsapp/v3-auto-apply-verified.js`, prueba integrada
`tests/v3-auto-apply-verified.test.js`, workflow
`.github/workflows/v3-staging-smoke.yml`.

El circuito probado —**sin red**— es:

1. Evento `messages.upsert` nuevo de un socket Baileys simulado.
2. El adaptador `whatsapp/inbound-baileys.js` filtra mensajes propios, grupos,
   estados, JID `@lid`, tipos no textuales e históricos.
3. La bandeja real `whatsapp/inbox-store.js` verifica que el número está
   vinculado a **exactamente una compra abierta** y deduplica el ID de mensaje.
4. Solo la propuesta `COMPRADO <itemId>` válida puede pasar al aplicador.
5. `whatsapp/apply-proposal.js` verifica la revisión y actualiza el estado
   del artículo y la propuesta en una transacción SQL.
6. Se devuelve una señal interna de `todosComprados` y
   `requiereNotificacion` cuando los artículos están todos comprados.

**No** se abre ningún socket real, no se muestra QR, no se envían mensajes
y no se alteran productos del catálogo. La compra permanece
`abierta`, aunque todos sus artículos estén marcados comprados.

## Restricción de habilitación

Por defecto: `modo: "revision_manual"`. El modo
`auto_comprado` **solo puede construirse** con un entorno inyectado que
contenga ambas variables:
`HOGARSTOCK_V3_SANDBOX=1` y
`HOGARSTOCK_V3_AUTO_APPLY_INBOUND=1`.

Se bloquea si se declaran credenciales `TURSO_DATABASE_URL` o
`TURSO_AUTH_TOKEN`, la URL de Turso staging, un entorno remoto V3
o `HOGARSTOCK_V3_WHATSAPP_LIVE`. El módulo NO se monta en `server.js`
ni en el arranque remoto. **No es una autorización para el modo productivo**.

La entrada `recibir()` está concebida solo para la frontera interna
Baileys. No exponerla por una ruta HTTP/WS: una petición desde Internet no
demuestra identidad WhatsApp.

## Pruebas de aceptación

Nueve escenarios en SQLite local y EventEmitter ficticio:
- modo automático bloqueado fuera del sandbox;
- modo manual por defecto sin mutación;
- entrada COMPRADO actualiza solo la compra, sin tocar `productos.agotado`;
- reenvío con mismo ID no repite el cambio;
- contacto ajeno o vínculo revocado no cambia la compra;
- NO DISPONIBLE y texto libre siguen revisión manual;
- mensajes propios, grupos y LID quedan fuera del adaptador;
- dos artículos comprados producen la señal de cierre sin cerrar/enviar;
- nuevo ID sobre artículo ya comprado no aumenta revisión.

GitHub Actions `42482564605`, commit `bdf6c0e0cba007f924cd5ea20e30c4c23a845879`:
**38/38 con Node 20.11 y 38/38 con Node 22**, 0 fallos.
No sumar ambos como si fueran 76 casos distintos: son dos ejecuciones
de las mismas 38 pruebas.

## Pendientes para cumplir el objetivo del usuario

1. Implementar envío bidireccional con WhatsApp real de manera autorizada,
   contactos permitidos y manejo robusto de recibos de entrega/lectura.
2. Generar y despachar **un único** cierre por compra cuando todos los
   artículos están comprados; deduplicación persistente tras reinicios.
3. Responder con lista de faltantes cuando corresponda, definiendo una
   acción explícita de «terminar compra con faltantes».
4. Decidir cómo conciliar `productos.agotado` para que el estado visible
   desaparezca del inventario sin falsos positivos o cambios sobre otras
   compras abiertas.
5. Validar seguridad de vinculación de remitentes reales (JID/LID,
   dispositivos vinculados) y conexiones Baileys en servidor de ensayo.
6. Verificar coste cero y cuotas privadas antes de conectar Turso
   staging y crear otro Render.
7. Probar reversibilidad, reconexiones, rotación de claves y respaldos
   independientes antes de tocar V2.

## Evidencia y límites

El resultado **no demuestra** recepción/entrega WhatsApp real, persistencia
remota Turso, despliegue V3 ni cierre automático. Módulos del laboratorio
nuevos no se activan automáticamente en producción.

Producción V2: `main` y `npm start` continúan sin cambios.
