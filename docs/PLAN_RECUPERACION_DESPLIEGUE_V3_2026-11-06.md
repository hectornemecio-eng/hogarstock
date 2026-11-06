# HogarStock — Plan verificable de recuperación y despliegue V3

**Fecha:** 6 de noviembre de 2026. **Ámbito:** rama `seguridad-pruebas-2026-11-05`.  
**Estado:** ensayo con SQLite/libSQL local aprobado; restauración real y despliegue **no realizados**.

## Evidencia disponible

- `tests/v3-restore-drill.test.js`: crea exclusivamente productos, compras, propuestas, estados y credenciales ficticias; utiliza `VACUUM INTO` para generar una instantánea SQLite coherente; la copia se hace con `COPYFILE_EXCL` a una ruta que no existe, compara SHA-256, ejecuta `PRAGMA integrity_check`, y vuelve a abrirla mediante `@libsql/client`.
- Comprueba lectura con la clave correcta y rechazo con clave de autenticación o clave de mensajería equivocada; confirma que se conserva la compra, la propuesta aplicada, el registro de mensajes y el catálogo ficticio.
- Comprueba que un destino ya existente no se sobrescribe y que una copia manipulada tiene un hash diferente.
- Ejecución CI verificada: https://github.com/hectornemecio-eng/hogarstock/actions/runs/42181485336, commit `d61fee6187ec10110027901454af2b785231d8f4`: 158 pruebas, cero fallidas (63 componentes, 64 libSQL, 24 HTTP, 7 HTTPS/Chromium).
- La primera ejecución de la batería de recuperación falló por una expectativa incorrecta del test: una clave de autenticación errónea detiene la inicialización de V3, antes de consultar el outbox. Se corrigió la prueba para verificar por separado ambas claves; la ejecución final pasó. **No se corrigió ni ocultó un fallo de descifrado; este bloqueo es una protección válida.**
- Pruebas de Baileys reales sin red efectuadas en un workflow separado con anterioridad. No constituyen validación de sesión WhatsApp real.

## Qué NO demuestra este ensayo

1. **NO se ha restaurado** `HogarStock_Turso_Respaldo_Cifrado_20261105.ize` ni el respaldo lógico de Turso de noviembre. Los archivos originales, la contraseña de descifrado y su procedimiento de recuperación no están accesibles en esta sesión.
2. `VACUUM INTO` valida instantáneas de SQLite **local**; no reemplaza un respaldo consistente de Turso remoto ni prueba sus mecanismos de recuperación.
3. No se ha validado la persistencia de Baileys tras reinicios reales de Render ni el comportamiento con cuentas WhatsApp activas.
4. No se ha revisado el tráfico público real del servidor V2 ni instalado el servidor V3 de producción.

## Condiciones previas para ensayos remotos

- Base Turso independiente de producción, de ensayo, sin datos reales ni posibilidad de coste monetario adicional; verificar su identidad en el panel de Turso, no solo por hostname.
- Credenciales y claves en un gestor seguro, nunca en repositorio, chat ni logs. Permisos mínimos para la base de ensayo.
- Contar con respaldo de producción descargado y cifrado y **comprobar que se puede descifrar, verificar y restaurar en otro recurso** antes de migrar. No sustituir la base original.
- Confirmar esquema de la base real mediante operaciones de solo lectura; detenerse si hay columnas o índices incompatibles.
- Mantener intactos Render productivo, WhatsApp productivo y la rama `main` durante los ensayos.

## Ensayo de restauración con datos auténticos — requisitos de aceptación

| Control | Criterio |
|---|---|
| Integridad criptográfica | El archivo restaurado coincide con el respaldo origen autorizado mediante SHA-256 cuando corresponda |
| Consistencia | `PRAGMA integrity_check` o comprobación equivalente del formato restaurado devuelve resultado correcto |
| Catálogo | Comparar recuento actual, identificadores, nombres, categorías y estados; **no asumir que siguen siendo 150 productos** |
| Sesiones | Confirmar que las sesiones de prueba se restauran o invalidan según la política; no exponer secretos ni QR |
| Compras | Número de compras, líneas, revisiones y estados idénticos a la copia fuente |
| WhatsApp | Claves de cifrado recuperables, sin trasplantar credenciales ni iniciar dos sockets simultáneos |
| Seguridad | En destino V3, API heredada inaccesible; administrador y comprador autorizados y aislados |
| Reversión | Contar con commit de retorno, configuración previa documentada y copia consistente anterior al cambio |
| Privacidad | No subir el respaldo ni las credenciales a repositorios, incidencias o conversaciones |

## Protocolo de publicación (todavía NO autorizado)

1. Completar los ensayos remotos y restaurar un respaldo **en un destino separado**, sin escribir en producción.
2. Validar envío, recepción y persistencia de WhatsApp con una cuenta de prueba **independiente**.
3. Auditar todas las rutas heredadas V2, WebSockets, QR, sesiones, teléfono en HTML y autorización de endpoints V3. El acceso a QR debe requerir administración autenticada.
4. Evaluar consistencia y costes de Turso/Render; no contratar, introducir tarjeta, recargar saldo ni activar pago automático.
5. Solo tras autorización explícita: obtener respaldo predespliegue, registrar SHA del commit principal anterior, desplegar una versión trazable, ejecutar pruebas de humo y habilitar usuarios progresivamente.
6. Si hay fallos: suspender nuevas operaciones, recuperar la configuración/código anterior en un despliegue controlado y **evaluar la compatibilidad de datos antes de revertir cualquier base**. No restaurar automáticamente un backup sobre una base con compras posteriores: podría borrar transacciones legítimas.

## Bloqueos actuales

- Falta confirmar un Turso remoto de ensayo aislado y gratuito; no se han utilizado credenciales de producción.
- Falta una recuperación **real** del respaldo cifrado verificado mediante prueba de restauración.
- Falta el ciclo bidireccional real de Baileys y la prueba de reinicio de Render.
- Falta cierre de las rutas públicas V2 en un servidor final autorizado y validación móvil/proxy.
- Falta autorización explícita de despliegue y procedimiento final de rollback.

**Decisiones vigentes:** priorizar estabilización de HogarStock actual, mantener coste adicional cero y aplazar cualquier alternativa basada en Google.
