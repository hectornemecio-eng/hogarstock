"use strict";

// API V3 AISLADA de desarrollo. NO se monta en server.js.
// Depende de instancias previamente inicializadas de acceso, compras y
// conciliacion. No utiliza WhatsApp, Turso remoto ni catalogos reales.
const express = require("express");

const COOKIE_ADMIN = "hs_admin_v3";
const TTL_ADMIN_MS = 60 * 60 * 1000;
const TTL_COMPRA_MS = 24 * 60 * 60 * 1000;
const VENTANA_LOGIN_MS = 15 * 60 * 1000;
const INTENTOS_LOGIN = 5;

function enteroPositivo(texto) {
  if (typeof texto !== "string" || !/^[1-9][0-9]{0,15}$/.test(texto)) {
    return null;
  }
  const valor = Number(texto);
  return Number.isSafeInteger(valor) ? valor : null;
}

function tokenAdminDeCookie(req) {
  const encabezado = req.headers.cookie;
  if (typeof encabezado !== "string" || encabezado.length > 4096) return "";
  for (const componente of encabezado.split(";")) {
    const texto = componente.trim();
    if (texto.startsWith(COOKIE_ADMIN + "=")) {
      const token = texto.slice(COOKIE_ADMIN.length + 1);
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
    }
  }
  return "";
}

function tokenCompraDeCabecera(req) {
  const encabezado = req.headers.authorization;
  if (typeof encabezado !== "string") return "";
  const coincidencia = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(encabezado);
  return coincidencia ? coincidencia[1] : "";
}

function validarOrigenConfigurado(origen) {
  if (typeof origen !== "string") throw new TypeError("Origen obligatorio");
  const uri = new URL(origen);
  if (!["http:", "https:"].includes(uri.protocol) ||
      uri.origin !== origen || uri.username || uri.password) {
    throw new TypeError("Origen publico invalido");
  }
  // HTTP solo se permite en pruebas sobre loopback.
  if (uri.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)) {
    throw new TypeError("HTTP solamente permitido en localhost");
  }
  return origen;
}

