# HogarStock V3 — Diseño de seguridad y autorización

**Estado:** especificación de desarrollo, NO implementada.  
**Fecha:** 2026-11-05.  
**Rama:** `seguridad-pruebas-2026-11-05`.  
**Regla:** este documento NO autoriza por sí solo un despliegue ni una migración de producción.

## 1. Objetivo

Evitar que una persona no autorizada pueda consultar el QR de WhatsApp, modificar la lista o emitir mensajes, sin impedir que un comprador invitado utilice su enlace desde el teléfono. No se publicarán tokens, contraseñas, números privados ni QR en el repositorio.

## 2. Roles

- **Administrador:** inicia sesión y puede gestionar productos, destinatarios y compras, consultar el estado de WhatsApp y su QR cuando corresponde.
- **Comprador invitado:** utiliza una autorización aleatoria asociada exclusivamente a una compra; puede consultar, marcar, deshacer y finalizar **esa compra**. No recibe permisos globales de administración.
- **Visitante no autenticado:** puede consultar únicamente la pantalla pública de inicio de sesión, recursos estáticos no sensibles y una comprobación genérica de salud. No recibe datos privados del catálogo ni estado/QR de WhatsApp.

## 3. Identificación y sesiones

- Contraseña de administrador configurada mediante secreto de entorno; nunca embebida en HTML, JavaScript público, Git ni trazas.
- Verificación de contraseña mediante hash robusto y sal aleatoria; no guardar contraseñas reversibles. Seleccionar el esquema concreto tras pruebas en la versión real de Node.
- Sesión del administrador mediante identificador impredecible, almacenado únicamente en cookie `HttpOnly`, `Secure`, `SameSite=Lax`, con expiración, rotación tras autenticación y revocación al cerrar sesión.
- Almacenar en el servidor únicamente hash del identificador de sesión si se necesita persistencia. Los reinicios y múltiples instancias deben considerarse explícitamente.
- Peticiones que modifican datos: validación de origen/CSRF, límites de cuerpo y control de abuso.
- El frontend no debe contener una contraseña secreta ni confiar en ocultar botones como medida de seguridad.

## 4. Enlaces de compras

- Crear un identificador de compra persistente y un token de invitación de alta entropía con `crypto.randomBytes`; almacenar **únicamente su hash**.
- Entregar el enlace de invitación al destinatario deseado. El token no representa el teléfono ni puede sustituirse por `?tel=`.
- Evitar registros del token en logs. Una vez validado, preferir intercambiarlo por una cookie de sesión de compra `HttpOnly` y limpiar la URL del navegador, para reducir fugas por historial y referers.
- Autorizar cada petición de compra usando su ID y autorización; nunca aceptar un ID de producto como prueba suficiente.
- Expiración, cierre y revocación; determinar política concreta en la especificación funcional.
- Un token de una compra no debe dar acceso a otra compra ni al catálogo completo.

## 5. Matriz de endpoints propuesta

| Operación | Visitante | Comprador invitado | Administrador |
|---|---|---|---|
| Salud genérica `GET /health` | Sí (mínima) | Sí | Sí |
| Login/logout `POST /api/auth/*` | Login | Según sesión | Sí |
| Listar/editar productos globales | No | No | Sí |
| Consultar QR / estado detallado WhatsApp | No | No | Sí |
| Enviar mensajes/iniciar compra | No | No | Sí |
| Consultar compra especificada | No | Solo su compra | Sí |
| Marcar/deshacer ítem de compra | No | Solo su compra | Sí |
| Finalizar compra | No | Solo su compra | Sí |
| Consultar otras compras/contactos | No | No | Sí |
| WebSocket administrativo | No | No | Sí |
| Canal de compra en tiempo real | No | Solo su compra | Sí |

## 6. Dependencias funcionales y migración

El servidor actual utiliza una única lista global y URLs `comprador.html?tel=...`. Una autenticación estricta aplicada inmediatamente a `/api/comprado/:id` rompería el enlace actual. Por ello el despliegue debe coordinarse con el nuevo modelo `compras` y `compra_items`, y con una interfaz de comprador actualizada. Hasta entonces, **ningún cambio parcial de seguridad debe publicarse como si cerrara todas las rutas**.

La sesión Baileys usa archivos locales `auth_info_baileys`; NO replicar ni usar sesiones reales en las pruebas. El estado de WhatsApp debe ser administrativo y no contener QR en canales globales públicos. El frontend actual tiene teléfonos privados incrustados; deben retirarse en la misma liberación que incorpore la gestión privada de destinatarios.

## 7. Verificación exigida antes de cualquier despliegue

1. Sin credenciales: `GET /api/whatsapp-status` no revela QR; todos los POST administrativos devuelven 401/403 sin mutar estado.
2. Un usuario autenticado puede crear una compra, sin capacidad de utilizar el QR desde una sesión de comprador.
3. Token de compra A no puede leer, modificar ni finalizar compra B.
4. Token ausente, manipulado, caducado o revocado: operaciones rechazadas.
5. Endpoint de compra funciona desde móvil sin contraseña administrativa.
6. Repetir rápidamente operaciones o reintentar después de red caída no duplica resultados.
7. Rechazar inyección de HTML/JS en nombres y categorías; escapar siempre datos al renderizar.
8. El resumen de WhatsApp refleja fallos reales y no notifica éxito sin evidencia.
9. Dos compradores simultáneos no mezclan compras o notificaciones.
10. Tests aislados y de integración, revisión de secretos, respaldo restaurable y procedimiento de reversión.

## 8. Pendientes de diseño

- Determinar método de inicialización/recuperación del administrador, con secreto gestionado en Render.
- Decidir duración/revocación de sesiones y enlaces; no asumir valores sin revisar el uso familiar.
- Concretar estados, propiedad de cada compra e histórico.
- Elegir soporte de sesiones persistentes en Turso e implementar auditoría proporcional.
- Evaluar comportamiento frente a reinicios gratuitos de Render y sus WebSockets.

**Próxima implementación:** preparar control de sesión y autorización en rama aislada, con pruebas automatizadas; luego modificar de forma coordinada backend y ambas páginas. Nunca conectar estas pruebas al Turso o WhatsApp reales.
