# HogarStock V3 — Puerta verificable de coste adicional cero (Render + Turso)

**Fecha de revisión:** 2026-11-08  
**Decisión vigente:** mantener Render; no investigar ni adoptar otros alojamientos salvo nueva instrucción.  
**Método:** consulta de documentación oficial y **lectura exclusiva** de la configuración/métricas disponibles de Render. **No** se han creado servicios, bases, tokens, pagos, despliegues ni conexiones SQL a Turso de producción.

## 1. Resultado verificado: condiciones públicas

### Turso Cloud Free

Fuente primaria: https://turso.tech/pricing

| Concepto | Publicado para Free |
|---|---:|
| Precio base | 0 USD/mes |
| Tarjeta requerida para comenzar Free | No |
| Número de bases | 100 |
| Almacenamiento | 5 GB |
| Filas leídas/mes | 500 millones |
| Filas escritas/mes | 10 millones |
| Sincronización/mes | 3 GB |
| Point-in-time restore | 1 día |

El proveedor indica que los excedentes de almacenamiento, lecturas, escrituras y sincronización **se facturan automáticamente cuando se habilitan**. La página pública no acredita las opciones que estén activadas en la cuenta del usuario. Debe confirmarse **Free + overages deshabilitados + no servicios facturables**, además del consumo privado actual, antes de ejecutar consultas reales o crear bases. Si las cuotas se superan, puede haber suspensión/bloqueo de operaciones; no se debe resolver aceptando un pago.

### Render Free

Fuentes primarias:
- https://render.com/docs/free
- https://render.com/docs/faq
- https://render.com/docs/render-dashboard
- https://render.com/docs/build-pipeline
- https://render.com/docs/outbound-bandwidth

Las condiciones publicadas incluyen:
- **750 horas de instancia Free por workspace y mes**, compartidas entre los servicios; se suspenden al agotarse.
- **Hibernación tras 15 minutos sin tráfico entrante**; arranque frío cuando vuelve una solicitud.
- Para un workspace Hobby, la documentación indica **500 minutos mensuales** de compilación estándar y **5 GB mensuales** de ancho de banda de salida incluidos.
- Aunque la instancia de cómputo sea Free, **sí se pueden facturar excedentes de ancho de banda o de compilación** si la cuenta tiene método de pago; también pueden existir otros conceptos facturables. Sin método de pago, el proveedor limita/suspende servicios o compilaciones al agotar esas cuotas.
- El directorio local de Render Free es **efímero**, por lo que credenciales WhatsApp guardadas solo allí no son recuperables de forma fiable.
- Dos servicios Free que permanecieran funcionando 24 h/día durante 31 días consumirían conjuntamente **1.488 horas**, más de las 750 compartidas. Esto demuestra que **no se pueden prometer dos instancias continuas gratuitas** en el mismo workspace. Un servicio inactivo puede hibernar y consumir menos; no se han verificado horas reales restantes.

## 2. Evidencia obtenida de la cuenta conectada de Render (sin cambios)

Consulta de solo lectura del 8 de noviembre de 2026:

| Campo | Observado |
|---|---|
| Servicio | `hogarstock` |
| Número de servicios listados | 1 |
| Plan de instancia | `free` |
| Rama | `main` |
| Inicio | `node server.js` |
| Región | `frankfurt` |
| Auto-deploy | Sí, de `main` |
| Estado de suspensión devuelto | `not_suspended` |
| Nueva instancia V3 | No observada |

**Métricas read-only**, rango solicitado de 2026-11-01 a 2026-11-08T19:00Z: 64 puntos de uso de ancho de banda con unidad MB y suma aproximada **32,25 MB** en las muestras recibidas (primer punto 2026-11-02T16:00Z, último 2026-11-07T09:00Z). Los datos `instance_count` no devolvieron puntos. **No es un extracto de facturación, no cubre necesariamente todos los intervalos, ni permite calcular horas restantes, importe adeudado o gasto futuro**. No es prueba de continuidad 24/7.

Los conectores disponibles no exponen el panel de facturación privada de Render ni Turso. No hay un conector directo de Turso disponible; ninguna credencial privada ha sido solicitada o utilizada.

## 3. Comprobación privada, sin operaciones facturables

**Paso A — Render**

1. Entrar en https://dashboard.render.com y seleccionar el workspace que contiene `hogarstock`.
2. Abrir **Billing** (menú lateral) y revisar **Monthly Included Usage**.
3. Anotar solo: (a) horas Free utilizadas y su límite, (b) ancho de banda utilizado/permitido, (c) minutos de compilación consumidos/permitidos, (d) si se muestra algún cargo acumulado adicional y (e) si la cuenta puede facturar excedentes. No enviar números de tarjeta, datos personales de pago, recibos completos ni identificadores privados.
4. Comprobar que el servicio existente sigue en plan `free` y **no cambiarlo a un plan de pago**.
5. No crear un segundo Render web service todavía: falta demostrar que no agota las horas gratuitas de V2.

