const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { db } = require('./db');

async function readKey(key) {
  const result = await db.execute({
    sql: "SELECT value FROM baileys_auth WHERE key = ?",
    args: [key]
  });
  if (result.rows.length === 0) return null;
  try {
    return JSON.parse(result.rows[0].value, BufferJSON.reviver);
  } catch (e) {
    return null;
  }
}

async function writeKey(key, value) {
  const valueStr = JSON.stringify(value, BufferJSON.replacer);
  await db.execute({
    sql: `INSERT INTO baileys_auth (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, valueStr]
  });
}

async function deleteKey(key) {
  await db.execute({
    sql: "DELETE FROM baileys_auth WHERE key = ?",
    args: [key]
  });
}

async function useTursoAuthState() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS baileys_auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  let creds = await readKey('creds');
  if (!creds) {
    creds = initAuthCreds();
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
