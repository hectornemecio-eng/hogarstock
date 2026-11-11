"use strict";
// Almacén autenticación Baileys para SQLite/libSQL.
// Sesión cifrada de producción. Los diagnósticos no contienen claves ni datos personales.
const crypto = require("node:crypto");
const TABLE = "hs_v2_wa_auth_encrypted";
const MAX_KEY_ID = 512;
const MAX_RECORD_BYTES = 1024 * 1024;
// Baileys v7.0.0-rc12 genera 812 pre-keys cuando el servidor tiene 0.
// Mantener el lote completo y transaccional (sin particiones parcialmente confirmadas).
// 900 permite el lote inicial y deja un margen limitado; no es un límite sin control.
const MAX_BATCH = 900;

function crearAuthTurso({db, claveHex, baileys, reloj = Date.now,
  permitirAltaNueva = false, lease = null, monitor = null} = {}) {
  if (!db || typeof db.execute !== "function" || typeof db.batch !== "function" ||
      !baileys || typeof baileys.initAuthCreds !== "function" ||
      typeof baileys.BufferJSON?.replacer !== "function" ||
      typeof baileys.BufferJSON?.reviver !== "function" ||
      !/^[a-f0-9]{64}$/i.test(String(claveHex || "")) ||
      typeof reloj !== "function" || typeof permitirAltaNueva !== "boolean" ||
      (lease !== null && (typeof lease.verificar !== "function" || typeof lease.condicion !== "function")) ||
      (monitor !== null && (typeof monitor.registrarError !== "function" ||
        typeof monitor.registrarExito !== "function"))) {
    throw Error("HS_WA_AUTH_CONFIG_INVALIDA");
  }
  const llave = Buffer.from(claveHex, "hex");
  const reviver = baileys.BufferJSON.reviver;
  const replacer = baileys.BufferJSON.replacer;
  function registrarFallo(etapa,error){
    try{monitor?.registrarError(etapa,error);}catch(_){}
  }
  function registrarExito(etapa){
    try{monitor?.registrarExito(etapa);}catch(_){}
  }
  function validarId(id) {
    if (typeof id !== "string" || !id || id.length > MAX_KEY_ID || /[\r\n\x00]/.test(id))
      throw Error("HS_WA_AUTH_ID_INVALIDO");
    return id;
  }
  function serializar(value) {
    const json = JSON.stringify(value, replacer);
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES)
      throw Error("HS_WA_AUTH_REGISTRO_INVALIDO");
    return Buffer.from(json, "utf8");
  }
  function cifrar(id, value) {
    validarId(id);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", llave, iv);
    c.setAAD(Buffer.from(id, "utf8"));
    const encrypted = Buffer.concat([c.update(serializar(value)), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"),
      encrypted.toString("base64url")].join(".");
  }
  function descifrar(id, payload) {
    validarId(id);
    try {
      if (typeof payload !== "string" || payload.length > MAX_RECORD_BYTES * 2) throw Error();
      const parts = payload.split(".");
      if (parts.length !== 4 || parts[0] !== "v1" ||
          !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
          !/^[A-Za-z0-9_-]+$/.test(parts[2]) ||
          !/^[A-Za-z0-9_-]*$/.test(parts[3])) throw Error();
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw Error();
      const dec = crypto.createDecipheriv("aes-256-gcm", llave, iv);
      dec.setAAD(Buffer.from(id, "utf8"));
      dec.setAuthTag(tag);
      const json = Buffer.concat([dec.update(Buffer.from(parts[3], "base64url")), dec.final()]);
      if (json.length > MAX_RECORD_BYTES) throw Error();
      return JSON.parse(json.toString("utf8"), reviver);
    } catch (_) {
      // No devolver fragmentos de credenciales ni errores internos del cifrador.
      throw Error("HS_WA_AUTH_CIFRADO_INVALIDO_O_CLAVE_INCORRECTA");
    }
  }
  let initialized = false;
  async function verificarLease() {if (lease) await lease.verificar();}
  // Cualquier escritura con lease va protegida dentro de la propia SQL.
  // No basta comprobar el propietario con SELECT antes de escribir.
  function guardarSql(id, encrypted, instante) {
    if (!lease) return {sql:`INSERT INTO ${TABLE} (id,payload,actualizado) VALUES(?,?,?) `+
      "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, actualizado=excluded.actualizado",
      args:[id,encrypted,instante]};
    const c=lease.condicion();
    return {sql:`INSERT INTO ${TABLE} (id,payload,actualizado) SELECT ?,?,? WHERE ${c.sql} `+
      "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, actualizado=excluded.actualizado",
      args:[id,encrypted,instante,...c.args]};
  }
  async function init() {
    const schema = await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",args:[TABLE]});
    if (schema.rows.length) {
      try {await db.execute(`SELECT id,payload,actualizado FROM ${TABLE} LIMIT 0`);}
      catch (_) {throw Error("HS_WA_AUTH_ESQUEMA_INCOMPATIBLE");}
    }
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (`+
      "id TEXT PRIMARY KEY, payload TEXT NOT NULL, actualizado INTEGER NOT NULL)");
    initialized = true;
  }
  function assertInit() {if (!initialized) throw Error("HS_WA_AUTH_NO_INICIALIZADO");}
  async function readRecord(id) {
    try {
      assertInit();
      await verificarLease();
      const result = await db.execute({
        sql: `SELECT payload FROM ${TABLE} WHERE id=? LIMIT 1`, args: [validarId(id)]
      });
      const valor=result.rows.length?descifrar(id,String(result.rows[0].payload)):null;
      registrarExito("lectura");
      return valor;
    }catch(error){registrarFallo("lectura",error);throw error;}
  }
  async function saveRecord(id, value) {
    try {
      assertInit();
      const encrypted = cifrar(id, value);
      await verificarLease();
      const respuesta = await db.execute(guardarSql(id, encrypted, reloj()));
      if (lease && Number(respuesta.rowsAffected) !== 1) throw Error("HS_WA_LEASE_PERDIDO");
      registrarExito("credenciales");
      return respuesta;
    }catch(error){registrarFallo("credenciales",error);throw error;}
  }
  async function abrir() {
    await verificarLease();
    await init();
    const initial = await readRecord("creds");
    let creds;
    if (initial === null) {
      const orphans = await db.execute(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE id <> 'creds'`);
      if (Number(orphans.rows[0].n) > 0) throw Error("HS_WA_AUTH_PARCIAL_SIN_CREDENCIALES");
      // Nunca crear una identidad WhatsApp nueva durante un arranque normal.
      // La migración o el alta requieren una autorización independiente.
      if (!permitirAltaNueva) throw Error("HS_WA_AUTH_SIN_SESION_MIGRADA");
      creds = baileys.initAuthCreds();
      await saveRecord("creds", creds);
    } else {
      creds = initial;
    }
    const state = {
      creds,
      keys: {
        async get(type, ids) {
          try {
            assertInit();
            await verificarLease();
            if (typeof type !== "string" || !Array.isArray(ids) || ids.length > MAX_BATCH)
              throw Error("HS_WA_AUTH_GET_INVALIDO");
            const result = {};
            if (!ids.length) return result;
            const keys = ids.map(id => validarId(type + ":" + id));
            const sql = `SELECT id,payload FROM ${TABLE} WHERE id IN (`+
              keys.map(() => "?").join(",")+")";
            const r = await db.execute({sql,args:keys});
            for (const row of r.rows) {
              const id = String(row.id);
              const value = descifrar(id, String(row.payload));
              const name = id.slice(type.length + 1);
              result[name] = type === "app-state-sync-key" &&
                baileys.proto?.Message?.AppStateSyncKeyData?.fromObject
                ? baileys.proto.Message.AppStateSyncKeyData.fromObject(value)
                : value;
            }
            registrarExito("lectura");
            return result;
          }catch(error){registrarFallo("lectura",error);throw error;}
        },
        async set(data) {
          try {
          assertInit();
          await verificarLease();
          if (!data || typeof data !== "object") throw Error("HS_WA_AUTH_SET_INVALIDO");
          const statements = [];
          for (const [type, group] of Object.entries(data)) {
            if (!group || typeof group !== "object") throw Error("HS_WA_AUTH_SET_INVALIDO");
            for (const [entry, value] of Object.entries(group)) {
              if (statements.length >= MAX_BATCH) throw Error("HS_WA_AUTH_LOTE_EXCESIVO");
              const id = validarId(type + ":" + entry);
              if (value === null || value === undefined) {
                const c=lease ? lease.condicion() : null;
                statements.push(c ? {sql:`DELETE FROM ${TABLE} WHERE id=? AND ${c.sql}`,args:[id,...c.args]} :
                  {sql:`DELETE FROM ${TABLE} WHERE id=?`,args:[id]});
              } else {
                statements.push(guardarSql(id,cifrar(id,value),reloj()));
              }
            }
          }
          if (statements.length) {
            const resultados = await db.batch(statements, "write");
            // En un lote solo de DELETE sobre filas inexistentes, 0 cambios
            // es legítimo; aun así comprobamos el lease al finalizar.
            if (lease) await verificarLease();
            // Las inserciones/upserts exigen una fila afectada: fallo cerrado.
            if (lease && (!Array.isArray(resultados) || resultados.length !== statements.length ||
              resultados.some((r,i)=>statements[i].sql.startsWith("INSERT") && Number(r.rowsAffected)!==1)))
              throw Error("HS_WA_LEASE_PERDIDO");
            registrarExito("escritura");
          }
          }catch(error){registrarFallo("escritura",error);throw error;}
        }
      }
    };
    async function saveCreds() {await saveRecord("creds", state.creds);}
    return Object.freeze({state, saveCreds});
  }
  return Object.freeze({abrir});
}
module.exports = {crearAuthTurso};
