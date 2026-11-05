"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { crearAlmacenCompras } = require("../compras/store.js");

function crearEscenario({ esquemaAntiguo = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec("CREATE TABLE productos (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL," +
    "categoria TEXT NOT NULL,agotado INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec(
    "INSERT INTO productos(id,nombre,categoria,agotado) VALUES" +
    "(1,'Leche','Lacteos',1)," +
    "(2,'Huevos','Lacteos',1)," +
    "(3,'Arroz','Despensa',0)"
  );
  if (esquemaAntiguo) {
    sqlite.exec(
      "CREATE TABLE hogarstock_compras_v3 (" +
      "id INTEGER PRIMARY KEY, estado TEXT)"
    );
    sqlite.exec("INSERT INTO hogarstock_compras_v3 VALUES(99,'antiguo')");
  }
  const consultas=[];
  let reloj=100000;
  let transaccionAbierta=false;
  function ejecutar(consulta) {
    const sql=typeof consulta==="string"?consulta:consulta.sql;
    const args=typeof consulta==="string"?[]:(consulta.args || []);
    consultas.push(sql);
    const sentencia=sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
      return { rows:sentencia.all(...args) };
    }
    const info=sentencia.run(...args);
    return {
      rows:[],
      rowsAffected:info.changes,
      lastInsertRowid:info.lastInsertRowid,
    };
  }
  const cliente={
    async execute(consulta) { return ejecutar(consulta); },
    async batch(consultasBatch) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const resultados=[];
        for (const q of consultasBatch) resultados.push(ejecutar(q));
        sqlite.exec("COMMIT");
        return resultados;
      } catch(e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async transaction(modo) {
      assert.equal(modo,"write");
      assert.equal(transaccionAbierta,false);
      sqlite.exec("BEGIN IMMEDIATE");
      transaccionAbierta=true;
      let cerrada=false;
      return {
        async execute(q) { assert.equal(cerrada,false); return ejecutar(q); },
        async commit() {
          assert.equal(cerrada,false);
          sqlite.exec("COMMIT");
          cerrada=true;
          transaccionAbierta=false;
        },
        async rollback() {
          if (!cerrada) {
            sqlite.exec("ROLLBACK");
            cerrada=true;
            transaccionAbierta=false;
          }
        },
        close() {
          if (!cerrada) {
            sqlite.exec("ROLLBACK");
            cerrada=true;
            transaccionAbierta=false;
          }
        },
      };
    },
  };
  const compras=crearAlmacenCompras(cliente,{reloj:()=>reloj});
  return {sqlite,compras,consultas,setHora:(x)=>{reloj=x;}};
}

function cierre(t,escenario) {
  t.after(()=>escenario.sqlite.close());
}

test("Inicializacion crea tablas e indices y preserva el inventario",async(t)=>{
  const e=crearEscenario();cierre(t,e);
  await e.compras.init();
  const tablas=e.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(x=>x.name);
  assert.ok(tablas.includes("hogarstock_compras_v3"));
  assert.ok(tablas.includes("hogarstock_compra_items_v3"));
  assert.equal(e.sqlite.prepare("SELECT COUNT(*) AS n FROM productos").get().n,3);
  assert.equal(e.sqlite.prepare("SELECT agotado FROM productos WHERE id=1").get().agotado,1);
  await e.compras.init();
  assert.equal(e.sqlite.prepare("SELECT COUNT(*) AS n FROM productos").get().n,3);
});

test("Compra crea instantanea de nombres, categorias y cantidades sin alterar productos",async(t)=>{
  const e=crearEscenario();cierre(t,e);await e.compras.init();
  const p=await e.compras.crearCompra({
    lineas:[{productoId:1,cantidad:2,unidad:"litros"},{productoId:2}],
  });
  assert.equal(p.cantidad,2);
  assert.ok(p.compraId>0);
  const listado=await e.compras.obtenerCompra({compraId:p.compraId});
  assert.equal(listado.estado,"abierta");
  assert.deepEqual(listado.resumen,{total:2,pendientes:2,comprados:0,noDisponibles:0});
  assert.equal(listado.items[0].nombre,"Leche");
  assert.equal(listado.items[0].cantidad,2);
  assert.equal(listado.items[0].unidad,"litros");
  assert.equal(listado.items[1].nombre,"Huevos");
  e.sqlite.exec("UPDATE productos SET nombre='Leche nueva' WHERE id=1");
  const historico=await e.compras.obtenerCompra({compraId:p.compraId});
  assert.equal(historico.items[0].nombre,"Leche");
  assert.equal(e.sqlite.prepare("SELECT agotado FROM productos WHERE id=2").get().agotado,1);
});

test("Dos compras independientes permiten estados diferentes del mismo producto",async(t)=>{
  const e=crearEscenario();cierre(t,e);await e.compras.init();
  const a=await e.compras.crearCompra({lineas:[{productoId:1}]});
  const b=await e.compras.crearCompra({lineas:[{productoId:1}]});
  const compraA=await e.compras.obtenerCompra({compraId:a.compraId});
  await e.compras.cambiarEstadoItem({
    compraId:a.compraId,itemId:compraA.items[0].id,
    estado:"comprado",revisionEsperada:0,
  });
  assert.equal((await e.compras.obtenerCompra({compraId:b.compraId})).items[0].estado,"pendiente");
  assert.equal((await e.compras.obtenerCompra({compraId:a.compraId})).items[0].estado,"comprado");
});

