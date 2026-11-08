# HogarStock V3 — ensayo de migración del catálogo V2 sin tocar producción

**Fecha:** 8 de noviembre de 2026  
**Destino arquitectónico vigente:** Render; alternativas a Render en pausa por decisión del usuario.  
**Estado:** implementado y validado con bases **SQLite locales y ficticias**. No se accedió a la base Turso real, no se crearon instancias Render ni se importaron sesiones WhatsApp.

## 1. Hallazgo de código V2

La fuente V2 disponible en `db.js` establece la tabla `productos(id,nombre,categoria,agotado)`. Su inicializador conserva datos y no repuebla un catálogo que ya exista. El servidor productivo `server.js` hace consultas y actualizaciones directas del inventario en las rutas `/api/iniciar-compra`, `/api/comprado/:id` y `/api/finalizar-compra`; **no crea ni mantiene una tabla de historial estructurado de compras** en ese código. En su arranque WhatsApp usa `useMultiFileAuthState("auth_info_baileys")`.

**Consecuencia:** solo están demostrablemente migrables desde ese modelo los cuatro campos de `productos`. No se puede reconstruir con garantías desde ese código el historial de compras, destinatarios ni acuses. Las tablas de autenticación Baileys que pudieran existir quedan **excluidas** de la migración y requerirían un análisis separado y autorizado. Un respaldo de V2 debe tratarse como privado.

## 2. Módulo desarrollado

`integration/v3-migracion-catalogo-simulada.js` exporta:

- `leerCatalogoV2(origen)`: ejecuta exclusivamente consultas de metadatos y lectura `SELECT` del catálogo, verifica columnas/clave primaria, orden e IDs únicos positivos, nombres/categorías no vacíos y estado `agotado` 0/1. Rechaza fuentes con tablas V3. Devuelve un resumen con número de productos, agotados y huella SHA-256 determinista del conjunto, junto con los productos en memoria **solo para el proceso**.
- `simularMigracionCatalogo({origen,destino,entorno,confirmacion:true,huellaEsperada})`: comprueba antes de escribir que el entorno es sandbox ficticio, que no hay variables de Turso/WhatsApp real, que origen y destino son clientes diferentes, que la huella del catálogo coincide y que el destino no contiene ninguna tabla de usuario. Crea el catálogo de prueba con **los mismos ID, nombres, categorías y estados** en un lote SQL transaccional destinado únicamente a la base nueva. Añade una tabla auxiliar `hogarstock_v3_migration_dryrun_proof` con huella y conteo y verifica la copia.

La segunda función **no** se invoca por `server.js` ni está integrada en ningún arranque Render. Requiere `HOGARSTOCK_V3_SANDBOX=1` y `HOGARSTOCK_V3_MIGRACION_LAB=1`, además de confirmación `true`. No se habilitan puertos, sockets ni conexiones remotas.

La migración ficticia prepara el catálogo para inicializar servicios V3 con **nuevas claves de ensayo**, sin reutilizar una cuenta WhatsApp real. El esquema V3 dispone de tablas de compra/historial nuevas, pero no se inventan compras anteriores.

## 3. Evidencia de las pruebas

Archivo `tests/v3-migracion-catalogo-simulada.test.js`, nueve escenarios:
1. IDs dispersos, acentos, categorías y agotados conservados; fuente solo lectura; credenciales legacy excluidas.
2. Inicialización de almacenes V3 y creación de una compra ficticia a partir del catálogo copiado.
3. Destino preexistente y origen/destino idénticos rechazados, sin sobrescribir.
4. Sandbox no habilitado, variables reales de Turso/WhatsApp o falta de confirmación bloquean antes de leer.
5. Huella falsa o actualización posterior del catálogo invalidan la aprobación.
6. Tabla ausente, esquema V2 incompatible o presencia de V3 en origen se rechazan.
7. Estados inválidos, nombres vacíos y categorías nulas no se importan silenciosamente.
8. Error de SQL inyectado durante el lote revierte todas las escrituras de la base destino.
9. Segundo intento sobre el mismo destino se rechaza y preserva la copia original.

**GitHub Actions de staging:** `42514115712`; commit `9570e9e57e583e9f9e59e9ddbe897e02e732938e`: **89/89 con Node 20.11.0** y **89/89 con Node 22**, cero fallos, cero saltados; prueba `MAIN_START_SIN_CAMBIOS=SI` en ambos jobs. Los 89 casos son los mismos ejecutados en dos versiones de Node, no 178 casos diferentes.

**Regresión general:** `42514115892`, finalizada correctamente.

## 4. Límites de seguridad explícitos

- Este laboratorio no verifica que la base Turso productiva tenga exactamente el mismo esquema, registros y estado que el código V2 estudiado. Es necesaria auditoría **solo lectura**, con autorización, de su estructura real.
- La huella se basa en una lectura del catálogo por consulta SQL, **no es un backup consistente ni una garantía contra ediciones concurrentes durante una operación real**. Para una migración auténtica se necesita congelación controlada de escritura o una instantánea verificable, y comparación final.
- Los dos clientes inyectados son locales en las pruebas. Pasar clientes de red alteraría el nivel de seguridad; no se ha autorizado hacerlo.
- **No** copiar `auth_info_baileys`, tablas `baileys_auth*`, tokens Turso, teléfonos, sesiones, contactos o hashes de credenciales al repositorio ni a una instancia de ensayo.
- Una copia ficticia en SQLite no equivale a una restauración Turso remota. La tabla auxiliar de huella de ensayo **no** sustituye `hogarstock_v3_stage_proof` requerido por el arranque remoto existente.
- La recuperación de producción exige un respaldo verificado y restaurado, además de un plan de reversión y autorización expresa. El ensayo en un destino nuevo no modifica `main`, Render, WhatsApp V2 ni Turso.
- No se generan logs con productos familiares ni credenciales reales. Las pruebas usan únicamente inventario y datos ficticios.

## 5. Siguiente ruta sobre Render, sin cambios productivos

1. Verificar en el panel privado de Render (sin compartir credenciales) la cuota Free y los cargos configurados. No crear un segundo servicio sin demostrar coste adicional cero.
2. Obtener evidencia de la estructura real de Turso V2 mediante auditoría **solo lectura**, sin exportar datos privados al chat.
3. Preparar una instantánea Turso de V2, restaurable en un destino separado, y ejecutar primero una migración de copia con huellas y conteos; usar autorización **S/N** antes de operaciones externas.
4. Verificar el comportamiento real de la conexión WhatsApp independiente en Render Free, especialmente hibernación y reconexión, sin afectar la sesión V2.
5. Definir el plan de corte y reversión de V2 a V3 exclusivamente cuando la infraestructura, los datos y los flujos de usuario estén acreditados.

## Checklist

- [x] Esquemas V2/V3 inspeccionados desde código real del repositorio.
- [x] Límites de histórico y autenticación legacy identificados.
- [x] Migración ficticia de catálogo implementada como módulo independiente.
- [x] Preservación de identificadores y estados ensayada.
- [x] Rechazo de destino no vacío, hash distinto y configuración remota.
- [x] Atomicidad y conservación de la fuente verificadas mediante pruebas.
- [x] 89/89 en ambas matrices de Node, regresión general satisfactoria.
- [ ] Auditoría de la base Turso productiva real sin escritura.
- [ ] Snapshot/restauración Turso reales, con coste/aislamiento certificados.
- [ ] Integración y prueba de WhatsApp real, migración y rollback autorizados.

**Nota de continuidad:** conservar Render como proveedor activo. No investigar alternativas salvo nueva instrucción del usuario.
