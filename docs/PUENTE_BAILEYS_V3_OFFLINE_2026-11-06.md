# HogarStock V3 — Puente Baileys con ejecución sin red por defecto

**Fecha:** 2026-11-06. **Estado:** desarrollo aislado. **Rama:** `seguridad-pruebas-2026-11-05`.

## Objetivo conseguido

Unir la API de Baileys 7 utilizada en HogarStock con el almacenamiento cifrado V3, el coordinador y el filtro de eventos entrantes **sin arrancar una sesión automáticamente** ni reutilizar la sesión actual de V2. La configuración de pruebas utiliza SQLite temporal y datos ficticios.

### Archivos

- `whatsapp/baileys-bridge.js`: fabrica las dependencias que espera `crearCoordinadorWhatsApp` (autenticación, consulta de versión y fábrica de socket); monta `crearAdaptadorEntradaBaileys` en el socket únicamente si se autoriza conectar. El modo predeterminado es `sin_red`.
- `whatsapp/baileys-loader.js`: carga la versión ESM de `@whiskeysockets/baileys` desde CommonJS y un registrador Pino con nivel `silent`, sin construir sockets. Permite obtener la versión Web solo en el modo autorizado.
- `tests/wa-baileys-bridge.test.js`: pruebas con socket y biblioteca simulados; incluye arranque, bloqueo de red, privacidad de QR, entrada, envío y cierre.
- `tests/wa-baileys-bridge-real.test.js`: comprueba la carga de Baileys real 7.0.0-rc11 y el almacén cifrado **sin llamadas de conexión**.
- `.github/workflows/db-sqlite.yml` y `.github/workflows/wa-compat.yml`: integran las pruebas en GitHub Actions.

## Condiciones técnicas de activación

El objeto del puente requiere `urlBaseDatos` local `file:...sqlite`. El modo `sin_red` no ejecuta `fetchLatestWaWebVersion` ni `makeWASocket`. El modo `conexion` exige simultáneamente las dos señales explícitas `HOGARSTOCK_V3_SANDBOX=1` y `HOGARSTOCK_V3_WHATSAPP_LIVE=1`, y que no estén definidas `TURSO_DATABASE_URL` o `TURSO_AUTH_TOKEN`. **La presencia de estas señales es una condición técnica, NO una autorización para utilizar la cuenta real de V2**.

Cuando está expresamente permitido en un entorno de ensayo, el puente crea el socket con `printQRInTerminal:false`, `syncFullHistory:false`, `markOnlineOnConnect:false` y `generateHighQualityLinkPreview:false`. El QR solo pasa por el estado privado del coordinador, que debe quedar detrás de autenticación administrativa. Los eventos `messages.upsert` pasan por los filtros del adaptador de entrada, la bandeja de revisión y la vinculación previa de remitente a compra.

Las credenciales y las claves Signal se almacenan con el módulo cifrado `whatsapp/auth-store.js`; la clave de cifrado debe suministrarse desde secretos privados, no desde archivos en Git. Las configuraciones reales de cuenta, el QR y las claves **no se registran, copian ni incorporan al documento de continuidad**.

## Evidencia y límites

La carga del paquete Baileys real mediante el loader no equivale a abrir un socket con WhatsApp: en CI, las llamadas `makeWASocket` son ficticias. No se ha verificado todavía el enlazado por QR, la conservación de sesión tras reiniciar Render, la recepción con números LID, los acuses reales, la exactitud de la versión web en el momento de conexión ni la fiabilidad de la cuenta a largo plazo.

Baileys 7 introduce cambios incompatibles respecto a versiones anteriores. `useMultiFileAuthState` no es un almacén apropiado para producción según su documentación. No basta con copiar archivos de sesión V2 al nuevo esquema cifrado: esa migración requeriría una recuperación verificable y procedimiento de reversión.

## Bloqueos para despliegue

1. Completar integración **con Turso remoto de pruebas** y claves de cifrado gestionadas de manera segura; comprobar que los nuevos esquemas no alteran las tablas V2.
2. Ensayo controlado con una **cuenta de WhatsApp separada** (no la actualmente utilizada), autorización explícita y validación de QR, persistencia, reinicios y recepción real; la biblioteca no es una API oficial de WhatsApp.
3. Resolver destinatarios con identificadores LID y la correlación fiable con compras; actualmente se rechazan identificadores ambiguos.
4. Revisar rate limits distribuidos, autorización de WhatsApp/QR y cierre de rutas V2. Preparar backup **restaurado** en base aislada y rollback.
5. Solo entonces planificar despliegue controlado, sin sustituir la V2 publicada hasta autorización. Coste incremental exigido = 0 €; alternativa de Google sigue aplazada.

## Comandos de verificación

La CI se ejecuta automáticamente desde la rama. Para pruebas con paquete real se usa el entorno temporal de GitHub Actions, `@whiskeysockets/baileys@7.0.0-rc11` y `@libsql/client@0.14.0`. Los tests no necesitan QR ni una cuenta de WhatsApp. La actividad debe juzgarse por el resultado real de la última ejecución de GitHub Actions; no se presupone éxito.
