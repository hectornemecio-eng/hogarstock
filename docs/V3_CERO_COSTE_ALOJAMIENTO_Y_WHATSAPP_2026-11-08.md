# HogarStock V3 — alojamiento gratuito y continuidad de WhatsApp

**Fecha de comprobación:** 2026-11-08  
**Estado:** investigación documental y fallback manual implementado en laboratorio. No se han creado recursos externos ni modificado el V2 de Render.  
**Restricciones del proyecto:** coste adicional exactamente 0, sin tarjeta que pueda generar cargos, sin mantener encendido un ordenador doméstico, WhatsApp personal (no Business), comunicación en ambos sentidos y continuidad operacional demostrable.

## 1. Conclusión provisional

**No está acreditada aún ninguna combinación que garantice simultáneamente coste adicional 0, ausencia de tarjeta facturable, disponibilidad 24/7 y automatización oficial con WhatsApp personal.** Esta conclusión no demuestra que sea imposible conseguirlo; identifica barreras de infraestructura y de políticas del proveedor de mensajería.

### Comparación verificada

| Plataforma | Alojamiento WebSocket persistente | Acceso gratuito y tarjeta | Decisión |
|---|---|---|---|
| Render Free (actual) | Se suspende tras 15 minutos sin **tráfico entrante** HTTP o mensajes WebSocket que lleguen al servicio. Los mensajes del socket *saliente* hacia WhatsApp no acreditan actividad entrante en Render. Discos efímeros. | 750 horas/mes **compartidas** por workspace; no se han leído cuotas privadas. Excesos de salida/build pueden facturarse con método de pago. | Conservar V2. No crear segundo servicio hasta garantizar recursos y coste. No afirmar WhatsApp disponible 24/7. |
| Northflank Sandbox | La página de precios declara **Always on, no sleeping**. | Declara Free, dos servicios y hasta 20 USD/mes de recursos. La página actual indica **No card needed**, pero su documentación de facturación afirma que se requiere método de pago para crear recursos. No está demostrado límite automático de gasto sin facturación. | Candidato principal, **pendiente de aclaración** de contradicción en documentación y verificación de saldo/límites en cuenta. |
| Koyeb Free | Suspende instancia Free tras una hora sin tráfico. | Gratuito con limitaciones; no ofrece disponibilidad continua sin suspensión. | No resuelve el requisito 24/7. |
| Zeabur Free | Servicio duerme por inactividad. | Gratuito y sin tarjeta según documentación. | No resuelve el requisito 24/7. |
| Oracle Always Free | Recursos de cómputo sostenido posibles, sin garantía de disponibilidad. | Exige tarjeta de crédito/débito para comprobación de identidad y puede registrar retención de verificación. | No cumple la restricción operativa de no introducir tarjeta. |
| Cloudflare Workers + Durable Objects Free | Hibernación soportada para WebSocket **servidor**, no para WebSocket **saliente** de Baileys; conexión saliente abierta puede mantener consumo/duración. | Existe un nivel Free con cuotas; habría que rediseñar aplicación y demostrar compatibilidad. | No adoptar sin prototipo y pruebas de costes/compatibilidad. |

**Fuentes primarias verificadas:**
- Render: https://render.com/docs/free
- Northflank precios: https://northflank.com/pricing
- Northflank facturación (contradicción con precios): https://northflank.com/docs/v1/application/billing/pricing-on-northflank
- Koyeb: https://www.koyeb.com/docs/run-and-scale/scale-to-zero
- Zeabur: https://zeabur.com/docs/en-US/pricing/free-plan
- Oracle: https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm
- Cloudflare: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## 2. Riesgo de cuenta WhatsApp

