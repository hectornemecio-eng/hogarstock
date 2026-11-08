# HogarStock V3 — decisión: continuar con Render

**Fecha:** 2026-11-08  
**Origen de la decisión:** el usuario indicó expresamente: «sigue con render y ya veremos luego otras opciones».  
**Carácter:** decisión vigente de arquitectura/planificación; no autoriza despliegue ni migración de datos.

## Decisión vinculante

**Render sigue siendo el alojamiento de HogarStock.** No investigar, recomendar como siguiente fase, aprovisionar ni desplegar en Northflank, Enzonic u otros proveedores hasta que el usuario reabra de forma expresa esa decisión.

El código multiproveedor desarrollado antes queda archivado en la rama experimental, **inactivo por defecto**. El validador de `integration/v3-remote-staging-entrypoint.js` admite como proveedor activo únicamente `render`; para evaluar un origen no Render, en una posible fase futura, exige `HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER=S` además de la vinculación del dominio exacto y de todos los controles de red, respaldo y escritura. No se estableció dicha variable en ningún servicio real.

**Esta decisión no elimina** el requisito de coste adicional cero, la separación de bases V2/V3, la autorización previa de cambios reales ni la posibilidad de recuperar V2.

## Estado de Render comprobado

En la consulta de solo lectura efectuada el 8 de noviembre de 2026, la cuenta conectada contiene un servicio:

| Campo | Valor |
|---|---|
| Servicio | `hogarstock` |
| Tipo | Web service |
| Plan | `free` |
| Rama | `main` |
| Comando de inicio | `node server.js` |
| URL | `https://hogarstock.onrender.com` |
| Región | Frankfurt |
| Auto-deploy | activado para `main` |
| Suspensión por el proveedor | `not_suspended` en la consulta |

Esto describe **configuración y estado de suspensión** según la API, no prueba la disponibilidad permanente de la aplicación ni de WhatsApp. No se consultó facturación privada, horas incluidas restantes ni gastos.

## Restricciones reales del plan Free

1. El servicio Free puede hibernar tras 15 minutos sin actividad entrante y reiniciarse posteriormente. **No promete Baileys/WhatsApp en línea continuamente**.
2. Render Free comparte las 750 horas incluidas entre los servicios gratuitos del workspace, sujeto a las condiciones vigentes del plan. Por tanto **no crear un segundo servicio V3 automáticamente**; podría afectar al cupo de V2.
3. El almacenamiento efímero de Render **no es fuente persistente de datos ni de sesiones WhatsApp**. La persistencia requiere un almacén externo adecuado y respaldos comprobados.
4. Los posibles cargos y límites privados dependen de la cuenta; **no afirmar coste adicional cero demostrado**.
5. La sesión de WhatsApp personal mediante Baileys es no oficial y puede sufrir desconexiones o restricciones independientes del hosting.

Referencia principal: https://render.com/docs/free

## Ruta de avance aprobada (Render y nada más)

### Fase R1 — Continuar desarrollando en GitHub, sin tocar V2

- Mantener la rama `seguridad-pruebas-2026-11-05` como laboratorio V3.
- Mantener `main` y la configuración de Render V2 sin cambios.
- Cerrar defectos comprobados con tests y CI; preservar documentos de continuidad y pruebas.
- Preparar un plan verificable de migración, comparando esquemas V2/V3 y describiendo conservación del catálogo e historial.

### Fase R2 — Auditar coste e infraestructura **antes** de cualquier segundo servicio

- Revisar `https://dashboard.render.com/billing`: horas restantes, minutos de compilación, ancho de banda y si hay facturación habilitada. No compartir tarjetas, claves ni datos financieros sensibles.
- Revisar cuotas/overages de Turso actual y comprobar factibilidad de **base nueva independiente**.
- Seleccionar una estrategia de ensayo que **no ponga en riesgo V2** y no añada cargos; no presuponer que otro servicio Free es seguro.
- Si el presupuesto o aislamiento no quedan acreditados, mantener los ensayos locales y no activar infraestructura remota.

### Fase R3 — Pruebas reales en condiciones autorizadas

- Base de ensayo Turso, identidad distinta de la productiva, copia recuperable y ensayo de restauración.
- Prueba de conexión WhatsApp V3 real **con sesión independiente**, solo números permitidos, sin reutilizar autenticación de V2.
- Revisión de desconexiones, suspensiones, reconexiones y estados de entrega.
- Ensayos funcionales del inventario, compras, mensajes y contingencia manual.

### Fase R4 — Sustitución controlada en Render **solo tras aprobación**

- Documentar el punto de restauración de `main` y la configuración efectiva V2, sin volcar secretos a repositorios o chats.
- Preparar migración reversible del catálogo, compras, respuestas y autenticaciones, sin alteraciones destructivas no autorizadas.
- Definir ventana de cambio y umbrales de rollback por fallo.
- Aprobar explícitamente el despliegue; después verificar datos, funciones, acceso y reconexión.
- No confundir pasar tests de laboratorio con una producción validada.

## Evidencia de los cambios de política realizados

- Commit `45bba0bbcec3624b570f035aeb0edb59965d45d3`: proveedor no Render **bloqueado** salvo permiso `HOGARSTOCK_V3_ALLOW_OTHER_PROVIDER=S`.
- Commit `9a6a5a4655b8fee37597e1b852ac89699397d3c5`: nuevas pruebas de preferencia Render y activación futura.
- Commit `005ca172e169713b1eea30fdb6ae0bc4e74b87ec`: corrección de dos fixtures inconsistentes, **sin cambio del alcance productivo**.
- GitHub Actions `42496775168`: **80/80** tests con Node 20.11.0 y **80/80** con Node 22, cero fallos. Se comprobaron logs y `MAIN_START_SIN_CAMBIOS=SI` en ambas ejecuciones. No son 160 pruebas diferentes.
- Regresión general del commit de código: verificar `42496774965` antes de declararla finalizada. No se realizó deploy, ni cambio de rama `main`.

## Checklist

- [x] Decisión explícita del usuario: continuar Render.
- [x] Conservar sin cambios el servicio `hogarstock` V2 y la rama `main`.
- [x] Poner las alternativas en pausa técnica y documental, sin borrar el trabajo.
- [x] Verificar en CI la política Render por defecto.
- [ ] Leer facturación/horas privadas restantes de Render y cuotas Turso.
- [ ] Acordar método de staging compatible con cero cargos y sin exponer V2.
- [ ] Probar persistencia remota, restauración y WhatsApp real.
- [ ] Probar migración con rollback y desplegar V3 solo con autorización.

**Regla de continuidad:** en próximos turnos, NO volver a investigar otros proveedores por iniciativa propia. La prioridad es terminar HogarStock V3 **sobre Render**, manteniendo seguridad y coste cero.
