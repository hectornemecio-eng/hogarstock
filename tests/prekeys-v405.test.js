"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto"),os=require("node:os"),path=require("node:path"),fs=require("node:fs");
const {createClient}=require("@libsql/client");
const {crearAuthTurso}=require("../whatsapp/wa-auth-turso");

// 812 coincide con INITIAL_PREKEY_COUNT en la versión Baileys 7.0.0-rc12.
test("v4.05: guardar y recuperar 812 pre-keys cifradas en una transacción",async()=>{
  const file=path.join(os.tmpdir(),"hs-prekey-v405-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    const fake={initAuthCreds:()=>({ficticio:true}),
      BufferJSON:{replacer:(_k,v)=>v,reviver:(_k,v)=>v}};
    const lease={
      verificar:async()=>true,
      condicion:()=>({sql:"1=1",args:[]})
    };
    const {state}=await crearAuthTurso({db,claveHex:"f".repeat(64),
      baileys:fake,permitirAltaNueva:true,lease}).abrir();
    const entries=Array.from({length:812},(_,i)=>[String(i+1),{
      public:"clave-publica-ficticia-"+i,
      private:"clave-privada-ficticia-"+i
    }]);
    await state.keys.set({"pre-key":Object.fromEntries(entries)});
    const ids=entries.map(x=>x[0]);
    const result=await state.keys.get("pre-key",ids);
    assert.equal(Object.keys(result).length,812);
    assert.equal(result["1"].public,"clave-publica-ficticia-0");
    assert.equal(result["812"].private,"clave-privada-ficticia-811");
    const count=await db.execute("SELECT COUNT(*) AS n FROM hs_v2_wa_auth_encrypted WHERE id LIKE 'pre-key:%'");
    assert.equal(Number(count.rows[0].n),812);
    // La consulta con 812 parámetros también tiene que funcionar, no solo el guardado.
  }finally{
    db.close();
    for(const p of [file,file+"-wal",file+"-shm"]){try{fs.unlinkSync(p)}catch(_){}}
  }
});
test("v4.05: lotes desmesurados siguen bloqueados antes de escribir",async()=>{
  const file=path.join(os.tmpdir(),"hs-limit-v405-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".sqlite");
  const db=createClient({url:"file:"+file});
  try{
    const fake={initAuthCreds:()=>({ficticio:true}),
      BufferJSON:{replacer:(_k,v)=>v,reviver:(_k,v)=>v}};
    const {state}=await crearAuthTurso({db,claveHex:"e".repeat(64),
      baileys:fake,permitirAltaNueva:true}).abrir();
    const tooMany=Object.fromEntries(
      Array.from({length:901},(_,i)=>[String(i+1),{data:"FICTICIO"}])
    );
    await assert.rejects(state.keys.set({"pre-key":tooMany}),/HS_WA_AUTH_LOTE_EXCESIVO/);
    await assert.rejects(state.keys.get("pre-key",Object.keys(tooMany)),/HS_WA_AUTH_GET_INVALIDO/);
    const count=await db.execute("SELECT COUNT(*) AS n FROM hs_v2_wa_auth_encrypted WHERE id LIKE 'pre-key:%'");
    assert.equal(Number(count.rows[0].n),0);
  }finally{
    db.close();
    for(const p of [file,file+"-wal",file+"-shm"]){try{fs.unlinkSync(p)}catch(_){}}
  }
});
