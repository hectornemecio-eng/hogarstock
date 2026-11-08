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

**Límite conocido:** el modelo actual de `productos` no dispone de versión monotónica. Un cambio ABA (`agotado=1 → 0 → 1`) entre lectura y aprobación, antes de una primera conciliación, puede mantener la misma fotografía y no ser detectable. Antes de habilitar conciliación real, se recomienda versión de producto o evento de necesidad y control de concurrencia exhaustivo. La herramienta no debe presentarse como seguridad de producción completa.

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
