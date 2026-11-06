"use strict";

// Restauración comprobable de una BD V3 TOTALMENTE FICTICIA.
// No conecta Turso, no abre credenciales reales, no restaura encima de
// ningún fichero existente ni modifica la base de producción.
const test=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {randomBytes,createHash}=require("node:crypto");
const {mkdtempSync,readFileSync,writeFileSync,rmSync,copyFileSync,constants}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {crearEstadoBaileysCifrado}=require("../whatsapp/auth-store.js");
const {inicializarEnsayoV3,iniciarModulosV3}=require("../integration/turso-stage-bootstrap.js");

const destino={host:"hogarstock-v3-test-recuperacion-lab.turso.io",verificado:true};
const secretos=()=>({
 auth:randomBytes(32).toString("hex"),
 outbox:randomBytes(32).toString("hex"),
 inbox:randomBytes(32).toString("hex"),
});
const codec={replacer:(_k,v)=>v,reviver:(_k,v)=>v};
const authArgs=(cliente,secretos)=>({
 cliente,masterKeyHex:secretos.auth,BufferJSON:codec,
 initAuthCreds:()=>({registrationId:10,ficticia:true}),
});
const hashArchivo=(p)=>createHash("sha256").update(readFileSync(p)).digest("hex");

async function escenario(t){
 const carpeta=mkdtempSync(join(tmpdir(),"hogarstock-v3-restore-drill-"));
 const original=join(carpeta,"origen.sqlite");
 const snapshot=join(carpeta,"instantanea.sqlite");
 const recuperacion=join(carpeta,"recuperada.sqlite");
 const clientes=[];
 const conectar=path=>{const c=createClient({url:"file:"+path});clientes.push(c);return c;};
 t.after(()=>{for(const c of clientes){try{c.close()}catch(_){}}
   rmSync(carpeta,{recursive:true,force:true});});
 const cliente=conectar(original),k=secretos();
 const inicio=await inicializarEnsayoV3({cliente,secretos:k,confirmacion:true,destino});
 const compra=await inicio.modulos.compras.crearCompra({lineas:[{productoId:1}]});
 const item=(await inicio.modulos.compras.obtenerCompra({compraId:compra.compraId})).items[0];
 const mensaje=await inicio.modulos.outbox.registrarSolicitud({
  claveIdempotencia:"restore-lab-mensaje-uno",
  telefono:"34900111222",mensaje:"Solo prueba sintética de restauración",
  compraId:compra.compraId,
 });
 await inicio.modulos.inbox.vincularRemitente({compraId:compra.compraId,telefono:"34900111222"});
 const propuesta=await inicio.modulos.inbox.recibir({
  telefono:"34900111222",mensajeId:"LABRESTAURACION1234",
  texto:"COMPRADO "+item.id,
 });
 const aplicada=await inicio.modulos.aplicador.aplicar({
  compraId:compra.compraId,respuestaId:propuesta.id,revisionEsperada:0,
 });
 assert.equal(aplicada.estado,"comprado");
 const auth=await crearEstadoBaileysCifrado(authArgs(cliente,k));
 auth.state.creds.registrationId=987654;
 await auth.saveCreds();
 return {carpeta,original,snapshot,recuperacion,cliente,conectar,k,compra,item,mensaje,propuesta};
}

async function crearInstantanea(cliente,ruta){
 // SQLite VACUUM INTO produce una copia coherente de la BD; destino nuevo.
 await cliente.execute({sql:"VACUUM INTO ?",args:[ruta]});
}