- Baileys usa el protocolo WebSocket de WhatsApp Web y dispositivos vinculados. **No es API oficial ni está afiliada con WhatsApp**.
- Las normas de WhatsApp advierten de restricciones o baneos por automatización y mensajería no solicitada.
- Aunque una lista doméstica pequeña y consentida no sea spam, **no puede garantizarse** que WhatsApp acepte siempre una sesión automatizada de cuenta personal.
- Limitar contactos, velocidad de envíos y permisos reduce riesgos de abuso, pero **no convierte Baileys en oficial ni elimina el riesgo de suspensión**.
- Referencias: https://github.com/WhiskeySockets/Baileys y https://faq.whatsapp.com/361005896189245/ y https://www.whatsapp.com/legal/terms-of-service?lang=es

## 3. Fallback manual implementado en laboratorio

La pantalla `public/comprador-v3.html` añade la sección **Comunicar el resultado por WhatsApp**, visible únicamente cuando `compra.estado === "finalizada"`.

- Genera un mensaje legible a partir de la compra autorizada. Cuando todos están comprados: «Compra completa». Si hay artículos pendientes o no disponibles: enumera solo los faltantes con su estado.
- El mensaje **no incorpora la invitación de un solo uso, credenciales, token de sesión ni enlaces privados**. Los nombres de productos son información compartida intencionalmente con el destinatario elegido por la persona.
- Si el mensaje codificado cabe en un enlace de longitud razonable, abre `https://wa.me/?text=...` en otra pestaña (`rel="noopener noreferrer"`). Si es demasiado largo, exige copiar el texto y pegarlo manualmente; nunca omite productos de forma silenciosa.
- La opción `Copiar resumen` utiliza el portapapeles si el navegador lo permite, con selección manual como alternativa. Al cerrar la sesión, borra el texto y el enlace de la interfaz.
- **Nunca envía mensajes sola ni abre conexión Baileys**; el usuario debe elegir contacto y confirmar el envío en WhatsApp.
- No equivale a una conexión WhatsApp bidireccional totalmente automática: sí permite una comunicación **humana bidireccional asistida** (enlace de ida compartido por administrador y resumen final de vuelta enviado por comprador).
- El backend registra las compras con su estado en SQLite/Turso según el despliegue; esta operación cliente no reemplaza persistencia remota real.

Pruebas previstas/ejecutadas por GitHub Actions en `tests/v3-browser-e2e.test.js`: flujo de compra parcial, compra completa, prellenado de texto con `wa.me`, no exposición de token y limpieza del DOM tras cerrar sesión. **Registrar el resultado exacto de CI antes de declarar aprobado el hito.**

## 4. Siguiente puerta para alojamiento remoto

Antes de crear una cuenta o recurso en Northflank:

1. Comprobar la experiencia de alta Sandbox: **si se exige tarjeta, depósito, recarga, habilitar pago o aceptar facturación automática, detenerse sin crear recursos.**
2. Verificar por escrito o mediante interfaz que la cota de 20 USD es un **límite estricto**, no un crédito seguido de cargos.
3. Comprobar plan, cuota y política de suspensión por inactividad; verificar hostname TLS, WebSocket saliente, recursos mínimos Node y que la instancia no duerme.
4. Elegir un servicio de ensayo nuevo y base Turso nueva. Asegurar que no hay secretos ni sesiones reales de V2.
5. Habilitar despliegue solo tras aprobación expresa, back-up restaurado y pruebas completas de conexión.

Con las limitaciones actuales, el fallback manual es la ruta más cercana a funcionalidad familiar remota sin exigir procesos WhatsApp 24/7, aunque un Render Free dormido seguirá produciendo un arranque frío cuando alguien abra el enlace.

## 5. Checklist de decisión

- [x] Investigación de alternativas con fuentes primarias.
- [x] Identificada contradicción oficial en requisitos de pago de Northflank.
- [x] Documentado riesgo de usar Baileys en una cuenta WhatsApp personal.
- [x] Fallback manual de resultado implementado en V3 experimental.
- [ ] Confirmar CI de los nuevos recorridos Playwright.
- [ ] Confirmar Northflank Sandbox sin tarjeta y con cuota de gasto verdaderamente cerrada.
- [ ] Confirmar cuotas privadas de Turso y facturación de Render.
- [ ] Crear staging remoto separado **solo tras permiso y verificación de coste cero**.
- [ ] Probar conexiones reales, persistencia, restauración, migración y reversión antes de sustituir V2.

