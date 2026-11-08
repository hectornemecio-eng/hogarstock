# HogarStock V3 — conciliación segura de inventario (laboratorio)

**Fecha:** 2026-11-08  
**Rama:** `seguridad-pruebas-2026-11-05`  
**Alcance:** solo SQLite ficticia. No despliegue, no acceso a Turso real, ni WhatsApp real.

## Problema y decisión

La finalización de una compra V3 NO cambia automáticamente `productos.agotado`. Esto es deliberado: un producto puede aparecer en varias compras abiertas o seguir faltando por otro motivo. La reposición se mantiene como **operación administrativa con confirmación**, nunca como escritura silenciosa por un mensaje entrante.

La fase introduce `compras/v3-reposicion-sandbox.js` con `crearRepositorInventarioV3` y dos métodos principales:

- `preparar({compraId})`: informe de solo lectura de una compra **finalizada**, con decisiones `REPONIBLE`, `NO_COMPRADO`, `PRODUCTO_INEXISTENTE`, `YA_NO_AGOTADO`, `COMPRA_ABIERTA_COMPARTIDA` o `CONCILIADA_ANTERIORMENTE`. Devuelve una huella SHA-256 del estado observado, sin nombres ni datos de contactos.
- `aplicar({compraId,huellaEsperada,confirmacion:true})`: reconsulta **en transacción de escritura**. Si la fotografía cambió, rechaza la aprobación desactualizada sin modificar nada. Solo pone `productos.agotado=0` para productos realmente comprados, agotados, sin otras compras abiertas y no repuestos antes desde esa compra. Escribe bitácora en la misma transacción.

Para impedir la repetición de una compra vieja sobre una necesidad nueva, la bitácora `hogarstock_reposiciones_v3` tiene clave única `(compra_id, producto_id)`. Esta bitácora se crea solamente al invocar `init()` en el servicio aislado.

### Seguridad por defecto

El constructor **rechaza** la configuración salvo que estén activadas ambas banderas `HOGARSTOCK_V3_SANDBOX=1` y `HOGARSTOCK_V3_REPOSICION_LAB=1`. También rechaza variables de Turso remoto y WhatsApp real. No importar el servicio en `server.js`, `main` ni en arranques V3 remotos.

Se ha añadido al router V3 una **integración opcional** `reposicionInventario`. Si no se proporciona, las rutas de reposición **no existen**. Cuando se inyecta deliberadamente en el laboratorio:

- `GET /api/v3/admin/compras/:compraId/reposicion`: consulta el informe; exige autenticación administrativa.
- `POST /api/v3/admin/compras/:compraId/reposicion/aplicar`: exige sesión administrativa, `Origin` exacto, JSON con `confirmacion:true` y `huellaEsperada`. Rechaza huella obsoleta con HTTP 409.

**La composición remota vigente no inyecta este servicio y, por tanto, no activa la operación.** No hay modificación de la interfaz pública V2.

## Semántica de los casos delicados

1. Si una compra no está finalizada, se rechaza incluso el informe de reposición.
2. Si hay otra compra **abierta** con ese producto, se mantiene marcado como agotado, independientemente del estado del artículo en la segunda compra. Es una regla conservadora.
3. Si un producto no está comprado o fue declarado no disponible, no se repone.
4. Si el catálogo ya no indica agotado o el producto desapareció, no se modifica.
5. Si el usuario vuelve a marcar el producto agotado **después de haber conciliado** la compra, la misma compra no vuelve a desmarcarlo.
6. Si cambia el inventario o aparece otra compra después de preparar el informe, la huella queda obsoleta y se aborta.
7. Si falla el asiento de bitácora, la transacción también revierte el cambio en `productos.agotado`.

**Control ABA implementado (v3.51):** en laboratorio, el módulo mantiene `hogarstock_productos_version_v3` y tres triggers sobre `productos` (inserción, borrado y actualización de estado/nombre/categoría). Cada evento relevante incrementa la versión del producto y ésta participa en la huella de aprobación. Así, una secuencia `agotado=1 → 0 → 1` queda detectada, aunque el estado final coincida con el inicial. La versión se almacena fuera de la tabla histórica `productos` y persiste entre inicializaciones. Su aplicación a datos reales todavía requiere migración y auditoría específicas; esta validación es únicamente de laboratorio.

