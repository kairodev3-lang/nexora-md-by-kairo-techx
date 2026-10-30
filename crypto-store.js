// Stockage chiffré des sessions WhatsApp (remplace useMultiFileAuthState).
//
// - AES-256-GCM, un nonce aléatoire par écriture
// - clé dérivée PAR UTILISATEUR (HKDF(master, salt = tg_id)) : un dossier ne peut pas
//   être déchiffré avec la clé d'un autre, ni copié d'un utilisateur à l'autre
// - le nom du fichier est lié au chiffré (AAD) : on ne peut pas permuter deux fichiers
// - écritures atomiques (fichier temporaire + rename), sérialisées, et NULLES après wipe()
//   (corrige les crashs ENOENT de l'ancien code quand Baileys écrit après suppression)

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function deriveKey(master, tgId) {
  return Buffer.from(
    crypto.hkdfSync('sha256', master, Buffer.from(String(tgId)), Buffer.from('nexora-md/session/v1'), 32),
  );
}

export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unseal(key, blob, aad) {
  if (blob.length < 29) throw new Error('blob chiffré invalide');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const sealJson = (key, aad, value, replacer) =>
  seal(key, Buffer.from(JSON.stringify(value, replacer)), aad);

export const unsealJson = (key, aad, blob, reviver) =>
  JSON.parse(unseal(key, blob, aad).toString('utf8'), reviver);

const SAFE_NAME = /^[A-Za-z0-9._%-]+$/;
const pct = (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
// Les identifiants Baileys contiennent « @ » (ex. 509…@s.whatsapp.net, …@g.us). On encode tout
// caractère non sûr en %XX : nom unique, sans « / » ni « .. » → aucun chemin hors du dossier.
const fileSafe = (name) => {
  let n = String(name).replace(/\//g, '__').replace(/:/g, '-');
  n = n.replace(/[^A-Za-z0-9._%-]/g, pct);
  n = n.replace(/\.{2,}/g, (m) => m.split('').map(() => '%2E').join(''));
  if (!n || !SAFE_NAME.test(n) || n.includes('..')) throw new Error('nom de fichier de session invalide');
  return n;
};

/**
 * @param {string} dir   dossier de session de CET utilisateur
 * @param {Buffer} key   clé dérivée pour CET utilisateur
 * @param {{BufferJSON:any, initAuthCreds:Function, proto:any}} baileys  helpers Baileys (injectés → testable)
 */
export async function useEncryptedAuthState(dir, key, { BufferJSON, initAuthCreds, proto }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let closed = false;
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  const file = (name) => `${fileSafe(name)}.enc`;

  const write = (name, value) =>
    enqueue(async () => {
      if (closed) return;
      const f = file(name);
      const blob = sealJson(key, f, value, BufferJSON.replacer);
      const target = path.join(dir, f);
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, blob, { mode: 0o600 });
      await fs.rename(tmp, target);
    });

  const remove = (name) =>
    enqueue(async () => {
      if (closed) return;
      await fs.rm(path.join(dir, file(name)), { force: true });
    });

  // strict = true : une erreur de déchiffrement est fatale (jamais écraser des creds illisibles)
  const read = async (name, strict = false) => {
    const f = file(name);
    let blob;
    try {
      blob = await fs.readFile(path.join(dir, f));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return unsealJson(key, f, blob, BufferJSON.reviver);
    } catch (e) {
      if (strict) throw new Error(`session illisible (${f}) : clé incorrecte ou fichier altéré`);
      return null;
    }
  };

  const creds = (await read('creds', true)) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            data[id] = v;
          }),
        );
        return data;
      },
      set: async (data) => {
        const tasks = [];
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const value = data[category][id];
            const name = `${category}-${id}`;
            tasks.push(value ? write(name, value) : remove(name));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: () => write('creds', creds),
    /** Plus aucune écriture ne sera acceptée (appelé avant de supprimer le dossier). */
    close: () => {
      closed = true;
    },
  };
}
