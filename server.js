
const express = require("express");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./db");

let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let fetchLatestWaWebVersion;
let promesaBaileys;

async function cargarBaileys() {
  if (!promesaBaileys) {
    promesaBaileys = import("@whiskeysockets/baileys")
      .then((modulo) => {
        makeWASocket = modulo.default;
        useMultiFileAuthState = modulo.useMultiFileAuthState;
        DisconnectReason = modulo.DisconnectReason;
        fetchLatestWaWebVersion = modulo.fetchLatestWaWebVersion;

        if (
          typeof makeWASocket !== "function" ||
          typeof useMultiFileAuthState !== "function" ||
          typeof fetchLatestWaWebVersion !== "function"
        ) {
          throw new Error(
            "La version instalada de Baileys no exporta las funciones requeridas. Revisar package.json."
          );
        }
      })
      .catch((error) => {
        promesaBaileys = null;
        throw error;
      });
  }
  await promesaBaileys;
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static("public"));

let sock = null;
let qrActual = null;
let whatsappConectado = false;
let reconexionTimer = null;
let intentosFallidos = 0;
let errorWhatsApp = null;

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

function anunciarEstado() {
  broadcast({ type: "qr_update" });
}

function programarReconexion() {
  if (reconexionTimer) return;

  intentosFallidos += 1;

  const segundos = Math.min(
    30 * (2 ** Math.min(intentosFallidos - 1, 3)),
    300
  );

  console.log(
    `Reintentando WhatsApp en ${segundos} segundos (intento ${intentosFallidos}).`
  );

  reconexionTimer = setTimeout(() => {
    reconexionTimer = null;
    void iniciarWhatsApp();
  }, segundos * 1000);
}

async function iniciarWhatsApp() {
  try {
    await cargarBaileys();

    const respuesta = await fetchLatestWaWebVersion();
    const version = respuesta && respuesta.version;

    if (
      !respuesta ||
      respuesta.isLatest !== true ||
      !Array.isArray(version) ||
      version.length !== 3 ||
      !version.every((v) =>
        Number.isInteger(v) && v >= 0
      )
    ) {
      throw new Error(
        "No se pudo confirmar una version actual de WhatsApp Web. Se evitara conectar con una version obsoleta."
      );
    }

    console.log(
      `Version WhatsApp Web consultada: ${version.join(".")}`
    );

    const { state, saveCreds } =
      await useMultiFileAuthState("auth_info_baileys");

    const nuevoSocket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
    });

    sock = nuevoSocket;
    qrActual = null;
    whatsappConectado = false;
    errorWhatsApp = null;

    anunciarEstado();

    nuevoSocket.ev.on("creds.update", saveCreds);

    nuevoSocket.ev.on("connection.update", (update) => {
      if (sock !== nuevoSocket) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("Nuevo QR de WhatsApp generado.");
        qrActual = qr;
        whatsappConectado = false;
        errorWhatsApp = null;
        anunciarEstado();
      }

      if (connection === "open") {
        whatsappConectado = true;
        qrActual = null;
        errorWhatsApp = null;
        intentosFallidos = 0;

        console.log("WhatsApp conectado.");
        anunciarEstado();
        return;
      }

      if (connection === "close") {
        whatsappConectado = false;
        qrActual = null;

        const codigo =
          lastDisconnect?.error?.output?.statusCode;

        errorWhatsApp =
          `Conexion cerrada (codigo ${codigo ?? "desconocido"})`;

        console.error(errorWhatsApp);
        anunciarEstado();

        if (codigo === DisconnectReason.loggedOut) {
          console.error(
            "WhatsApp cerro la sesion. Se requiere revisar la vinculacion; no se borraran credenciales automaticamente."
          );
          return;
        }

        programarReconexion();
      }
    });
  } catch (error) {
    whatsappConectado = false;
    qrActual = null;

    errorWhatsApp =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "Error al iniciar WhatsApp:",
      errorWhatsApp
    );

    anunciarEstado();
    programarReconexion();
  }
}

async function enviarWhatsApp(telefono, mensaje) {
  if (!whatsappConectado || !sock) {
    throw new Error("WhatsApp no esta conectado.");
  }

  const numero = String(telefono || "")
    .replace(/[^0-9]/g, "");

  if (!/^\d{8,15}$/.test(numero)) {
    throw new Error(
      "Numero de WhatsApp no valido; utiliza el prefijo internacional."
    );
  }

  await sock.sendMessage(
    `${numero}@s.whatsapp.net`,
    { text: mensaje }
  );
}