test("Recuperación independiente preserva productos, compras, cifrado, respuestas e historial",async t=>{
 const e=await escenario(t);
 await crearInstantanea(e.cliente,e.snapshot);
 assert.equal(readFileSync(e.snapshot,undefined).subarray(0,16).toString("utf8"),"SQLite format 3\u0000");
 const antes=hashArchivo(e.snapshot);
 copyFileSync(e.snapshot,e.recuperacion,constants.COPYFILE_EXCL);
 assert.equal(hashArchivo(e.recuperacion),antes);
 const recuperada=e.conectar(e.recuperacion);
 const check=await recuperada.execute("PRAGMA integrity_check");
 assert.equal(String(check.rows[0].integrity_check),"ok");
 const restauracion=await iniciarModulosV3({cliente:recuperada,secretos:e.k});
 const productos=await recuperada.execute("SELECT id,nombre,agotado FROM productos ORDER BY id");
 assert.equal(productos.rows.length,3);
 assert.ok(productos.rows.every(x=>String(x.nombre).includes("FICTICI")));
 const estado=await restauracion.compras.obtenerCompra({compraId:e.compra.compraId});
 assert.equal(estado.items.length,1);
 assert.equal(estado.items[0].estado,"comprado");
 assert.equal(Number(estado.items[0].revision),1);
 assert.equal((await restauracion.outbox.obtener(e.mensaje.id)).estado,"pendiente");
 const reservado=await restauracion.outbox.reclamarEnvio(e.mensaje.id);
 assert.equal(reservado.adquirido,true);
 assert.equal(reservado.telefono,"34900111222");
 const entradas=await restauracion.inbox.listarPorCompra({compraId:e.compra.compraId});
 assert.equal(entradas.length,1);
 assert.equal(entradas[0].estado,"revisada");
 const aplicaciones=await restauracion.aplicador.listarPorCompra({compraId:e.compra.compraId});
 assert.equal(aplicaciones.length,1);
 const cred=await crearEstadoBaileysCifrado(authArgs(recuperada,e.k));
 assert.equal(cred.state.creds.registrationId,987654);
 // Un backup contiene información privada y NO es seguro para publicar.
 const bytes=readFileSync(e.snapshot).toString("utf8");
 assert.equal(bytes.includes("Solo prueba sintética de restauración"),false);
 assert.equal(bytes.includes("34900111222"),false);
});

test("Clave errónea en copia no destruye ciphertext ni desbloquea mensajes",async t=>{
 const e=await escenario(t);
 await crearInstantanea(e.cliente,e.snapshot);
 copyFileSync(e.snapshot,e.recuperacion,constants.COPYFILE_EXCL);
 const hashAntes=hashArchivo(e.recuperacion);
 const recuperada=e.conectar(e.recuperacion);
 const otras={...e.k,auth:randomBytes(32).toString("hex"),outbox:randomBytes(32).toString("hex")};
 // Los inicializadores no eliminan las tablas, pero los datos deben
 // quedar inaccesibles con una clave maestra equivocada.
 const modulos=await iniciarModulosV3({cliente:recuperada,secretos:otras});
 await assert.rejects(modulos.outbox.reclamarEnvio(e.mensaje.id),/WA_OUTBOX_NO_DESCIFRABLE/);
 await assert.rejects(crearEstadoBaileysCifrado(authArgs(recuperada,otras)),/WA_AUTH_NO_DESCIFRABLE/);
 assert.equal(hashArchivo(e.recuperacion),hashAntes);
 assert.equal((await modulos.outbox.obtener(e.mensaje.id)).estado,"pendiente");
});

test("Copia de recuperación no sobrescribe una base ya existente",async t=>{
 const e=await escenario(t);
 await crearInstantanea(e.cliente,e.snapshot);
 writeFileSync(e.recuperacion,"ARCHIVO PREEXISTENTE NO DEBE MODIFICARSE");
 assert.throws(
  ()=>copyFileSync(e.snapshot,e.recuperacion,constants.COPYFILE_EXCL),
  err=>err?.code==="EEXIST"
 );
 assert.equal(readFileSync(e.recuperacion,"utf8"),
  "ARCHIVO PREEXISTENTE NO DEBE MODIFICARSE");
});

test("Alterar un snapshot se detecta con hash antes de restaurar",async t=>{
 const e=await escenario(t);
 await crearInstantanea(e.cliente,e.snapshot);
 const esperado=hashArchivo(e.snapshot);
 copyFileSync(e.snapshot,e.recuperacion,constants.COPYFILE_EXCL);
 const bytes=readFileSync(e.recuperacion);
 bytes[bytes.length-1]^=0x5a;
 writeFileSync(e.recuperacion,bytes);
 assert.notEqual(hashArchivo(e.recuperacion),esperado);
});