**Interfaz administrativa opcional (v3.51):** `public/admin-v3.html` lee el informe existente, consulta condicionalmente `/admin/compras/:id/reposicion` y, si el servicio está inyectado, muestra candidatos y un botón de confirmación que envía `confirmacion:true` y la huella a `POST /admin/compras/:id/reposicion/aplicar`. Si la ruta devuelve 404, la pantalla mantiene el informe de solo lectura. El código usa `textContent` y no incorpora HTML arbitrario de datos de productos. Las pruebas de UI actuales verifican sintaxis y controles presentes en el código; **aún falta un E2E visual con navegador que ejercite esta operación**.

## Pruebas y evidencia

Archivo `tests/v3-reposicion-sandbox.test.js`: 13 casos; `tests/v3-reposicion-http-lab.test.js`: 4 casos. Se añaden a las 50 pruebas del staging anterior: **67 casos distintos** en total.

**GitHub Actions:** `42484199079` — commit `fe060e360e348602a20f8cf54e198b962996d646`.

- Node 20.11.0: **67/67**, 0 fallidos, 0 saltados.
- Node 22: **67/67**, 0 fallidos, 0 saltados.
- `MAIN_START_SIN_CAMBIOS=SI` confirmado por ambos jobs.
- Regresión general: `42484199087`, estado completado/satisfactorio.

Enlaces:  
https://github.com/hectornemecio-eng/hogarstock/actions/runs/42484199079  
https://github.com/hectornemecio-eng/hogarstock/actions/runs/42484199087

Estos ensayos usan SQLite ficticia y HTTP loopback; **no** verifican Turso real, WhatsApp real, un servicio de Render ni sincronización de catálogo en producción.

## Próxima prioridad

1. Diseñar y probar una versión monotónica por producto para evitar el cambio ABA y dar garantías fuertes en la aprobación de conciliación.
2. Revisar la interfaz V3 para presentar informe, requerir confirmación y reflejar reposiciones sin eliminar la necesidad de otras compras.
3. Mantener bloqueado cualquier staging remoto adicional hasta comprobar cuotas y posibles cargos de Render/Turso y contar con permiso expreso.
4. Validar migración/reversión y seguridad de sesiones WhatsApp antes de cualquier cambio en V2.

**Producción V2 permanece sin cambios.**

## Hito adicional v3.51 — evidencia de versionado e interfaz (2026-11-08)

- `compras/v3-reposicion-sandbox.js`: tabla de versiones y triggers; detección ABA, cambios directos, borrado/reinserción y persistencia.
- `tests/v3-reposicion-sandbox.test.js`: 17 casos, incluidos cuatro adicionales de concurrencia.
- `public/admin-v3.html`: aprobación administrativa opcional, bloqueada si el endpoint no existe, y confirmación del operador.
- `tests/v3-reposicion-ui.test.js`: 3 verificaciones de sintaxis/control (no prueban visualmente la experiencia).
- `tests/v3-reposicion-http-lab.test.js`: 4 casos reales HTTP de autenticación, origen y aplicación.
- En conjunto, el workflow de staging contiene 74 casos distintos: Node 20.11.0 **74/74**, Node 22 **74/74**, 0 fallos.
- Evidencia: https://github.com/hectornemecio-eng/hogarstock/actions/runs/42484916313 ; commit de código `a9a73f38a883a43397c91fb6c9f8633ccef3ea2d`.

### Estado de preparación productiva

**Validado en laboratorio:** catálogo V3, compras, respuestas simuladas, cierre y aviso en bandeja persistente, conciliación transaccional, versión anti-ABA, seguridad HTTP opcional, backups SQLite ficticios.  
**Aún sin validar:** flujo de extremo a extremo con WhatsApp real, tokens/sesiones reales de Baileys V3, staging Render/Turso y backup remoto restaurado, migración desde V2, despliegue reversible y gastos/cupos de la cuenta.  
**Regla:** no publicar V3 como funcional ni dar porcentajes de completitud de producción como métricas auditadas. Los números de pruebas describen solo la cobertura del entorno probado.