app.get("/api/productos", async (req, res) => {
  try {
    const result = await db.execute(
      "SELECT * FROM productos ORDER BY categoria, nombre"
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.get("/api/whatsapp-status", (req, res) => {
  res.json({
    conectado: whatsappConectado,
    qr: qrActual,
    error: errorWhatsApp,
  });
});

app.post("/api/agotar/:id", async (req, res) => {
  try {
    const current = await db.execute({
      sql: "SELECT agotado FROM productos WHERE id = ?",
      args: [req.params.id],
    });

    if (current.rows.length === 0) {
      return res.status(404).json({
        error: "Producto no encontrado",
      });
    }

    const nuevoEstado =
      Number(current.rows[0].agotado) === 1 ? 0 : 1;

    await db.execute({
      sql: "UPDATE productos SET agotado = ? WHERE id = ?",
      args: [nuevoEstado, req.params.id],
    });

    const result = await db.execute(
      "SELECT * FROM productos ORDER BY categoria, nombre"
    );

    broadcast({
      type: "update",
      productos: result.rows,
    });

    res.json({
      ok: true,
      nuevoEstado,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/api/iniciar-compra", async (req, res) => {
  const { telefono } = req.body || {};

  if (!telefono) {
    return res.status(400).json({
      error: "Falta el numero de telefono",
    });
  }

  try {
    const result = await db.execute(
      "SELECT * FROM productos WHERE agotado = 1 ORDER BY categoria, nombre"
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "No hay productos agotados",
      });
    }

    const baseUrl = (
      process.env.PUBLIC_BASE_URL ||
      "https://hogarstock.onrender.com"
    ).replace(/\/+$/, "");

    const enlace =
      `${baseUrl}/comprador.html?tel=${encodeURIComponent(telefono)}`;

    const listaTexto = result.rows
      .map((p) => `- ${p.nombre}`)
      .join("\n");

    const mensaje =
      `🛒 *Lista de compras*\n\nHacen falta:\n${listaTexto}\n\nAbre este enlace:\n${enlace}`;

    await enviarWhatsApp(telefono, mensaje);

    res.json({
      ok: true,
      cantidad: result.rows.length,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/api/comprado/:id", async (req, res) => {
  try {
    const producto = await db.execute({
      sql: "SELECT id FROM productos WHERE id = ?",
      args: [req.params.id],
    });

    if (producto.rows.length === 0) {
      return res.status(404).json({
        error: "Producto no encontrado",
      });
    }

    await db.execute({
      sql: "UPDATE productos SET agotado = 0 WHERE id = ?",
      args: [req.params.id],
    });

    const result = await db.execute(
      "SELECT * FROM productos ORDER BY categoria, nombre"
    );

    broadcast({
      type: "update",
      productos: result.rows,
    });

    const pendientes = result.rows.filter(
      (p) => Number(p.agotado) === 1
    );

    res.json({
      ok: true,
      completado: pendientes.length === 0,
      faltan: pendientes.length,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/api/finalizar-compra", async (req, res) => {
  const { telefono } = req.body || {};

  try {
    const result = await db.execute(
      "SELECT * FROM productos WHERE agotado = 1 ORDER BY categoria, nombre"
    );

    const pendientes = result.rows;

    const mensaje =
      pendientes.length === 0
        ? "✅ *¡Compra completada!* Ya no falta nada por comprar."
        : `⚠️ *Compra finalizada.*\n\nFaltaron por comprar:\n${pendientes.map((p) => `- ${p.nombre}`).join("\n")}`;

    if (telefono) {
      try {
        await enviarWhatsApp(telefono, mensaje);
      } catch (error) {
        console.error(
          "No se pudo enviar el resumen:",
          error.message
        );
      }
    }

    res.json({
      ok: true,
      faltan: pendientes.length,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

(async () => {
  try {
    await initDB();

    const puerto = process.env.PORT || 3000;

    server.listen(puerto, () => {
      console.log(
        `HogarStock escuchando en el puerto ${puerto}`
      );
    });

    void iniciarWhatsApp();
  } catch (error) {
    console.error(
      "Error fatal al iniciar HogarStock:",
      error
    );
    process.exitCode = 1;
  }
})();