**Conclusión operativa:** la prioridad ya no es ampliar pruebas ficticias de forma indiscriminada; es superar verificaciones económicas y de red reales. Mantener `main`, V2, Turso y WhatsApp originales intactos hasta que se autorice el cambio.

## Actualización verificable — v3.54 (8 de noviembre de 2026)

Se han revisado de nuevo las fuentes primarias. **Northflank conserva una contradicción no resuelta**: la tabla comercial anuncia Sandbox Free `No card needed`, hasta 20 USD mensuales en recursos y `Always on, no sleeping`, pero su documentación de facturación indica que los usuarios deben añadir un medio de pago antes de crear recursos. La información pública no demuestra que el crédito sea un tope duro sin cargos. Se conserva el bloqueo: **no registrar tarjeta ni crear recursos**.

Se ha encontrado un candidato adicional que no debe confundirse con una solución probada: **Enzonic**, `https://www.enzonic.com/nodejs`. Según el propio proveedor, ofrece 1 servidor Free Forever por cuenta, 512 MB RAM, 50 % CPU, 10 GB SSD, Node 18/20/22, funcionamiento 24/7 y sin tarjeta, sujeto a capacidad. Otra página del mismo proveedor, `https://enzonic.com/es/web-hosting`, promete 3,5 GB RAM en el nivel gratuito. Esta discrepancia y la falta de evidencia independiente de disponibilidad o condiciones de agotamiento obligan a clasificarlo **candidato de confianza no determinada**. No se debe introducir ningún dato personal adicional ni alojar datos familiares sin revisar términos, región real, protección de datos y ausencia de cobros.

**Avance de ingeniería realizado sin despliegue:** el punto de entrada `integration/v3-remote-staging-entrypoint.js` acepta ahora dominios de staging estrictamente conformes a Render, Northflank (subdominios `*.code.run`) y Enzonic (subdominios `*.spain.free.enzonic.com` o `*.us.free.enzonic.com`). Exige además `HOGARSTOCK_V3_REMOTE_STAGE_PROVIDER` y `HOGARSTOCK_V3_REMOTE_STAGE_HOST` exactos. Se rechazan dominios de producción, rutas y puertos, hosts de otro proveedor, y sufijos falsos de dominio. **La red permanece bloqueada por defecto**. La aceptación de un hostname no valida su propiedad ni licencia.

Pruebas: `tests/v3-remote-staging.test.js` añade 4 casos (12 en esa suite). Workflow `42496038877`: **78/78 casos** con Node 20.11 y **78/78** con Node 22; regresión general `42496038676` correcta. No modifica el servicio actual de Render ni `main`.

**Criterios definitivos de selección de hosting (todos obligatorios):**
1. No requiere tarjeta, depósito, saldo prepago, suscripción, facturación por excedentes ni compromisos de cargo.
2. El proceso Node puede ejecutarse continuamente, sin suspensión por inactividad, con memoria suficiente para la aplicación, sujeto a cuota real verificada.
3. Permite HTTP(S) público, WebSocket **saliente** y salidas TLS a Turso y WhatsApp.
4. Tiene separación de secretos y datos, controles de acceso, soporte razonable y condiciones de tratamiento de datos familiares verificables.
5. Es posible obtener un respaldo restaurable, detener el despliegue sin coste y volver a V2.
6. El carácter no oficial de Baileys sigue siendo un riesgo independiente incluso con un hosting adecuado.

Si algún criterio esencial no puede acreditarse, la decisión es **NO APTO por ahora**, no «seguro porque la página diga Free».

Fuentes adicionales:
- https://www.enzonic.com/nodejs
- https://enzonic.com/es/web-hosting
- https://northflank.com/docs/v1/application/network/configure-ports