**Paso B — Turso**

1. Abrir https://app.turso.tech e iniciar sesión en la organización que aloja el catálogo de HogarStock.
2. Consultar **Billing / Plan / Usage** (la posición exacta puede variar según la versión del panel).
3. Confirmar: (a) plan `Free`, (b) uso de almacenamiento, lecturas, escrituras y bases, (c) indicador de **Overages deshabilitado**, (d) ausencia de servicios/suscripciones de pago y de gastos acumulados.
4. **No pulsar botones de habilitación** de Overages, mejora de plan, pago, nueva base o métodos de pago. No crear un token de acceso únicamente para comprobar facturación.
5. Se pueden compartir en el chat **solo las cantidades y los estados** de las cuotas; no compartir tokens, URL de base con autorización, `.env`, contraseñas ni detalles de pagos.

**Formato mínimo de resultado no sensible:**

```text
RENDER:
Free instance hours usadas/límite: ____ / 750
Outbound bandwidth usado/límite: ____ / ____
Build minutes usados/límite: ____ / ____
Cargos adicionales configurados o observados: sí/no/no verificable
Posibilidad de facturación por excedentes: sí/no/no verificable

TURSO:
Plan: Free/otro/no verificable
Bases usadas/límite: ____ / 100
Storage usado/límite: ____ / 5 GB
Filas leídas este mes/límite: ____ / 500 M
Filas escritas este mes/límite: ____ / 10 M
Overages habilitados: sí/no/no verificable
Gastos adicionales observados: sí/no/no verificable
```

## 4. Matriz de decisión de coste cero

| Requisito | Estado actual | Acción permitida |
|---|---|---|
| Hosting principal Render identificado | Verificado | Continuar con V2 sin cambios |
| Cuotas generales Render y Turso conocidas | Verificado por fuente oficial | Planificar, no asumir cuota disponible |
| Uso y facturación privada Render | **No verificado** | Solo leer el panel |
| Uso y Overages de la cuenta Turso | **No verificado** | Solo leer el panel |
| Sin costes adicionales en nueva infraestructura | **No demostrado** | No crear nuevo servicio ni base |
| Consulta Turso V2 de metadatos | Script preparado, no ejecutado | No conectar hasta aprobación S/N y cuota verificada |
| Restauración real y WhatsApp V3 independiente | Pendiente | Sin autorización de pruebas reales |
| Despliegue de V3 | Bloqueado | No tocar `main`, Render V2 ni datos |

**Criterio de cierre de esta fase:** solo cuando se aporten los estados de ambos paneles, confirmar si las operaciones remotas propuestas caben dentro de la cuota sin cargos. Si no puede demostrarse, la respuesta es **NO AUTORIZADO**, no «probablemente gratuito».

## 5. Riesgos independientes de las cuotas

- Render Free **no ofrece continuidad 24/7**, por lo que un socket Baileys puede desconectarse con la hibernación. Esto es un riesgo funcional, distinto del coste.
- Baileys es no oficial; aun con hosting disponible no puede garantizarse que una cuenta personal de WhatsApp no experimente restricciones.
- Una comprobación de cuotas no sustituye un backup coherente ni una restauración probada.
- Los indicadores de gastos del panel deben ser interpretados con su período de facturación y con la configuración de la cuenta, no con muestras de métricas generales.
- La alternativa manual para WhatsApp está probada en V3 pero no satisface por completo el requisito de automatización.

## Checklist de continuación

- [x] Render se mantiene como único hosting decidido.
- [x] Tarifa pública Turso Free confirmada con fuente oficial.
- [x] Limitaciones económicas de Render Free contrastadas con documentos oficiales.
- [x] Servicio V2 confirmado en la cuenta Render y telemetría observada sin cambios.
- [x] Comprobaciones privadas de uso redactadas sin pedir credenciales.
- [ ] Revisar los dos paneles de facturación/uso.
- [ ] Confirmar que Turso está en Free y Overages está apagado.
- [ ] Confirmar que Render no pueda generar cargos adicionales en el escenario propuesto.
- [ ] Autorizar S/N la auditoría Turso V2, después de verificar las cuotas.
- [ ] Respaldar, restaurar, probar WhatsApp V3 real y autorizar despliegue reversible sobre Render.

**Decisión vigente del usuario:** «sigue con render y ya veremos luego otras opciones». Esta decisión permanece activa.
