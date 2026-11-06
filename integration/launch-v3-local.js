"use strict";

// LANZADOR EXCLUSIVO DE DEMOSTRACION V3 EN LOOPBACK.
// Nunca importa server.js, Baileys ni Turso remoto; usa el servidor HTTPS
// de pruebas con SQLite temporal, productos ficticios y clave de DEMO.
// La información generada se elimina al cerrar el proceso.
const { crearServidorAislado, CLAVE_DEMO } =
  require("./v3-sandbox-server.js");

async function iniciarVistaLocal({ entorno = process.env, mostrar = console.log } = {}) {
  if (entorno.HOGARSTOCK_V3_SANDBOX !== "1" ||
      entorno.TURSO_DATABASE_URL || entorno.TURSO_AUTH_TOKEN ||
      entorno.HOGARSTOCK_V3_WHATSAPP_LIVE === "1" ||
      entorno.WA_MASTER_KEY) {
    throw new Error("V3_DEMO_ENTORNO_NO_AISLADO");
  }
  const certPath = entorno.HOGARSTOCK_SANDBOX_CERT;
  const keyPath = entorno.HOGARSTOCK_SANDBOX_KEY;
  if (!certPath || !keyPath) throw new Error("V3_DEMO_CERTIFICADO_AUSENTE");
  const server = await crearServidorAislado({ certPath, keyPath });
  mostrar("HOGARSTOCK V3 | VISTA DE PRUEBAS EN ESTE EQUIPO");
  mostrar("Administrador: " + server.origen + "/admin-v3.html");
  mostrar("Contraseña de PRUEBAS (no reutilizar): " + CLAVE_DEMO);
  mostrar("Datos: FICTICIOS y TEMPORALES; no se guardan al salir.");
  mostrar("WhatsApp: DESHABILITADO. Turso remoto: DESHABILITADO.");
  mostrar("Acceso: exclusivamente 127.0.0.1 (este ordenador).");
  mostrar("Para cerrar: Ctrl+C.");
  return server;
}
async function main() {
  let server;
  try {
    server = await iniciarVistaLocal();
  } catch (error) {
    // Evitar imprimir rutas privadas y trazas.
    process.stderr.write("NO_SE_PUEDE_INICIAR_VISTA_LOCAL: " +
      (["V3_DEMO_ENTORNO_NO_AISLADO","V3_DEMO_CERTIFICADO_AUSENTE"]
        .includes(error?.message) ? error.message : "CONFIGURACION_INVALIDA") + "\n");
    process.exitCode = 1;
    return;
  }
  let cerrando = false;
  async function cerrar() {
    if (cerrando) return;
    cerrando = true;
    try {
      await server.cerrar();
      process.stdout.write("V3_DEMO_CERRADA: datos temporales eliminados.\n");
    } catch (_) {
      process.stderr.write("V3_DEMO_CIERRE_NO_CONFIRMADO\n");
      process.exitCode = 1;
    }
  }
  process.once("SIGINT", () => { void cerrar(); });
  process.once("SIGTERM", () => { void cerrar(); });
}
if (require.main === module) void main();
module.exports = { iniciarVistaLocal };
