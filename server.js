const express = require("express");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./db");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static("public"));

initDB();

// --- WHATSAPP (Baileys) ---
let sock = null;
let qrActual = null;
let whatsappConectado = false;

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrActual = qr;
      whatsappConectado = false;
      console.log("\n=======================================================");
      console.log("📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP:");
      console.log("   (WhatsApp > Dispositivos vinculados > Vincular dispositivo)");
      console.log("=======================================================\n");
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === "close") {
      whatsappConectado = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconectando WhatsApp...");
        iniciarWhatsApp();
      }
    } else if (connection === "open") {
      whatsappConectado = true;
      qrActual = null;
      console.log("\n✅ WHATSAPP CONECTADO CORRECTAMENTE.\n");
    }
  });
}

iniciarWhatsApp();

async function enviarWhatsApp(telefono, mensaje) {
  if (!whatsappConectado || !sock) {
    throw new Error("WhatsApp no está conectado. Escanea el QR en la consola.");
  }
  // Limpiar el número (quitar +, espacios, guiones)
  const jid = telefono.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text: mensaje });
}

// --- API ENDPOINTS ---

app.get("/api/productos", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM productos");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/whatsapp-status", (req, res) => {
  res.json({ conectado: whatsappConectado });
});

app.post("/api/agotar/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const current = await db.execute({ sql: "SELECT agotado FROM productos WHERE id = ?", args: [id] });
    const nuevoEstado = current.rows[0].agotado === 1 ? 0 : 1;
    await db.execute({
      sql: "UPDATE productos SET agotado = ? WHERE id = ?",
      args: [nuevoEstado, id],
    });
    const result = await db.execute("SELECT * FROM productos");
    broadcast({ type: "update", productos: result.rows });
    res.json({ ok: true, nuevoEstado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/iniciar-compra", async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta el número de teléfono" });

  try {
    const result = await db.execute("SELECT * FROM productos WHERE agotado = 1");
    if (result.rows.length === 0) return res.status(400).json({ error: "No hay productos agotados" });

    const compraId = Date.now().toString();
    const enlace = `http://localhost:3000/comprador.html`; // En local usamos localhost
    const listaTexto = result.rows.map(p => `- ${p.nombre}`).join("\n");
    
    const mensaje = `🛒 *Lista de compras de HogarStock*\n\nHacen falta:\n${listaTexto}\n\nAbre este enlace para marcar lo que vayas comprando:\n${enlace}`;
    
    await enviarWhatsApp(telefono, mensaje);
    
    res.json({ ok: true, compraId, cantidad: result.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/comprado/:id", async (req, res) => {
  const { id } = req.params;
  const { telefono } = req.body; // Pasamos el teléfono desde el frontend para avisar
  try {
    await db.execute({
      sql: "UPDATE productos SET agotado = 0 WHERE id = ?",
      args: [id],
    });
    
    const result = await db.execute("SELECT * FROM productos");
    broadcast({ type: "update", productos: result.rows });
    
    const pendientes = result.rows.filter(p => p.agotado === 1);
    let mensajeWA = "";
    
    if (pendientes.length === 0) {
      mensajeWA = "✅ *¡Compra completada!* Ya no falta nada por comprar. La lista está limpia.";
    } else {
      const faltan = pendientes.map(p => `- ${p.nombre}`).join("\n");
      mensajeWA = `⚠️ *Actualización de la compra*\n\nAún faltan por comprar:\n${faltan}`;
    }
    
    if (telefono) {
      await enviarWhatsApp(telefono, mensajeWA).catch(err => console.error("Error enviando WA:", err.message));
    }

    res.json({ 
      ok: true, 
      completado: pendientes.length === 0, 
      faltan: pendientes.length 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`🚀 HogarStock listo en http://localhost:${PORT}`);
  console.log(`=========================================\n`);
});
