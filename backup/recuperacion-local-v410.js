"use strict";
// v4.10 - Recuperar una copia .hsbk exclusivamente en un fichero SQLite NUEVO.
// No conecta a Turso, Render, WhatsApp ni reescribe ficheros existentes.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {createClient}=require("@libsql/client");
const {abrirRespaldo,restaurarAislado}=require("./backup-safe");

function qId(nombre){
  if(typeof nombre!=="string"||nombre.length===0||nombre.length>256||nombre.includes("\u0000"))
    throw Error("HS_STAGING_IDENTIFICADOR_INVALIDO");
  return '"'+nombre.replace(/"/g,'""')+'"';
}
function decValor(v){
  if(v===null)return null;
  if(v?.t==="text"&&typeof v.v==="string")return v.v;
  if(v?.t==="number"&&typeof v.v==="number"&&Number.isFinite(v.v))return v.v;
  if(v?.t==="integer"&&typeof v.v==="string"&&/^-?[0-9]+$/.test(v.v))return BigInt(v.v);
  if(v?.t==="blob"&&typeof v.v==="string")return Buffer.from(v.v,"base64");
  throw Error("HS_STAGING_VALOR_INVALIDO");
}
function encValor(v){
  if(v===null||v===undefined)return null;
  if(typeof v==="string")return {t:"text",v};
  if(typeof v==="number"&&Number.isFinite(v))return {t:"number",v};
  if(typeof v==="bigint")return {t:"integer",v:v.toString()};
  if(typeof v==="boolean")return {t:"number",v:v?1:0};
  if(v instanceof ArrayBuffer)return {t:"blob",v:Buffer.from(v).toString("base64")};
  if(ArrayBuffer.isView(v)||Buffer.isBuffer(v))return {t:"blob",v:Buffer.from(v.buffer||v,v.byteOffset||0,v.byteLength||v.length).toString("base64")};
  throw Error("HS_STAGING_VALOR_INVALIDO");
}
function firma(filas){
  return crypto.createHash("sha256").update(
    JSON.stringify(filas.map(x=>JSON.stringify(x)).sort())
  ).digest("hex");
}
function validarDestino(destino){
  if(typeof destino!=="string"||!path.isAbsolute(destino)||!destino.toLowerCase().endsWith(".sqlite"))
    throw Error("HS_STAGING_RUTA_ABSOLUTA_SQLITE_REQUERIDA");
  const base=path.resolve(destino);
  if(!fs.statSync(path.dirname(base)).isDirectory())throw Error("HS_STAGING_DIRECTORIO_INVALIDO");
  // No seguir enlaces en el directorio: recuperar siempre en ubicación explícita.
  if(fs.realpathSync(path.dirname(base))!==path.dirname(base))
    throw Error("HS_STAGING_DIRECTORIO_NO_CANONICO");
  return base;
}
async function restaurarComoNuevaSqlite({archivo,clave,destino}={}){
  if(!Buffer.isBuffer(archivo))throw Error("HS_STAGING_ARCHIVO_REQUERIDO");
  const ruta=validarDestino(destino);
  // Verificar PRIMERO que la copia es restaurable en memoria.
  const snap=abrirRespaldo(archivo,clave);
  const verificado=await restaurarAislado(snap);
  if(!verificado.ok)throw Error("HS_STAGING_COPIA_NO_RESTAURABLE");
  let creada=false,db,correcta=false;
  try{
    const fd=fs.openSync(ruta,"wx",0o600);
    creada=true;fs.closeSync(fd);
    db=createClient({url:"file:"+ruta});
    await db.execute("PRAGMA foreign_keys=OFF");
    for(const tabla of snap.esquema.filter(x=>x.type==="table"&&x.sql))
      await db.execute(tabla.sql);
    for(const tabla of snap.tablas){
      const cols=tabla.columnas.map(qId);
      const sql="INSERT INTO "+qId(tabla.nombre)+" ("+cols.join(",")+") VALUES ("+
        cols.map(()=>"?").join(",")+")";
      for(const fila of tabla.filas){
        if(fila.length!==cols.length)throw Error("HS_STAGING_FILA_INCOMPATIBLE");
        await db.execute({sql,args:fila.map(decValor)});
      }
    }
    if(snap.secuencia.length){
      await db.execute("DELETE FROM sqlite_sequence");
      for(const item of snap.secuencia)
        await db.execute({sql:"INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)",
          args:[item.name,decValor(item.seq)]});
    }
    for(const tipo of ["index","view","trigger"]){
      for(const objeto of snap.esquema.filter(x=>x.type===tipo&&x.sql))
        await db.execute(objeto.sql);
    }
    const integrity=await db.execute("PRAGMA integrity_check");
    if(String(integrity.rows[0]?.integrity_check)!=="ok")throw Error("HS_STAGING_INTEGRIDAD_FALLIDA");
    await db.execute("PRAGMA foreign_keys=ON");
    const fk=await db.execute("PRAGMA foreign_key_check");
    if(fk.rows.length)throw Error("HS_STAGING_FOREIGN_KEYS_FALLIDAS");
    for(const tabla of snap.tablas){
      const rowset=await db.execute("SELECT * FROM "+qId(tabla.nombre));
      const filas=rowset.rows.map(row=>tabla.columnas.map(col=>encValor(row[col])));
      if(filas.length!==tabla.total||firma(filas)!==tabla.sha256)
        throw Error("HS_STAGING_RESTAURACION_NO_EQUIVALENTE");
    }
    correcta=true;
    return {ok:true,tablas:snap.tablas.length,filas:snap.totalFilas,
      productos:snap.tablas.find(t=>t.nombre==="productos")?.total??0,
      sha256:crypto.createHash("sha256").update(archivo).digest("hex"),
      destino:ruta};
  }finally{
    if(db)try{db.close();}catch(_){}
    if(creada&&!correcta)for(const p of [ruta,ruta+"-wal",ruta+"-shm"])try{fs.unlinkSync(p)}catch(_){}
  }
}
module.exports={restaurarComoNuevaSqlite};

// Uso fuera de producción: requiere Node, repositorio y terminal interactiva.
// No se pasan claves por argv, archivos planos, variables de entorno ni logs.
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length!==2){
    process.stderr.write("Uso: node backup/recuperacion-local-v410.js RUTA_ABSOLUTA.hsbk DESTINO_NUEVO.sqlite\n");
    process.exitCode=2;
  }else if(!process.stdin.isTTY||!process.stdin.setRawMode){
    process.stderr.write("ERROR=SE_REQUIERE_TERMINAL_INTERACTIVA_PARA_CLAVE_OCULTA\n");
    process.exitCode=2;
  }else{
    function leerClave(){
      return new Promise((resolve,reject)=>{
        let value="";
        process.stdout.write("Clave privada de .hsbk (no se muestra): ");
        const input=process.stdin,antes=input.isRaw;
        input.setEncoding("utf8");input.setRawMode(true);input.resume();
        function terminar(error){
          input.off("data",onData);input.setRawMode(Boolean(antes));
          process.stdout.write("\n");
          if(error)reject(error);else resolve(value);
        }
        function onData(str){
          for(const char of str){
            if(char==="\r"||char==="\n"){terminar();return;}
            if(char==="\u0003"){terminar(Error("CANCELADO"));return;}
            if(char==="\u007f"||char==="\b"){value=value.slice(0,-1);continue;}
            if(char>=" "&&value.length<200)value+=char;
          }
        }
        input.on("data",onData);
      });
    }
    (async()=>{
      const clave=await leerClave();
      try{
        const resultado=await restaurarComoNuevaSqlite({
          archivo:fs.readFileSync(args[0]),clave,destino:args[1]
        });
        process.stdout.write("RESULTADO=SQLITE_NUEVA_VERIFICADA\nTABLAS="+resultado.tablas+
          "\nFILAS="+resultado.filas+"\nPRODUCTOS="+resultado.productos+
          "\nSHA256="+resultado.sha256+"\nDESTINO="+resultado.destino+"\n");
      }finally{/* No registrar ni guardar la frase. */}
    })().catch(e=>{
      const codigo=String(e.message||"ERROR").replace(/[^A-Z0-9_]/g,"").slice(0,90);
      process.stderr.write("RESULTADO=ERROR_CONTROLADO\nCODIGO="+codigo+"\n");
      process.exitCode=1;
    });
  }
}
