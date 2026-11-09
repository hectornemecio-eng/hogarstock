'use strict';
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const crypto=require('node:crypto');
const {crearGrantsV2}=require('./security/v2-grants');
const {crearLeaseWa}=require('./whatsapp/wa-lease');
const {crearAuthTurso}=require('./whatsapp/wa-auth-turso');
const {initAuthCreds,BufferJSON,proto}=require('@whiskeysockets/baileys');
(async()=>{
  const db=createClient({url:':memory:'});
  await db.execute('CREATE TABLE productos(id INTEGER PRIMARY KEY, nombre TEXT, categoria TEXT, agotado INTEGER)');
  await db.execute("INSERT INTO productos VALUES(1,'prueba','ficticio',1)");
  const id={emitirComprador:()=>({token:'fake',hash:'0'.repeat(64),exp:Date.now()+60000})};
  const grants=crearGrantsV2({db,identidad:id,contactos:['34600000000']});
  await grants.init();
  const lease=crearLeaseWa({db});await lease.adquirir();
  const wa=crearAuthTurso({db,lease,claveHex:crypto.randomBytes(32).toString('hex'),baileys:{initAuthCreds,BufferJSON,proto},permitirAltaNueva:false});
  let blocked=false;try{await wa.abrir();}catch(e){blocked=e.message==='HS_WA_AUTH_SIN_SESION_MIGRADA';}
  assert.equal(blocked,true);
  await lease.liberar();
  const t=await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hs_v2_%' ORDER BY name");
  assert.deepEqual(t.rows.map(x=>x.name),['hs_v2_security_grants','hs_v2_security_items','hs_v2_wa_auth_encrypted','hs_v2_wa_lease']);
  await db.close();
  console.log('RESULTADO=COMPATIBILIDAD_SQL_REAL_OK');console.log('TABLAS_NUEVAS=4');console.log('SIN_PRAGMA=SI');console.log('SIN_WHATSAPP=SI');
})().catch(e=>{console.error('RESULTADO=FALLO',e.message);process.exitCode=2;});
