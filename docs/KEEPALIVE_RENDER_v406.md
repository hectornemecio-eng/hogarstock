# HogarStock: ping automático sin PC — v4.06.2

Fecha de configuración: 2026-11-11.

## Propósito
Mitigar la suspensión por inactividad de Render Free sin migración, instalación local, credenciales ni pagos.

## Comprobaciones previas
- Repositorio `hectornemecio-eng/hogarstock` público, rama productiva `main`.
- Render workspace `tea-dbkb6no473hc73861nbg` contiene un solo servicio web Free: `hogarstock`.
- Render Free suspende tras 15 minutos sin HTTP/WebSocket entrante y permite 750 horas gratuitas por workspace por mes.
- GitHub Actions con runner estándar `ubuntu-latest` es gratuito en repositorios públicos.

## Configuración
Archivo `.github/workflows/keepalive-render.yml`.
Eventos: `schedule` UTC a los minutos 07,17,27,37,47,57, más ejecución manual, test en PR y comprobación al instalar.
HTTP HEAD a `https://hogarstock.onrender.com/admin-login.html`, que no consulta APIs ni datos privados. Requiere HTTP 200. Curl con límite máximo de 100 segundos, reintento puntual, 4 minutos de timeout por job, permisos del token vacíos.

## Limitaciones
- La planificación de GitHub Actions es de mejor esfuerzo: puede retrasarse u omitirse por carga del proveedor.
- GitHub desactiva las programaciones de repositorios públicos tras 60 días sin actividad en el repositorio. Vigilar periódicamente el workflow y reactivarlo desde GitHub si se detiene.
- Render puede reiniciar el servicio en cualquier momento; el ping no garantiza 100% de disponibilidad ni conexión WhatsApp estable.
- Consumir actividad 24/7 utiliza unas 720–744 horas de las 750 disponibles en cada mes de 30–31 días. Con otros servicios Free en el mismo workspace, se agotaría antes.
- Controlar cuota de red/compilaciones; si hay medio de pago en Render y se exceden cuotas de red, podrían aplicarse cargos. Este workflow HEAD transmite un volumen despreciable.
- No cambiar claves, tabla de productos, WebSockets, sesión WA, ni servicios adicionales.
- Este es un mecanismo provisional de disponibilidad dentro de las limitaciones gratuitas, no un SLA.

## Evidencia operativa
Se completará tras fusionar el PR y comprobar la ejecución inmediata. No confundir instalación de programación con prueba de periodicidad continua.
