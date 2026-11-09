'use strict';
// Exclusión cooperativa de un único escritor Baileys.
// No protege frente a instancias legacy que desconozcan este protocolo.
const crypto = require('node:crypto');
const TABLE = 'hs_v2_wa_lease';
function crearLeaseWa({db, propietario=crypto.randomUUID(), reloj=Date.now, ttlMs=45000}={}) {
  if(!db || typeof db.execute!=='function' || typeof propietario!=='string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(propietario) || typeof reloj!=='function' ||
    !Number.isSafeInteger(ttlMs) || ttlMs<15000 || ttlMs>300000)
    throw Error('HS_WA_LEASE_CONFIG_INVALIDA');
  let token=null, inicializado=false;
  async function init(){
    if(inicializado)return;
    const cols=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",args:[TABLE]});
    if(cols.rows.length){
      try {await db.execute(`SELECT slot,owner,generation,hasta FROM ${TABLE} LIMIT 0`);}
      catch (_) {throw Error('HS_WA_LEASE_ESQUEMA_INCOMPATIBLE');}
    }
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT NOT NULL, generation INTEGER NOT NULL, hasta INTEGER NOT NULL)`);
    inicializado=true;
  }
  function vigente(){if(token===null)throw Error('HS_WA_LEASE_NO_ADQUIRIDO');}
  function condicion(){
    vigente();
    return {sql:`EXISTS(SELECT 1 FROM ${TABLE} WHERE slot=1 AND owner=? AND generation=? AND hasta>?)`,
      args:[propietario,token,reloj()]};
  }
  async function adquirir(){
    await init();
    if(token!==null)throw Error('HS_WA_LEASE_YA_ADQUIRIDO');
    const ahora=reloj();
    const r=await db.execute({sql:`INSERT INTO ${TABLE}(slot,owner,generation,hasta) VALUES(1,?,1,?) `+
      `ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner,generation=${TABLE}.generation+1,hasta=excluded.hasta `+
      `WHERE ${TABLE}.hasta<? RETURNING generation`,
      args:[propietario,ahora+ttlMs,ahora]});
    if(!r.rows.length)throw Error('HS_WA_LEASE_EN_USO');
    token=Number(r.rows[0].generation);
    if(!Number.isSafeInteger(token)||token<1)throw Error('HS_WA_LEASE_GENERACION_INVALIDA');
    return token;
  }
  async function verificar(){
    const c=condicion();
    const r=await db.execute({sql:`SELECT generation FROM ${TABLE} WHERE ${c.sql} LIMIT 1`,args:c.args});
    if(!r.rows.length)throw Error('HS_WA_LEASE_PERDIDO');
    return true;
  }
  async function renovar(){
    vigente();const ahora=reloj();
    const r=await db.execute({sql:`UPDATE ${TABLE} SET hasta=? WHERE slot=1 AND owner=? AND generation=? AND hasta>? RETURNING generation`,
      args:[ahora+ttlMs,propietario,token,ahora]});
    if(!r.rows.length)throw Error('HS_WA_LEASE_PERDIDO');
    return true;
  }
  async function liberar(){
    if(token===null)return;
    const previo=token;
    await db.execute({sql:`UPDATE ${TABLE} SET hasta=0 WHERE slot=1 AND owner=? AND generation=?`,args:[propietario,previo]});
    token=null;
  }
  return Object.freeze({adquirir,renovar,verificar,liberar,condicion});
}
module.exports={crearLeaseWa};
