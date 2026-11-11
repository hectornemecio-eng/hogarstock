"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

test("Reenvío WhatsApp: omitir por defecto y reenviar solo por petición explícita",async()=>{
  const server=fs.readFileSync("server.js","utf8");
  const start=server.indexOf('app.post("/api/iniciar-compra"');
  const end=server.indexOf('app.post("/api/admin/finalizar-compra"',start);
  assert(start>=0&&end>start,"Ruta de compartir faltante");
  const ruta=server.slice(start,end);
  const A="34600000001",B="34600000002",C="34600000003";
  const enviadosPrevios=new Set([A]);
  const mensajes=[];
  let handler;
  const ctx={
    app:{post:(url,_,fn)=>{assert.equal(url,"/api/iniciar-compra");handler=fn;}},
    http:{adminWrite:()=>{}},
    grants:{
      validarDestinatarios:(nums)=>{
        if(!Array.isArray(nums)||!nums.length)throw Error("SIN_DESTINATARIOS");
        if(nums.some(x=>![A,B,C].includes(x)))throw Error("NO_AUTORIZADO");
        return [...new Set(nums)];
      },
      prepararEnvio:async()=>({
        compraId:"a".repeat(48),nueva:false,token:"token_de_prueba",
        nombres:["Peras"],cantidad:1
      }),
      estadoEnvio:async({telefono})=>enviadosPrevios.has(telefono)?"confirmado":"nuevo",
      prepararIntentoEnvio:async()=>true,
      registrarEnviado:async({telefono})=>{enviadosPrevios.add(telefono);return true}
    },
    enviarWhatsApp:async(numero,mensaje)=>{
      assert(mensaje.includes("Peras"));
      assert(mensaje.includes("/comprador.html#token="));
      mensajes.push(numero);
      return true;
    },
    whatsappConectado:true,sock:{},broadcast:()=>{},
    resultadoPublico:()=>{throw Error("ERROR_INESPERADO")},
    process:{env:{PUBLIC_BASE_URL:"https://hogarstock.test.invalid"}},
    encodeURIComponent,console
  };
  vm.runInNewContext("let envioListaEnCurso=false;\n"+ruta,ctx);
  assert.equal(typeof handler,"function");

  async function ejecutar(body){
    const res={statusCode:200,body:null,
      status(code){this.statusCode=code;return this},
      json(payload){this.body=payload;return this}
    };
    await handler({body},res);
    return {status:res.statusCode,body:res.body};
  }

  let r=await ejecutar({telefonos:[A]});
  assert.equal(r.status,200);
  assert.equal(mensajes.length,0);
  assert.equal(r.body.enviados.length,0);
  assert.equal(r.body.reenviados.length,0);
  assert.equal(r.body.yaEnviados.length,1);

  r=await ejecutar({telefonos:[A],reenviar:true});
  assert.equal(r.status,200);
  assert.deepEqual(mensajes,[A]);
  assert.equal(r.body.reenviados[0],A);
  assert.equal(r.body.enviados.length,0);
  assert.equal(r.body.yaEnviados.length,0);

  r=await ejecutar({telefonos:[A,B],reenviar:true});
  assert.equal(r.status,200);
  assert.deepEqual(mensajes,[A,A,B]);
  assert.equal(r.body.reenviados[0],A);
  assert.equal(r.body.enviados[0],B);
  assert(enviadosPrevios.has(B));

  r=await ejecutar({telefonos:[A,B]});
  assert.equal(r.status,200);
  assert.equal(r.body.yaEnviados.length,2);
  assert.deepEqual(mensajes,[A,A,B]);

  r=await ejecutar({telefonos:[C],reenviar:false});
  assert.equal(r.status,200);
  assert.deepEqual(mensajes,[A,A,B,C]);
  assert.equal(r.body.enviados[0],C);
  assert(enviadosPrevios.has(C));

  assert.equal(new Set(mensajes).size,3);
  console.log("REENVIO_SOLO_EXPLICITO_Y_UNA_COMPRA_CONSERVADA_OK");
});

test("La interfaz exige confirmación para reenviar e informa si no envió nada",()=>{
  const html=fs.readFileSync("public/index.html","utf8");
  const css=fs.readFileSync("public/hogarstock-ui.css","utf8");
  const scripts=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  for(const match of scripts)if(match[1].trim())new vm.Script(match[1]);
  assert(html.includes('id="permitirReenvio"'));
  assert(html.includes('if(reenviar && !confirm('));
  assert(html.includes("body:JSON.stringify({telefonos,reenviar})"));
  assert(html.includes("No se envió un mensaje nuevo."));
  assert(html.includes("La entrega en el teléfono no se puede garantizar"));
  assert(css.includes(".reenvio-option"));
  assert(html.includes('fetch("/api/admin/compra-activa"'));
  console.log("REENVIO_UI_EXPRESO_Y_EXPLICACION_SIN_FALSAS_ENTREGAS_OK");
});
