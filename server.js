const express = require("express");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./db");
const { default: makeWASocket, DisconnectReason } = require("@whiskeysockets/baileys");
const { useTursoAuthState } = require('./auth-state');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static("public"));

// --- WHATSAPP (Baileys) ---
let sock = null;
let qrActual = null;
let whatsappConectado = false;

async function iniciarWhatsApp() {
  try {
    // Usamos la sesión persistente en Turso
    const { state, saveCreds } = await useTursoAuthState();
    
    // Configuración con identificación "Mac OS" para intentar evitar bloqueos
    sock = makeWASocket({ 
      auth: state, 
      printQRInTerminal: false,
      browser: ["Mac OS", "Chrome", "14.4.1"]
    });
    
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log("📱 QR GENERADO. Esperando escaneo...");
        qrActual = qr;
        whatsappConectado = false;
        broadcast({ type: "qr_update" });
      }
      
      if (connection === "close") {
        whatsappConectado = false;
        qrActual = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log("❌ Conexión cerrada. Razón:", lastDisconnect?.error?.message);
        
        if (shouldReconnect) {
          console.log("🔄 Reconectando en 5 segundos...");
          setTimeout(iniciarWhatsApp, 5000);
        }
      } else if (connection === "open") {
        whatsappConectado = true;
        qrActual = null;
        console.log("✅ WHATSAPP CONECTADO.");
        broadcast({ type: "qr_update" });
      }
    });
  } catch (e) {
    console.error("Error al iniciar WhatsApp:", e);
    setTimeout(iniciarWhatsApp, 5000);
  }
}

async function enviarWhatsApp(telefono, mensaje) {
  if (!whatsappConectado || !sock) throw new Error("WhatsApp no está conectado.");
  const jid = telefono.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text: mensaje });
}

// --- API ENDPOINTS ---
app.get("/api/productos", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM productos ORDER BY categoria, nombre");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/whatsapp-status", (req, res) => {
  res.json({ conectado: whatsappConectado, qr: qrActual });
});

app.post("/api/agotar/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const current = await db.execute({ sql: "SELECT agotado FROM productos WHERE id = ?", args: [id] });
    const nuevoEstado = current.rows[0].agotado === 1 ? 0 : 1;
    await db.execute({ sql: "UPDATE productos SET agotado = ? WHERE id = ?", args: [nuevoEstado, id] });
    const result = await db.execute("SELECT * FROM productos ORDER BY categoria, nombre");
    broadcast({ type: "update", productos: result.rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/iniciar-compra", async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta el número de teléfono" });
  
  try {
    const result = await db.execute("SELECT * FROM productos WHERE agotado = 1 ORDER BY categoria, nombre");
    if (result.rows.length === 0) return res.status(400).json({ error: "No hay productos agotados" });
    
    const baseUrl = req.protocol + '://' + req.get('host');
    const enlace = `${baseUrl}/comprador.html?tel=${telefono}`;
    
    const listaTexto = result.rows.map(p => `- ${p.nombre}`).join("\n");
    const mensaje = `🛒 *Lista de compras*\n\nHacen falta:\n${listaTexto}\n\nAbre este enlace:\n${enlace}`;
    
    await enviarWhatsApp(telefono, mensaje);
    res.json({ ok: true, cantidad: result.rows.length });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// MARCAR PRODUCTO COMO COMPRADO (No envía WhatsApp para evitar spam)
app.post("/api/comprado/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute({ sql: "UPDATE productos SET agotado = 0 WHERE id = ?", args: [id] });
    const result = await db.execute("SELECT * FROM productos ORDER BY categoria, nombre");
    broadcast({ type: "update", productos: result.rows });
    
    const pendientes = result.rows.filter(p => p.agotado === 1);
    res.json({ ok: true, completado: pendientes.length === 0, faltan: pendientes.length });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// FINALIZAR COMPRA (Envía un único mensaje de resumen)
app.post("/api/finalizar-compra", async (req, res) => {
  const { telefono } = req.body;
  try {
    const result = await db.execute("SELECT * FROM productos WHERE agotado = 1 ORDER BY categoria, nombre");
    const pendientes = result.rows;
    
    let msg = pendientes.length === 0 
      ? "✅ *¡Compra completada!* Ya no falta nada por comprar." 
      : `⚠️ *Compra finalizada.*\n\nFaltaron por comprar:\n${pendientes.map(p => `- ${p.nombre}`).join("\n")}`;
    
    if (telefono) {
      await enviarWhatsApp(telefono, msg).catch(err => console.error("Error enviando WA:", err.message));
    }
    res.json({ ok: true, faltan: pendientes.length });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --- WebSockets ---
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

// --- ARRANQUE ORDENADO ---
(async () => {
  try {
    console.log("⏳ Inicializando base de datos...");
    await initDB();
    console.log("✅ Base de datos lista.");
    
    console.log("⏳ Iniciando WhatsApp...");
    await iniciarWhatsApp();
    
    server.listen(process.env.PORT || 3000, () => {
      console.log(`🚀 Servidor en el puerto ${process.env.PORT || 3000}`);
    });
  } catch (e) {
    console.error("❌ Error fatal en el arranque:", e);
  }
})();