test("Reintentos, conflicto de revision y deshacer estado",async(t)=>{
  const e=crearEscenario();cierre(t,e);await e.compras.init();
  const compra=await e.compras.crearCompra({lineas:[{productoId:1}]});
  const item=(await e.compras.obtenerCompra({compraId:compra.compraId})).items[0];
  const cambio=await e.compras.cambiarEstadoItem({
    compraId:compra.compraId,itemId:item.id,estado:"comprado",revisionEsperada:0,
  });
  assert.deepEqual(cambio,{cambiado:true,revision:1,estado:"comprado"});
  await assert.rejects(
    e.compras.cambiarEstadoItem({
      compraId:compra.compraId,itemId:item.id,estado:"pendiente",revisionEsperada:0,
    }),/CONFLICTO_VERSION/
  );
  const repetir=await e.compras.cambiarEstadoItem({
    compraId:compra.compraId,itemId:item.id,estado:"comprado",revisionEsperada:1,
  });
  assert.deepEqual(repetir,{cambiado:false,revision:1,estado:"comprado"});
  const deshacer=await e.compras.cambiarEstadoItem({
    compraId:compra.compraId,itemId:item.id,estado:"pendiente",revisionEsperada:1,
  });
  assert.deepEqual(deshacer,{cambiado:true,revision:2,estado:"pendiente"});
});

test("Finalizacion idempotente y compra cerrada inmutable",async(t)=>{
  const e=crearEscenario();cierre(t,e);await e.compras.init();
  const p=await e.compras.crearCompra({lineas:[{productoId:1},{productoId:2}]});
  const antes=await e.compras.obtenerCompra({compraId:p.compraId});
  await e.compras.cambiarEstadoItem({
    compraId:p.compraId,itemId:antes.items[0].id,
    estado:"no_disponible",revisionEsperada:0,
  });
  const primera=await e.compras.finalizarCompra({compraId:p.compraId});
  assert.equal(primera.yaFinalizada,false);
  const segunda=await e.compras.finalizarCompra({compraId:p.compraId});
  assert.deepEqual(segunda,{...primera,yaFinalizada:true});
  const despues=await e.compras.obtenerCompra({compraId:p.compraId});
  assert.equal(despues.estado,"finalizada");
  assert.deepEqual(despues.resumen,{total:2,pendientes:1,comprados:0,noDisponibles:1});
  await assert.rejects(
    e.compras.cambiarEstadoItem({
      compraId:p.compraId,itemId:antes.items[0].id,
      estado:"comprado",revisionEsperada:1,
    }),/COMPRA_CERRADA/
  );
  assert.equal(e.sqlite.prepare("SELECT agotado FROM productos WHERE id=1").get().agotado,1);
});

test("Producto inexistente o no agotado: rollback sin cabeceras huérfanas",async(t)=>{
  const e=crearEscenario();cierre(t,e);await e.compras.init();
  for(const id of [999,3]){
    await assert.rejects(e.compras.crearCompra({lineas:[{productoId:1},{productoId:id}]}),
      /PRODUCTO_INEXISTENTE|PRODUCTO_NO_MARCADO_COMO_FALTANTE/);
  }
  assert.equal(e.sqlite.prepare("SELECT COUNT(*) AS n FROM hogarstock_compras_v3").get().n,0);
  assert.equal(e.sqlite.prepare("SELECT COUNT(*) AS n FROM hogarstock_compra_items_v3").get().n,0);
});

test("Esquema previo incompatible: falla sin sobrescribir el registro",async(t)=>{
  const e=crearEscenario({esquemaAntiguo:true});cierre(t,e);
  await assert.rejects(e.compras.init(),/ESQUEMA_COMPRAS_INCOMPATIBLE/);
  assert.equal(
    e.sqlite.prepare("SELECT estado FROM hogarstock_compras_v3 WHERE id=99").get().estado,
    "antiguo"
  );
  assert.equal(
    e.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='hogarstock_compra_items_v3'").get(),
    undefined
  );
});

test("Entradas invalidas y cambios antes de inicializar: sin escrituras",async(t)=>{
  const e=crearEscenario();cierre(t,e);
  await assert.rejects(e.compras.crearCompra({lineas:[{productoId:1}]}),/COMPRAS_NO_INICIALIZADAS/);
  await e.compras.init();
  for(const lineas of [
    [],[{productoId:1},{productoId:1}],
    [{productoId:1,cantidad:0}],[{productoId:-1}],[{productoId:1,unidad:""}],
  ]){
    await assert.rejects(e.compras.crearCompra({lineas}));
  }
  await assert.rejects(
    e.compras.cambiarEstadoItem({compraId:1,itemId:1,estado:"invalido",revisionEsperada:0})
  );
  assert.equal(e.sqlite.prepare("SELECT COUNT(*) AS n FROM hogarstock_compras_v3").get().n,0);
});