function crearRouterV3({ acceso, compras, conciliador, catalogo = null, sesionesComprador = null, bandejaWhatsApp = null, aplicadorWhatsApp = null, reposicionInventario = null, origen, reloj = Date.now }) {
  const requerido = [
    [acceso, ["iniciarSesionAdmin", "autorizarAdmin", "cerrarSesionAdmin",
      "emitirPermisoCompra", "autorizarCompra"]],
    [compras, ["crearCompra", "obtenerCompra", "cambiarEstadoItem", "finalizarCompra"]],
    [conciliador, ["informeCompraFinalizada"]],
  ];
  if (requerido.some(([objeto, nombres]) =>
    !objeto || nombres.some((nombre) => typeof objeto[nombre] !== "function"))) {
    throw new TypeError("Dependencias V3 incompletas");
  }
  if (sesionesComprador && ["canjearInvitacion", "autorizarSesion", "revocarSesion"].some(
    (nombre) => typeof sesionesComprador[nombre] !== "function")) {
    throw new TypeError("Servicio de sesiones de comprador incompleto");
  }
  if (catalogo && ["listarProductos", "agregarProducto", "editarProducto", "cambiarNecesidad"].some(
    (nombre) => typeof catalogo[nombre] !== "function")) {
    throw new TypeError("Servicio de catalogo incompleto");
  }
  if (bandejaWhatsApp && ["listarPorCompra", "revisar"].some(
    nombre => typeof bandejaWhatsApp[nombre] !== "function")) {
    throw new TypeError("Bandeja WhatsApp incompleta");
  }
  if (aplicadorWhatsApp && ["aplicar", "listarPorCompra"].some(n =>
    typeof aplicadorWhatsApp[n] !== "function")) {
    throw new TypeError("Aplicador WhatsApp incompleto");
  }
  if (reposicionInventario && ["preparar","aplicar"].some(n =>
    typeof reposicionInventario[n] !== "function")) {
    throw new TypeError("Servicio de reposicion incompleto");
  }
  validarOrigenConfigurado(origen);
  if (typeof reloj !== "function") throw new TypeError("Reloj invalido");

  const router = express.Router();
  const intentosFallidos = new Map();

  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    // Ni un POST/PATCH administrativo ni una mutacion de comprador se acepta
    // de un origen distinto (tambien se rechaza Origin ausente).
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.get("origin") !== origen) {
      return res.status(403).json({ error: "ORIGEN_NO_AUTORIZADO" });
    }
    next();
  });

  router.use(express.json({ limit: "8kb", strict: true }));

  async function ejecutar(req, res, siguiente) {
    try {
      await siguiente();
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ error: "DATOS_INVALIDOS" });
      }
      const codigo = error && error.message;
      const estados = {
        COMPRA_NO_ENCONTRADA: 404,
        ITEM_NO_ENCONTRADO: 404,
        COMPRA_NO_ENCONTRADA_O_SIN_ITEMS: 404,
        COMPRA_NO_FINALIZADA: 409,
        V3_REPOSICION_COMPRA_INEXISTENTE: 404,
        V3_REPOSICION_COMPRA_NO_FINALIZADA: 409,
        V3_REPOSICION_DESACTUALIZADA: 409,
        V3_REPOSICION_CONFLICTO_ATOMICO: 409,
        V3_REPOSICION_CONFIRMACION_REQUERIDA: 400,
        V3_REPOSICION_HUELLA_INVALIDA: 400,
        COMPRA_CERRADA: 409,
        CONFLICTO_VERSION: 409,
        PRODUCTO_NO_MARCADO_COMO_FALTANTE: 409,
        PRODUCTO_INEXISTENTE: 400,
        PRODUCTO_DUPLICADO: 409,
        CONFLICTO_ESTADO_PRODUCTO: 409,
        WA_PROPUESTA_AJENA: 409,
        WA_PROPUESTA_NO_APLICABLE: 409,
        WA_PROPUESTA_INEXISTENTE: 404,
      };
      if (Object.hasOwn(estados, codigo)) {
        return res.status(estados[codigo]).json({ error: codigo });
      }
      // No exponer excepciones SQL, datos personales ni trazas.
      return res.status(500).json({ error: "ERROR_INTERNO" });
    }
  }

  async function exigirAdmin(req, res, next) {
    try {
      if (!await acceso.autorizarAdmin({ token: tokenAdminDeCookie(req) })) {
        return res.status(401).json({ error: "ADMIN_NO_AUTORIZADO" });
      }
      next();
    } catch (_) {
      return res.status(503).json({ error: "AUTORIZACION_NO_DISPONIBLE" });
    }
  }

  function cookieComprador(req, compraId) {
    const nombre = "hs_buyer_v3_" + compraId + "=";
    const cadena = req.headers.cookie || "";
    if (typeof cadena !== "string" || cadena.length > 4096) return "";
    const entrada = cadena.split(";").map((x) => x.trim()).find((x) => x.startsWith(nombre));
    const token = entrada ? entrada.slice(nombre.length) : "";
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
  }

  async function exigirComprador(req, res, next) {
    const compraId = enteroPositivo(req.params.compraId);
    if (compraId === null) {
      return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
    }
    try {
      const autorizado = sesionesComprador
        ? await sesionesComprador.autorizarSesion({
          compraId, sesion: cookieComprador(req, compraId),
        })
        : await acceso.autorizarCompra({
          compraId, token: tokenCompraDeCabecera(req),
        });
      if (!autorizado) {
        return res.status(403).json({ error: "COMPRA_NO_AUTORIZADA" });
      }
      req.compraV3Id = compraId;
      next();
    } catch (_) {
      return res.status(503).json({ error: "AUTORIZACION_NO_DISPONIBLE" });
    }
  }

  function bloqueoLogin(req, res, next) {
    const ahora = reloj();
    if (!Number.isSafeInteger(ahora) || ahora < 0) {
      return res.status(503).json({ error: "RELOJ_NO_DISPONIBLE" });
    }
    // Limitador local de demostracion. No sirve como limitacion distribuida
    // en produccion y requiere identidad de origen fiable y un almacen comun.
    const ip = req.socket.remoteAddress || "desconocida";
    let registro = intentosFallidos.get(ip);
    if (registro && registro.hasta <= ahora) {
      intentosFallidos.delete(ip);
      registro = null;
    }
    if (registro && registro.conteo >= INTENTOS_LOGIN) {
      res.set("Retry-After", String(Math.max(1,
        Math.ceil((registro.hasta - ahora) / 1000))));
      return res.status(429).json({ error: "DEMASIADOS_INTENTOS" });
    }
    req.limiteLoginIp = ip;
    next();
  }

  function anotarFalloLogin(ip) {
    const ahora = reloj();
    const actual = intentosFallidos.get(ip);
    const registro = actual && actual.hasta > ahora
      ? { conteo: actual.conteo + 1, hasta: actual.hasta }
      : { conteo: 1, hasta: ahora + VENTANA_LOGIN_MS };
    if (intentosFallidos.size >= 1000 && !intentosFallidos.has(ip)) {
      intentosFallidos.delete(intentosFallidos.keys().next().value);
    }
    intentosFallidos.set(ip, registro);
  }

  router.post("/auth/login", bloqueoLogin, (req, res) => ejecutar(req, res, async () => {
    if (!req.body || typeof req.body.contrasena !== "string") {
      return res.status(400).json({ error: "DATOS_INVALIDOS" });
    }
    const sesion = await acceso.iniciarSesionAdmin({
      contrasena: req.body.contrasena, ttlMs: TTL_ADMIN_MS,
    });
    if (!sesion) {
      anotarFalloLogin(req.limiteLoginIp);
      return res.status(401).json({ error: "ACCESO_DENEGADO" });
    }
    intentosFallidos.delete(req.limiteLoginIp);
    res.cookie(COOKIE_ADMIN, sesion.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/api/v3",
      maxAge: TTL_ADMIN_MS,
    });
    return res.status(200).json({ ok: true, expira: sesion.expira });
  }));

  router.post("/auth/logout", exigirAdmin, (req, res) =>
    ejecutar(req, res, async () => {
      await acceso.cerrarSesionAdmin({ token: tokenAdminDeCookie(req) });
      res.clearCookie(COOKIE_ADMIN, {
        httpOnly: true, secure: true, sameSite: "strict", path: "/api/v3",
      });
      return res.status(200).json({ ok: true });
    })
  );

  router.get("/admin/sesion", exigirAdmin, (_req, res) =>
    res.json({ autenticado: true })
  );

  if(typeof acceso.cambiarContrasenaAdmin==="function"){
    router.post("/admin/contrasena", exigirAdmin, (req,res)=>
      ejecutar(req,res,async()=>{
        if(!req.body || typeof req.body.actual!=="string" ||
           typeof req.body.nueva!=="string") {
          return res.status(400).json({error:"DATOS_INVALIDOS"});
        }
        const resultado=await acceso.cambiarContrasenaAdmin({
          token:tokenAdminDeCookie(req),contrasenaActual:req.body.actual,
          contrasenaNueva:req.body.nueva,
        });
        if(resultado.estado==="contrasena_incorrecta"){
          return res.status(403).json({error:"CONTRASENA_ACTUAL_INCORRECTA"});
        }
        if(resultado.estado==="contrasena_reutilizada"){
          return res.status(409).json({error:"CONTRASENA_REUTILIZADA"});
        }
        if(resultado.estado!=="cambiada"){
          return res.status(401).json({error:"ADMIN_NO_AUTORIZADO"});
        }
        res.clearCookie(COOKIE_ADMIN,{
          httpOnly:true,secure:true,sameSite:"strict",path:"/api/v3",
        });
        return res.json({ok:true,sesionesInvalidadas:true});
      })
    );
  }

  if (catalogo) {
    router.get("/admin/productos", exigirAdmin, (_req, res) =>
      ejecutar(_req, res, async () => {
        const productos = await catalogo.listarProductos();
        return res.json({ productos });
      })
    );
    router.post("/admin/productos", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const producto = await catalogo.agregarProducto({
          nombre: req.body?.nombre, categoria: req.body?.categoria,
        });
        return res.status(201).json({ producto });
      })
    );
    router.put("/admin/productos/:productoId", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const productoId = enteroPositivo(req.params.productoId);
        if (productoId === null) return res.status(400).json({ error: "ID_PRODUCTO_INVALIDO" });
        const producto = await catalogo.editarProducto({
          productoId, nombre: req.body?.nombre, categoria: req.body?.categoria,
        });
        return res.json({ producto });
      })
    );
    router.patch("/admin/productos/:productoId/necesidad", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const productoId = enteroPositivo(req.params.productoId);
        if (productoId === null) return res.status(400).json({ error: "ID_PRODUCTO_INVALIDO" });
        const producto = await catalogo.cambiarNecesidad({
          productoId,
          agotado: req.body?.agotado,
          agotadoEsperado: req.body?.agotadoEsperado,
        });
        return res.json({ producto });
      })
    );
  }

  if (typeof compras.listarCompras === "function") {
    router.get("/admin/compras", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const comprasListado = await compras.listarCompras({ limite: 40 });
        return res.json({ compras: comprasListado });
      })
    );
  }

  router.post("/admin/compras", exigirAdmin, (req, res) =>
    ejecutar(req, res, async () => {
      const resultado = await compras.crearCompra({ lineas: req.body?.lineas });
      // Deliberadamente NO se crea invitacion en esta operacion. Si la emision
      // falla despues de crear la compra, es reintentable por separado.
      return res.status(201).json({ compra: resultado });
    })
  );

  if (bandejaWhatsApp) {
    router.get("/admin/compras/:compraId/respuestas", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const compraId = enteroPositivo(req.params.compraId);
        if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
        const compra = await compras.obtenerCompra({ compraId });
        if (!compra) return res.status(404).json({ error: "COMPRA_NO_ENCONTRADA" });
        return res.json({ respuestas: await bandejaWhatsApp.listarPorCompra({ compraId, limite: 50 }) });
      })
    );
    router.post("/admin/compras/:compraId/respuestas/:respuestaId/revisar", exigirAdmin,
      (req, res) => ejecutar(req, res, async () => {
        const compraId = enteroPositivo(req.params.compraId);
        if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
        if (!req.body || !["revisada", "descartada"].includes(req.body.decision)) {
          return res.status(400).json({ error: "DECISION_INVALIDA" });
        }
        const resultado = await bandejaWhatsApp.revisar({
          compraId, id: req.params.respuestaId, decision: req.body.decision,
        });
        if (!resultado.actualizado) return res.status(409).json({ error: "RESPUESTA_NO_PENDIENTE_O_AJENA" });
        return res.json({ actualizado: true, aplicadaAlInventario: false });
      })
    );
  }

  if (aplicadorWhatsApp) {
    router.get("/admin/compras/:compraId/aplicaciones", exigirAdmin, (req, res) =>
      ejecutar(req, res, async () => {
        const compraId = enteroPositivo(req.params.compraId);
        if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
        const compra = await compras.obtenerCompra({ compraId });
        if (!compra) return res.status(404).json({ error: "COMPRA_NO_ENCONTRADA" });
        return res.json({ aplicaciones: await aplicadorWhatsApp.listarPorCompra({ compraId }) });
      })
    );
    router.post("/admin/compras/:compraId/respuestas/:respuestaId/aplicar", exigirAdmin,
      (req, res) => ejecutar(req, res, async () => {
        const compraId = enteroPositivo(req.params.compraId);
        if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
        if (!req.body || !Number.isSafeInteger(req.body.revisionEsperada) || req.body.revisionEsperada < 0 || req.body.confirmacion !== true) {
          return res.status(400).json({ error: "CONFIRMACION_O_REVISION_INVALIDA" });
        }
        const resultado = await aplicadorWhatsApp.aplicar({ compraId,
          respuestaId: req.params.respuestaId,
          revisionEsperada: req.body.revisionEsperada,
        });
        return res.json({ aplicacion: resultado, inventarioGlobalModificado: false });
      })
    );
  }

  router.get("/admin/compras/:compraId", exigirAdmin, (req, res) =>
    ejecutar(req, res, async () => {
      const compraId = enteroPositivo(req.params.compraId);
      if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
      const compra = await compras.obtenerCompra({ compraId });
      if (!compra) return res.status(404).json({ error: "COMPRA_NO_ENCONTRADA" });
      return res.json({ compra });
    })
  );

  router.post("/admin/compras/:compraId/invitaciones", exigirAdmin, (req, res) =>
    ejecutar(req, res, async () => {
      const compraId = enteroPositivo(req.params.compraId);
      if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
      const compra = await compras.obtenerCompra({ compraId });
      if (!compra) return res.status(404).json({ error: "COMPRA_NO_ENCONTRADA" });
      if (compra.estado !== "abierta") {
        return res.status(409).json({ error: "COMPRA_CERRADA" });
      }
      const invitacion = await acceso.emitirPermisoCompra({
        compraId, ttlMs: TTL_COMPRA_MS,
      });
      // El token solo se entrega en esta respuesta administrativa, y su
      // huella es lo unico que queda guardado en la base.
      return res.status(201).json({ invitacion });
    })
  );

  if(sesionesComprador && typeof sesionesComprador.revocarAccesosCompra==="function"){
    router.post("/admin/compras/:compraId/revocar-accesos",exigirAdmin,
      (req,res)=>ejecutar(req,res,async()=>{
        const compraId=enteroPositivo(req.params.compraId);
        if(compraId===null)return res.status(400).json({error:"ID_COMPRA_INVALIDO"});
        if(req.body?.confirmacion!==true)
          return res.status(400).json({error:"CONFIRMACION_REQUERIDA"});
        const resultado=await sesionesComprador.revocarAccesosCompra({compraId});
        return res.json({ok:true,...resultado});
      })
    );
  }

  router.get("/admin/compras/:compraId/conciliacion", exigirAdmin, (req, res) =>
    ejecutar(req, res, async () => {
      const compraId = enteroPositivo(req.params.compraId);
      if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
      const informe = await conciliador.informeCompraFinalizada({ compraId });
      return res.json({ informe });
    })
  );

  // Integracion OPCIONAL y solo con servicio de ensayo inyectado.
  // No se monta en V2 ni en el arranque V3 actual.
  if (reposicionInventario) {
    router.get("/admin/compras/:compraId/reposicion", exigirAdmin,
      (req,res)=>ejecutar(req,res,async()=>{
        const compraId=enteroPositivo(req.params.compraId);
        if (compraId===null) return res.status(400).json({error:"ID_COMPRA_INVALIDO"});
        const informe=await reposicionInventario.preparar({compraId});
        return res.json({informe});
      })
    );
    router.post("/admin/compras/:compraId/reposicion/aplicar", exigirAdmin,
      (req,res)=>ejecutar(req,res,async()=>{
        const compraId=enteroPositivo(req.params.compraId);
        if (compraId===null) return res.status(400).json({error:"ID_COMPRA_INVALIDO"});
        if (req.body?.confirmacion!==true) {
          return res.status(400).json({error:"CONFIRMACION_REQUERIDA"});
        }
        const r=await reposicionInventario.aplicar({
          compraId,confirmacion:true,huellaEsperada:req.body?.huellaEsperada,
        });
        return res.json({ok:true,resultado:r});
      })
    );
  }

  if (sesionesComprador) {
    router.post("/compras/:compraId/activar", (req, res) =>
      ejecutar(req, res, async () => {
        const compraId = enteroPositivo(req.params.compraId);
        if (compraId === null) return res.status(400).json({ error: "ID_COMPRA_INVALIDO" });
        if (!req.body || typeof req.body.invitacion !== "string") {
          return res.status(400).json({ error: "DATOS_INVALIDOS" });
        }
        let resultado;
        try {
          resultado = await sesionesComprador.canjearInvitacion({
            compraId, invitacion: req.body.invitacion,
          });
        } catch (error) {
          if (error && error.message === "INVITACION_INVALIDA") {
            return res.status(403).json({ error: "INVITACION_INVALIDA" });
          }
          throw error;
        }
        res.cookie("hs_buyer_v3_" + compraId, resultado.sesion, {
          httpOnly: true, secure: true, sameSite: "strict",
          path: "/api/v3/compras/" + compraId,
          maxAge: Math.max(1, resultado.expira - reloj()),
        });
        return res.json({ ok: true, compraId, expira: resultado.expira });
      })
    );

    router.post("/compras/:compraId/salir", exigirComprador, (req, res) =>
      ejecutar(req, res, async () => {
        const id = req.compraV3Id;
        await sesionesComprador.revocarSesion({
          compraId: id, sesion: cookieComprador(req, id),
        });
        res.clearCookie("hs_buyer_v3_" + id, {
          httpOnly: true, secure: true, sameSite: "strict",
          path: "/api/v3/compras/" + id,
        });
        return res.json({ ok: true });
      })
    );
  }

  router.get("/compras/:compraId", exigirComprador, (req, res) =>
    ejecutar(req, res, async () => {
      const compra = await compras.obtenerCompra({ compraId: req.compraV3Id });
      if (!compra) return res.status(404).json({ error: "COMPRA_NO_ENCONTRADA" });
      return res.json({ compra });
    })
  );

  router.patch("/compras/:compraId/items/:itemId", exigirComprador, (req, res) =>
    ejecutar(req, res, async () => {
      const itemId = enteroPositivo(req.params.itemId);
      if (itemId === null) return res.status(400).json({ error: "ID_ITEM_INVALIDO" });
      const resultado = await compras.cambiarEstadoItem({
        compraId: req.compraV3Id,
        itemId,
        estado: req.body?.estado,
        revisionEsperada: req.body?.revisionEsperada,
      });
      return res.json({ resultado });
    })
  );

  router.post("/compras/:compraId/finalizar", exigirComprador, (req, res) =>
    ejecutar(req, res, async () => {
      const resultado = await compras.finalizarCompra({ compraId: req.compraV3Id });
      return res.json({ resultado });
    })
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "RUTA_NO_ENCONTRADA" });
  });

  router.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = (error && (error.status === 413 || error.status === 400))
      ? error.status : 400;
    res.status(status).json({ error: "CUERPO_INVALIDO" });
  });

  return router;
}

module.exports = { crearRouterV3 };
