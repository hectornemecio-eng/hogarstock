"use strict";
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const net=require("node:net");
const crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {createClient}=require("@libsql/client");
const PASS="HogarStock-Demo-2026";
const isTest=process.argv.includes("--smoke-test");
const root=path.resolve(__dirname,"..");
const dataDir=isTest?fs.mkdtempSync(path.join(os.tmpdir(),"hogarstock-lab-")):path.join(root,"LAB_LOCAL");
const dbFile=path.join(dataDir,"inventario-demo.sqlite");
function hashAdmin(password,salt){
  return crypto.scryptSync(password,Buffer.from(salt,"hex"),32,
    {N:16384,r:8,p:1,maxmem:64*1024*1024}).toString("hex");
}
async function getPort(){
  const s=net.createServer();
  await new Promise((ok,bad)=>{s.on("error",bad);s.listen(0,"127.0.0.1",ok)});
  const port=s.address().port;
  await new Promise(ok=>s.close(ok));
  return port;
}
async function createLabDB(){
  fs.mkdirSync(dataDir,{recursive:true});
  const url="file:"+dbFile.replace(/\\/g,"/");
  const conn=createClient({url});
  try{
    const t=await conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='productos'");
    if(!t.rows.length){
      await conn.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT NOT NULL,agotado INTEGER DEFAULT 0)");
      const items=[
        ["Leche","Lácteos",1],["Huevos","Lácteos",0],["Yogur","Lácteos",0],
        ["Manzanas","Frutas y verduras",1],["Tomates","Frutas y verduras",0],
        ["Pasta","Despensa",1],["Aceite de oliva","Despensa",0],
        ["Detergente","Limpieza",0],["Papel higiénico","Limpieza",1]
      ];
      for(const [n,c,a] of items)await conn.execute({sql:
        "INSERT INTO productos(nombre,categoria,agotado) VALUES(?,?,?)",args:[n,c,a]});
    }
    return url;
  }finally{conn.close()}
}
async function runTest(origin){
  const check=(yes,why)=>{if(!yes)throw Error("PRUEBA_HTTP_"+why)};
  for(let i=0;i<40;i++){
    try{const r=await fetch(origin+"/admin-login.html");if(r.ok)break}catch(_){}
    await new Promise(ok=>setTimeout(ok,150));
  }
  const login=await fetch(origin+"/api/admin/login",{method:"POST",
    headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({password:PASS})});
  check(login.ok,"LOGIN");
  const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
  check(cookie.startsWith("hs_lab_local_admin="),"COOKIE");
  const session=await fetch(origin+"/api/admin/session",{headers:{Cookie:cookie}});
  check(session.ok,"SESSION");
  const {csrf}=await session.json();
  check(typeof csrf==="string"&&csrf.length===64,"CSRF");
  const headers={Origin:origin,Cookie:cookie,"X-HS-CSRF":csrf,
    "Content-Type":"application/json"};
  const fetchList=()=>fetch(origin+"/api/productos",{headers:{Cookie:cookie}})
    .then(r=>r.json());
  check((await fetchList()).length===9,"DATOS_FICTICIOS");
  const post=(action,body)=>fetch(origin+"/api/admin/catalogo/"+action,{
    method:"POST",headers,body:JSON.stringify(body)});
  const create=await post("crear",{nombre:"Prueba de alta",categoria:"Pruebas"});
  check(create.ok,"CREAR");
  const {id}=await create.json();
  check(Number.isSafeInteger(id),"ID");
  check((await post("editar",{id,nombre:"Prueba editada",categoria:"Pruebas"})).ok,"EDITAR");
  check((await post("archivar",{id})).ok,"ARCHIVAR");
  check((await fetchList()).length===9,"LISTAR_SIN_ARCHIVADO");
  const w=await fetch(origin+"/api/whatsapp-status",{headers:{Cookie:cookie}});
  check((await w.json()).modoLaboratorio===true,"WHATSAPP_DESACTIVADO");
  console.log("RESULTADO=LAB_REAL_SUPERADO | LOGIN=OK | CRUD=OK | WHATSAPP=NO");
}
async function main(){
  if(fs.existsSync(path.join(root,".env")))throw Error("LAB_BLOQUEADO_EXISTE_ARCHIVO_ENV");
  const dburl=await createLabDB();
  if(!dburl.startsWith("file:"))throw Error("LAB_DB_NO_LOCAL");
  const port=await getPort();
  const origin="http://127.0.0.1:"+port;
  const salt=crypto.randomBytes(32).toString("hex");
  Object.assign(process.env,{
    NODE_ENV:"test",HS_V2_LAB_NO_WHATSAPP:"1",PUBLIC_BASE_URL:origin,PORT:String(port),
    TURSO_DATABASE_URL:dburl,TURSO_AUTH_TOKEN:"",
    HS_WA_AUTH_STORAGE:"desactivado",HS_WA_AUTH_ENC_KEY:"",
    WA_ALLOWED_NUMBERS:"",
    HS_V2_ADMIN_PASSWORD_SALT:salt,
    HS_V2_ADMIN_PASSWORD_HASH:hashAdmin(PASS,salt),
    HS_V2_SESSION_SECRET:crypto.randomBytes(32).toString("hex"),
    HS_V2_BUYER_SECRET:crypto.randomBytes(32).toString("hex")
  });
  require("../server");
  if(isTest){
    try{await runTest(origin);process.exit(0)}
    finally{try{fs.rmSync(dataDir,{recursive:true,force:true})}catch(_){}}
  }
  console.log("============================================");
  console.log("HOGARSTOCK V4.04 | LABORATORIO LOCAL REAL");
  console.log("DATOS=FICTICIOS | TURSO_REMOTO=NO | WHATSAPP=NO");
  console.log("URL="+origin+"/admin-login.html");
  console.log("CONTRASENA_DEMO_INICIAL="+PASS);
  console.log("DATOS_LOCALES="+dataDir);
  console.log("CIERRA_ESTA_VENTANA_PARA_DETENER_EL_SERVIDOR");
  console.log("============================================");
  if(process.platform==="win32"){
    const link=origin+"/admin-login.html";
    spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",
      "Start-Process '"+link+"'"],{detached:true,stdio:"ignore",windowsHide:true}).unref();
  }
}
main().catch(e=>{console.error("RESULTADO=ERROR | "+String(e?.message||e));process.exitCode=1});
