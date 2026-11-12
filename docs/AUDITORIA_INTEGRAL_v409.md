# HogarStock v4.09 — Auditoría integral de estabilidad (2026-11-12)

## Estado verificado antes del cambio
- GitHub main: `a79ee536666e7ef9c0255b15b961c3a52beb6bc6`, Render estado `live`.
- Catálogo v4.07: cierre definitivo aplicado en Turso (161 productos; 4 renombrados) el 12/11/2026 07:10 UTC, según registros del servidor.
- Ping GitHub: únicamente 1 ejecución real por `schedule` hasta el momento de la comprobación, HTTP 200 a 01:55 UTC. NO demuestra frecuencia de 10 minutos. No se añaden trabajos que consuman presupuesto privado ni servicios nuevos.
- WhatsApp: conectado después de reconexiones por código 500, separadas por unos 50 minutos, según registros del 12/11/2026 a las 07:42 y 08:33 UTC. Es evidencia de inestabilidad temporal, no de una pérdida comprobada de mensajes.
- Eliminación y recuperación ya estaban implementadas en la versión v4.08, por archivado seguro.

## Pruebas adicionales
- Simulacro SQLite local efímero con 161 nombres inventados, una compra ficticia abierta, un elemento pendiente, envíos ficticios, clave WA ficticia, hash administrativo ficticio y tabla de auditoría de catálogo.
- Verifica que no se elimina un producto incluido en una compra activa, que sí puede retirarse/restaurarse otro producto, que se conservan IDs y estados, y que el número de filas físicas no cambia.
- Cifra un respaldo de ese escenario, valida presencia de todas las tablas y hashes, restaura solo en memoria y contrasta integridad. Rechaza un archivo alterado o una contraseña incorrecta. No obtiene ningún dato remoto.
- En WhatsApp, la ventana de observación de desconexiones 500 pasa de 30 minutos a 2 horas, para detectar reconexiones separadas por ~50 minutos. Sin alterar los reintentos ni la sesión.
- El control real de cierre de compra y envíos sigue cubierto por las pruebas anteriores, sin enviar mensajes reales.

## Restricciones y decisiones
- 0 euros adicionales. Sin tarjetas, servicios nuevos ni modificaciones de datos reales.
- No se prueba el envío extremo a extremo real de WhatsApp: hacerlo requeriría enviar mensajes a contactos de confianza; aquí solo se verifica la instrumentación y regresión local.
- No se descarga ningún respaldo con credenciales reales: la restauración se valida con datos sintéticos y aislados.
- El ping GitHub `schedule` no ofrece garantías de puntualidad ni continuidad; se requiere mecanismo de supervisión externo para alta fiabilidad, sujeto a una cuenta de servicio gratis autorizada por el usuario.
- La copia en memoria valida integridad, no sustituye un procedimiento de recuperación operacional ante desastre con instrucciones de custodia de contraseñas.

## Siguientes hitos
1. Certificar CI y Render de esta versión.
2. Comprobar en tiempo real la frecuencia de ejecuciones programadas.
3. Validar, con autorización y destinatarios reales, un ciclo WhatsApp completo.
4. Integrar monitor externo gratuito sin métodos de pago si el usuario lo conecta.
