"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {crearMonitorPersistenciaWa}=require("../whatsapp/wa-persistence-monitor");
const {crearAuthTurso}=require("../whatsapp/wa-auth-turso");

test("v4.05: el monitor clasifica etapas y códigos sin filtrar secretos",()=>{
  let t=1700000000000;
  const m=crearMonitorPersistenciaWa({reloj:()=>t});
  const secreto="SENSITIVE_SECRET_ONLY_IN_EXCEPTION";
  m.registrarError("lectura",Object.assign(Error(secreto),{code:"SQLITE_BUSY"}));
  m.registrarError("escritura",Error(secreto));
  m.registrarError("credenciales",Object.assign(Error(secreto),{code:"SECRET_TOKEN_HIDDEN"}));
  m.registrarExito("lectura");
  const s=m.estado();
  assert.equal(s.fallosRecientes,3);assert.equal(s.operacionesCorrectas,1);
  assert.equal(s.porEtapa.lectura,1);assert.equal(s.porEtapa.escritura,1);
  assert.equal(s.porEtapa.credenciales,1);
  assert.equal(s.ultimoFallo.codigo,"OTRO");
  assert(!JSON.stringify(s).includes(secreto));
  assert(!JSON.stringify(s).includes("SECRET_TOKEN"));
  t+=1800001;assert.equal(m.estado().fallosRecientes,0);
});
test("v4.05: caída de monitor no altera la operación de almacenamiento",async()=>{
  const file=path.join(os.tmpdir(),"hs-v405-wa-"+process.pid+"-"+crypto.randomBytes(6).toString("hex")+".db");
  const base=createClient({url:"file:"+file});
  const key="a".repeat(64);
  const secret="SECRET_IN_ERROR_DO_NOT_LOG";
  const monitor=crearMonitorPersistenciaWa();
  let failRead=false,failWrite=false,failSave=false;
  const error=()=>Object.assign(Error(secret),{code:"SQLITE_BUSY"});
  const db={
    execute:async(q)=>{
      const sql=typeof q==="string"?q:q.sql;
      if(failRead && sql.includes("SELECT id,payload FROM hs_v2_wa_auth_encrypted"))throw error();
      if(failSave && sql.startsWith("INSERT INTO hs_v2_wa_auth_encrypted"))throw error();
      return base.execute(q);
    },
    batch:async(stmts,mode)=>{if(failWrite)throw error();return base.batch(stmts,mode);}
  };
  try{
    const ba={initAuthCreds:()=>({fake:true}),
      BufferJSON:{replacer:(_k,v)=>v,reviver:(_k,v)=>v}};
    const obj=await crearAuthTurso({db,claveHex:key,baileys:ba,
      permitirAltaNueva:true,monitor}).abrir();
    failRead=true;
    await assert.rejects(obj.state.keys.get("session",["a"]),/SECRET_IN_ERROR_DO_NOT_LOG/);
    failRead=false;failWrite=true;
    await assert.rejects(obj.state.keys.set({session:{a:{value:"fake"}}}),/SECRET_IN_ERROR_DO_NOT_LOG/);
    failWrite=false;failSave=true;
    await assert.rejects(obj.saveCreds(),/SECRET_IN_ERROR_DO_NOT_LOG/);
    const s=monitor.estado();
    assert.equal(s.fallosRecientes,3);assert.equal(s.porEtapa.lectura,1);
    assert.equal(s.porEtapa.escritura,1);assert.equal(s.porEtapa.credenciales,1);
    assert(!JSON.stringify(s).includes(secret));
    const broken={registrarError(){throw Error("FALLO_MONITOR");},registrarExito(){throw Error("FALLO_MONITOR");}};
    failSave=false;
    const again=await crearAuthTurso({db,claveHex:key,baileys:ba,monitor:broken}).abrir();
    await again.state.keys.set({session:{b:{value:"ficticio"}}});
    const lookup=await again.state.keys.get("session",["b"]);
    assert.equal(lookup.b.value,"ficticio");
  }finally{
    base.close();for(const p of [file,file+"-wal",file+"-shm"]){try{fs.unlinkSync(p)}catch(_){}}
  }
});
test("v4.05: interfaz y endpoint restringidos entregan solo telemetría agregada",()=>{
  const srv=fs.readFileSync("server.js","utf8"),ui=fs.readFileSync("public/index.html","utf8");
  assert(srv.includes('app.get("/api/whatsapp-status",http.admin'));
  assert(srv.includes("persistencia:persistenciaWA.estado()"));
  assert(srv.includes("monitor: persistenciaWA"));
  assert(ui.includes("data.persistencia?.fallosRecientes"));
});
