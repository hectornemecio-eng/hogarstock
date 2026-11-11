"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createClient}=require("@libsql/client");
const {crearGrantsV2}=require("../security/v2-grants");
const {crearIdentidadV2,generarMaterial}=require("../security/v2-identity");
const fs=require("node:fs");
const vm=require("node:vm");

async function fixture(fn){
  const db=createClient({url:"file::memory:"});
  const A="34600000001",B="34600000002";
  const identidad=crearIdentidadV2({entorno:generarMaterial("clave-aislada-para-regresion-v405")});
  try{
    await db.execute("CREATE TABLE productos(id INTEGER PRIMARY KEY,nombre TEXT,categoria TEXT,agotado INTEGER)");
    await db.execute({sql:"INSERT INTO productos VALUES(1,'Leche','Lácteos',1)",args:[]});
    const grants=crearGrantsV2({db,identidad,contactos:[A,B]});
    await grants.init();
    await fn({db,grants,A,B});
  }finally{db.close();}
}
test("v4.05: primer destinatario queda incierto hasta confirmar su envío",async()=>{
  await fixture(async({grants,A})=>{
    const compra=await grants.crearCompra({telefono:A});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:A}),"incierto");
    assert.equal(await grants.yaEnviado({compraId:compra.compraId,telefono:A}),false);
    await grants.registrarEnviado({compraId:compra.compraId,telefono:A});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:A}),"confirmado");
    assert.equal(await grants.yaEnviado({compraId:compra.compraId,telefono:A}),true);
  });
});
test("v4.05: un intento pendiente no se confunde con entrega confirmada",async()=>{
  await fixture(async({grants,A,B})=>{
    const compra=await grants.crearCompra({telefono:A});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:B}),"nuevo");
    await grants.prepararIntentoEnvio({compraId:compra.compraId,telefono:B});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:B}),"incierto");
    await grants.registrarEnviado({compraId:compra.compraId,telefono:B});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:B}),"confirmado");
  });
});
test("v4.05: destinatario principal heredado sin fila de envío no se supone entregado",async()=>{
  await fixture(async({db,grants,A})=>{
    const compra=await grants.crearCompra({telefono:A});
    await db.execute({sql:"DELETE FROM hs_v2_security_envios WHERE compra_id=? AND telefono=?",args:[compra.compraId,A]});
    assert.equal(await grants.estadoEnvio({compraId:compra.compraId,telefono:A}),"incierto");
    assert.equal(await grants.yaEnviado({compraId:compra.compraId,telefono:A}),false);
  });
});
test("v4.05: una compra cerrada no admite registrar envíos nuevos",async()=>{
  await fixture(async({grants,A,B})=>{
    const c=await grants.crearCompra({telefono:A});
    await grants.revocar({compraId:c.compraId});
    await assert.rejects(grants.prepararIntentoEnvio({compraId:c.compraId,telefono:B}),/CERRADA_O_EXPIRADA/);
    await assert.rejects(grants.registrarEnviado({compraId:c.compraId,telefono:B}),/CERRADA_O_EXPIRADA/);
  });
});
test("v4.05: la ruta evita repetir automáticamente cuando el estado es incierto",async()=>{
  const server=fs.readFileSync("server.js","utf8");
  const start=server.indexOf('app.post("/api/iniciar-compra"');
  const end=server.indexOf('app.post("/api/admin/finalizar-compra"',start);
  assert(start>=0&&end>start);
  let handler;const enviados=[];const c="a".repeat(48),A="34600000001";
  let estado="incierto";
  const scope={
    app:{post:(_url,_mw,fn)=>{handler=fn}},
    http:{adminWrite:()=>{}},
    grants:{
      validarDestinatarios:xs=>xs,
      prepararEnvio:async()=>({compraId:c,nueva:false,token:"ficticio",nombres:["Leche"],cantidad:1}),
      estadoEnvio:async()=>estado,
      prepararIntentoEnvio:async()=>true,
      registrarEnviado:async()=>{estado="confirmado";return true}
    },
    enviarWhatsApp:async(numero)=>{enviados.push(numero)},
    whatsappConectado:true,sock:{},broadcast:()=>{},
    resultadoPublico:()=>{throw Error("NO_ESPERADO")},
    process:{env:{PUBLIC_BASE_URL:"https://hogarstock.test.invalid"}},
    encodeURIComponent
  };
  vm.runInNewContext("let envioListaEnCurso=false;"+server.slice(start,end),scope);
  async function accion(reenviar){
    const res={statusCode:200,status(n){this.statusCode=n;return this},json(x){this.body=x;return this}};
    await handler({body:{telefonos:[A],reenviar}},res);return res;
  }
  let r=await accion(false);
  assert.equal(r.statusCode,503);assert.equal(enviados.length,0);
  assert.equal(r.body.inciertos.length,1);
  r=await accion(true);assert.equal(r.statusCode,200);
  assert.deepEqual(enviados,[A]);
  r=await accion(false);assert.equal(r.body.yaEnviados.length,1);
  assert.deepEqual(enviados,[A]);
});
