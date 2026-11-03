const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { db } = require('./db');

async function readKey(key) {
  try {
    const result = await db.execute({
      sql: "SELECT auth_value FROM baileys_auth_v2 WHERE auth_key = ?", // <-- Cambiado aquí
      args: [key]
    });
    if (result.rows.length === 0) return null;
    return JSON.parse(result.rows[0].auth_value, BufferJSON.reviver);
  } catch (e) {
    console.error("Error leyendo clave:", key, e.message);
    return null;
  }
}

async function writeKey(key, value) {
  try {
    const valueStr = JSON.stringify(value, BufferJSON.replacer);
    await db.execute({
      sql: `INSERT OR REPLACE INTO baileys_auth_v2 (auth_key, auth_value) VALUES (?, ?)`, // <-- Cambiado aquí
      args: [key, valueStr]
    });
  } catch (e) {
    console.error("Error escribiendo clave:", key, e.message);
  }
}

async function deleteKey(key) {
  try {
    await db.execute({
      sql: "DELETE FROM baileys_auth_v2 WHERE auth_key = ?", // <-- Cambiado aquí
      args: [key]
    });
  } catch (e) {
    console.error("Error borrando clave:", key, e.message);
  }
}

async function useTursoAuthState() {
  // Y cambiado aquí abajo
  await db.execute(`
    CREATE TABLE IF NOT EXISTS baileys_auth_v2 (
      auth_key TEXT PRIMARY KEY,
      auth_value TEXT NOT NULL
    )
  `);

  let creds = await readKey('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeKey('creds', creds);
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const value = await readKey(`${type}-${id}`);
          if (value) data[id] = value;
        }
        return data;
      },
      set: async (data) => {
        for (const type in data) {
          for (const id in data[type]) {
            const value = data[type][id];
            const key = `${type}-${id}`;
            if (value) {
              await writeKey(key, value);
            } else {
              await deleteKey(key);
            }
          }
        }
      }
    }
  };

  const saveCreds = async () => {
    await writeKey('creds', state.creds);
  };

  return { state, saveCreds };
}

module.exports = { useTursoAuthState };
