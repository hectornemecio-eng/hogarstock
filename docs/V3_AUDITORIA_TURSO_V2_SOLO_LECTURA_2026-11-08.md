# HogarStock V3 — auditoría de Turso V2 sin escritura

**Fecha:** 8 de noviembre de 2026  
**Alojamiento vigente:** Render. Otros alojamientos en pausa.  
**Estado:** auditor y lanzador Windows preparados, con pruebas ficticias superadas. **No se ha consultado la base Turso productiva**.

## 1. Vulnerabilidad de aislamiento corregida

La simulación anterior de migración V2→V3 comprobaba que origen y destino fueran objetos SQL distintos. Esto era insuficiente: dos objetos diferentes pueden conectar al **mismo archivo SQLite**.

El módulo de simulación ahora comprueba antes de cualquier escritura que los dos clientes correspondan a archivos locales:
- con nombres exactos source-v2.sqlite y destino-v3.sqlite;
- dentro de la misma carpeta temporal de pruebas controlada por el patrón hs-v2-v3-mig-fake-*;
- con rutas físicas diferentes y sin compartir dispositivo/inodo;
- sin clientes remotos, bases de datos en memoria ni archivos productivos.

La verificación utiliza PRAGMA database_list, realpathSync y statSync. El simulador queda restringido a laboratorio y no debe utilizarse directamente para migraciones Turso reales.

## 2. Auditor de Turso V2 diseñado para evitar datos personales

Archivo: integration/v3-auditoria-v2-solo-lectura.js.

Realiza como máximo tres consultas SQL predefinidas:
1. SELECT name FROM sqlite_master ... — nombres de tablas, solo metadatos.
2. PRAGMA table_info(productos) — columnas y clave primaria.
3. SELECT COUNT(*), SUM(CASE ...), COUNT(DISTINCT id) FROM productos — agregados.

Devuelve exclusivamente el número de productos, los agotados y disponibles, los recuentos de estados y textos inválidos, la presencia de tablas de autenticación histórica y de V3 y la compatibilidad general. El servidor examina las filas para contabilizar, pero **no devuelve nombres de productos**, números de teléfono, tokens, contraseñas ni contenido de WhatsApp.

El resultado incluye siempre autorizaMigracion=false y respaldoVerificado=false. Una auditoría satisfactoria **no** equivale a una copia restaurable ni permite desplegar V3.

## 3. Ejecución opcional con autorización S/N

Archivos:
- scripts/v3-auditar-turso-v2-solo-lectura.js
- scripts/v3-auditar-turso-v2-solo-lectura.ps1

El programa Node exige autorización explícita de lectura, confirmación de cuota sin cargos, hostname exacto de la base V2 y credenciales ya disponibles en la sesión local. Rechaza hosts de staging, entornos V3 mezclados, URL con credenciales incrustadas y destinos fuera de Turso.

El lanzador de PowerShell comprueba la presencia de Node, del script y de tres variables de entorno: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, HOGARSTOCK_V2_PRODUCTION_HOST. **No abre archivos .env ni muestra sus valores.**

Después pide dos confirmaciones sencillas S/N:
1. Que el usuario haya verificado que las tres consultas caben en una cuota que no generará cargos.
2. Que autorice consultar únicamente metadatos y conteos V2.

Las banderas de autorización existen únicamente en el proceso actual durante la ejecución y se restauran al acabar. El lanzador no instala dependencias, no cambia políticas PowerShell, no escribe informes y no modifica Render, Turso ni WhatsApp.

**Advertencia técnica:** la bandera READONLY restringe lo que este programa ejecuta, no convierte automáticamente un token Turso con capacidad de escritura en un token restringido por el proveedor. Confirmar la posibilidad de token de solo lectura si existe. Las consultas agregadas pueden consumir cuota Turso; no ejecutarlas sin comprobar límites y gastos en el panel.

No copiar ni pegar tokens, URL autenticadas ni archivos .env en el chat. En caso de ejecutarla después, el único resultado a compartir es el JSON de conteos agregado.

## 4. Evidencia automática

Se añadieron 14 pruebas nuevas respecto al hito anterior:
- 7 pruebas del auditor sin datos personales.
- 5 del programa de conexión bloqueada y no exposición de secretos.
- 2 del aislamiento físico del ensayo de migración.

GitHub Actions de staging: https://github.com/hectornemecio-eng/hogarstock/actions/runs/42515230599

**Node 20.11.0: 103/103**; **Node 22: 103/103**; 0 fallos, 0 saltados, comprobación MAIN_START_SIN_CAMBIOS=SI.

Regresión general: https://github.com/hectornemecio-eng/hogarstock/actions/runs/42515230534 — success. Son los mismos 103 casos ejecutados en dos versiones de Node.

Esta evidencia corresponde a bases ficticias y fábricas cliente inyectadas. **No** se utilizaron credenciales ni conexiones Turso reales.

## 5. Puertas siguientes sobre Render

1. Verificar cuotas privadas y ausencia de cargos de Turso antes de acceder a la base V2.
2. Confirmar estructura real mediante auditoría solo lectura con autorización y sin revelar secretos.
3. Obtener una instantánea coherente y restaurarla en una base nueva independiente, verificando el coste cero.
4. Validar la sesión de WhatsApp V3 con identidad independiente, sin reutilizar automáticamente credenciales V2.
5. Preparar migración reversible del catálogo y autorización explícita para desplegar sobre Render.

## Checklist

- [x] Aislamiento físico del ensayo V2→V3 reforzado.
- [x] Auditoría limitada a metadatos y estadísticas, sin resultados personales.
- [x] Lanzador Windows con autorizaciones S/N y sin importar automáticamente .env.
- [x] Pruebas de seguridad y regresión aprobadas.
- [x] V2 en Render, Turso real y main sin modificaciones.
- [ ] Verificar cuotas Turso y factura sin posibilidad de cargos.
- [ ] Ejecutar auditoría real autorizada.
- [ ] Verificar restauración, WhatsApp V3 real y plan de rollback.

**Decisión vigente:** continuar con Render. No volver a investigar otros proveedores sin nueva instrucción del usuario.
