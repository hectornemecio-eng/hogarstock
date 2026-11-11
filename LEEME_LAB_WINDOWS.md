# HogarStock v4.04 - Laboratorio local de la aplicacion real

## Ejecutar

1. Descarga el artefacto HogarStock_v404_LAB_WINDOWS desde GitHub Actions.
2. Extrae su ZIP en una carpeta nueva, preferiblemente en D:.
3. Ejecuta INICIAR_LAB_HOGARSTOCK.cmd con doble clic.
4. Abre la URL que aparezca en la ventana, si el navegador no se abre solo.
5. Contrasena inicial de DEMO: HogarStock-Demo-2026.

La aplicacion usa el mismo servidor Express, las rutas y el panel de v4.04.
La base de laboratorio se guarda en LAB_LOCAL/inventario-demo.sqlite.
Puedes anadir, editar, archivar y marcar productos, con persistencia local.

**Exclusiones:** WhatsApp desactivado; no envia mensajes, no genera QR;
sin conexion a Turso remoto ni Render; sin restauracion de .hsbk;
no se prueba compra compartida real.

La aplicacion escucha SOLO en 127.0.0.1.
Este laboratorio no debe exponerse a Internet.
La clave de DEMO no sirve para produccion ni debe reutilizarse.
No se modifica GitHub main ni el despliegue de Render.
