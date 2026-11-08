# HogarStock V3 — E2E de reposición administrativa en navegador real

**Fecha:** 2026-11-08  
**Rama:** `seguridad-pruebas-2026-11-05`  
**Ámbito:** servidor HTTPS loopback, SQLite con datos ficticios, Chromium automatizado. **No** se usó Turso, WhatsApp real ni Render V3.

## Cambio introducido

1. `integration/v3-sandbox-server.js`: `crearServidorAislado` admite `habilitarReposicion: true`, solo como argumento de una llamada explícita de laboratorio. El valor por defecto es `false`, por lo que las rutas administrativas de reposición continúan **inexistentes** en el servidor habitual.
2. Cuando se habilita la prueba, el servidor inicializa `crearRepositorInventarioV3` exclusivamente con su cliente SQLite ficticio, restringido a `HOGARSTOCK_V3_SANDBOX=1`, y lo inyecta en `crearRouterV3`. Los filtros existentes impiden credenciales productivas.
3. `tests/v3-browser-e2e.test.js`: dos nuevas pruebas Playwright/Chromium HTTPS verifican el DOM y el efecto real en SQLite, además de las pruebas E2E ya existentes. No son tests de presencia de cadenas ni mocks de DOM.

## Resultados observados

**GitHub Actions:** https://github.com/hectornemecio-eng/hogarstock/actions/runs/42494573640  
**Commit probado:** `6f32b98a0157487f6cecf52fbb6e59983ac3b3af`  
**Resultado:** `success` en la regresión general; etapa Chromium HTTPS local: **13 pruebas, 13 aprobadas, 0 fallos**.

**Nueva prueba A — reposición completa con faltantes preservados**
- El administrador inicia sesión, abre una compra finalizada ficticia y solicita la conciliación.
- Se comprueba que aparecen un producto `REPONIBLE` y otro `NO_COMPRADO`.
- Un diálogo cancelado no modifica `productos.agotado`.
- Tras confirmación del diálogo, solo el producto comprado cambia `agotado: 1 → 0`; el pendiente permanece `1`.
- La bitácora registra exactamente una reposición.
- Al consultar de nuevo, la operación aparece como `CONCILIADA_ANTERIORMENTE`, sin ofrecer una segunda aprobación de la misma reposición.

**Nueva prueba B — resistencia al ABA desde el navegador**
- Se obtiene el informe de conciliación y se deja abierto.
- Otro proceso de ensayo cambia `agotado: 1 → 0 → 1` en la BD local.
- El administrador intenta aplicar la aprobación antigua.
- HTTP responde con el conflicto `V3_REPOSICION_DESACTUALIZADA`.
- El producto conserva `agotado=1` y la bitácora no registra reposiciones.

La batería de staging independiente previamente acreditada alcanzó **74/74 pruebas con Node 20.11.0 y 74/74 con Node 22** en GitHub Actions `42484916313`. Es una matriz de 74 casos distintos, repetida en dos versiones de Node. No sumar estos resultados a los 13 del navegador para expresar un porcentaje de cobertura: las suites y objetivos de ejecución son distintos.

## Controles preservados

- `main` y el arranque `npm start = node server.js` no se modificaron.
- El entorno real V2 en Render no se tocó.
- Los servidores remoto/estándar V3 no activan el repositor: necesitan inyección explícita.
- SQLite ficticia, certificados efímeros y conexiones exclusivamente loopback.
- No existen envíos reales a WhatsApp.

## Próxima puerta de aceptación

El circuito de reposición **ya está probado visualmente** en laboratorio; no repetirlo sin un defecto nuevo.

Las tareas decisivas para un V3 usable son:
1. Verificar cuotas y límites de gasto privados de Render/Turso para asegurar coste adicional cero sin suspender V2.
2. Aprovisionar, previa autorización, una base Turso de ensayo **completamente separada** y comprobar respaldo y restauración remotos.
3. Integrar y probar una sesión nueva de WhatsApp Baileys y comunicación bidireccional real con números de confianza, sin reutilizar la sesión V2.
4. Validar migración de catálogo, historial y sesiones entre V2 y V3, plan de reversión y pruebas de aceptación finales.
5. Publicar V3 solo tras superar esas puertas y con autorización de producción.

**Limitación:** éxito en Chromium local no demuestra disponibilidad, entrega WhatsApp, persistencia remota, ni seguridad de costes en Render.
