// Commandes WhatsApp qui ont besoin du socket : .apk, .unblock, .save, réglages (.autoread, …).
// Réservées au propriétaire du compte lié : engine-baileys.js n'appelle ce module que pour les
// messages écrits PAR le propriétaire. Les réglages sont enregistrés dans settings.json (dossier
// de session de l'utilisateur, supprimé avec la session).

import fs from 'node:fs/promises';
import path from 'node:path';
import { box } from './wa-menu.js';

const SETTINGS_FILE = 'settings.json';
const PREFIX_CHARS = '.!#+-$~^?&';
const MAX_APK_BYTES = 100 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;

export const DEFAULT_SETTINGS = Object.freeze({
  prefix: '.',
  autorecording: false,
  autotyping: false,
  anticall: false,
  welcome: false,
  goodbye: false,
  autoread: false,
  autoviewstatus: false,
  autolikestatus: false,
});
const BOOL_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'prefix');

const ALIASES = {
  autorec: 'autorecording', arecording: 'autorecording',
  autotype: 'autotyping', atyping: 'autotyping',
  acall: 'anticall',
  autoviewsview: 'autoviewstatus', avs: 'autoviewstatus', statusseen: 'autoviewstatus', astatus: 'autoviewstatus',
  als: 'autolikestatus',
};

const INFO = {
  autorecording: { emoji: '🎙️', label: 'AUTO RECORDING', desc: 'Affiche « enregistre un vocal… » quand on vous écrit.' },
  autotyping: { emoji: '⌨️', label: 'AUTO TYPING', desc: 'Affiche « écrit… » quand on vous écrit.' },
  anticall: { emoji: '📵', label: 'ANTI CALL', desc: 'Rejette automatiquement les appels reçus.' },
  welcome: { emoji: '👋', label: 'WELCOME', desc: 'Message de bienvenue aux nouveaux membres des groupes.' },
  goodbye: { emoji: '🚪', label: 'GOODBYE', desc: 'Message d\'au revoir quand un membre quitte un groupe.' },
  autoread: { emoji: '👀', label: 'AUTO READ', desc: 'Marque les messages reçus comme lus (coches bleues).' },
  autoviewstatus: { emoji: '👁️', label: 'AUTO STATUS VIEW', desc: 'Regarde automatiquement les statuts de vos contacts.' },
  autolikestatus: { emoji: '❤️', label: 'AUTO STATUS LIKE', desc: 'Réagit ❤️ aux statuts de vos contacts.' },
};

const COMMANDS = new Set(['apk', 'unblock', 'save', 'setprefix', ...Object.keys(INFO), ...Object.keys(ALIASES)]);

export async function loadSettings(dir) {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    for (const k of BOOL_KEYS) if (typeof raw[k] === 'boolean') s[k] = raw[k];
    if (typeof raw.prefix === 'string' && raw.prefix.length === 1 && PREFIX_CHARS.includes(raw.prefix)) s.prefix = raw.prefix;
  } catch {
    /* pas de fichier ou fichier illisible → valeurs par défaut */
  }
  return s;
}

async function saveSettings(dir, s) {
  const target = path.join(dir, SETTINGS_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

const toNum = (v) => (v == null ? 0 : typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
const num = (j) => String(j || '').split('@')[0].split(':')[0];
const okAptoideUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || x.protocol === 'http:') && /(^|\.)aptoide\.com$/i.test(x.hostname);
  } catch {
    return false;
  }
};

/**
 * @param {object} d
 * @param {any} d.sock   socket Baileys
 * @param {string} d.authDir
 * @param {(jid:string, content:object, quoted?:object, plain?:boolean)=>Promise<any>} d.send
 * @param {{downloadMediaMessage:Function, normalizeMessageContent?:Function, jidNormalizedUser:Function, logger?:any}} d.helpers
 */
export async function createExtras({ sock, authDir, send, helpers, log = () => {}, fetchImpl = globalThis.fetch }) {
  const settings = await loadSettings(authDir);
  const { downloadMediaMessage, normalizeMessageContent, jidNormalizedUser } = helpers;
  const norm = (m) => (normalizeMessageContent ? normalizeMessageContent(m) : null) || m;
  const ownJid = () => (sock.user?.id ? jidNormalizedUser(sock.user.id) : null);
  const isSelf = (j) => [num(sock.user?.id), num(sock.user?.lid)].filter(Boolean).includes(num(j));
  const P = () => settings.prefix;

  /* ───────── .apk ───────── */
  async function apk(q, { reply, jid, m }) {
    if (!q) return reply(box('📦 *APK DOWNLOAD*', [`Usage : *${P()}apk <nom>*`, `Exemple : *${P()}apk whatsapp*`]));
    await reply(box('🔎 *APK*', [`Recherche de « ${q.slice(0, 60)} »…`]));
    const res = await fetchImpl(`https://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`aptoide ${res.status}`);
    const data = await res.json();
    const app = data?.datalist?.list?.[0];
    if (!app) return reply(box('❌ *APK*', ['Aucun résultat.']));
    const url = app.file?.path || app.file?.path_alt;
    const bytes = toNum(app.size) || toNum(app.file?.filesize);
    if (!url || !okAptoideUrl(url)) return reply(box('❌ *APK*', ['Lien de téléchargement indisponible.']));
    if (bytes > MAX_APK_BYTES) return reply(box('❌ *APK*', [`Fichier trop gros (${(bytes / 1048576).toFixed(0)} MB, max 100 MB).`]));

    const info = box('📦 *APK INFO*', [
      `Nom     : *${String(app.name || '').toUpperCase()}*`,
      `Taille  : *${(bytes / 1048576).toFixed(2)} MB*`,
      `Package : *${app.package || '—'}*`,
      `Version : *${app.file?.vername || '—'}*`,
    ]);
    if (app.icon && okAptoideUrl(app.icon)) await send(jid, { image: { url: app.icon }, caption: info }, m, true);
    else await reply(info);
    await send(
      jid,
      {
        document: { url },
        mimetype: 'application/vnd.android.package-archive',
        fileName: `${String(app.name || 'app').replace(/[^\w.-]+/g, '_')}.apk`,
      },
      m,
      true,
    );
  }

  /* ───────── .unblock ───────── */
  async function unblock({ jid, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    let target = ci?.participant || null; // réponse à un message
    if (!target && /@(s\.whatsapp\.net|lid)$/.test(jid)) target = jid; // conversation privée
    if (!target || isSelf(target)) {
      return reply(box('✅ *UNBLOCK*', ['Répondez au message de la personne,', 'ou envoyez la commande dans sa conversation.']));
    }
    await sock.updateBlockStatus(target, 'unblock');
    await send(jid, { text: box('✅ *UNBLOCKED*', [`@${num(target)} est débloqué.`]), mentions: [target] }, null);
  }

  /* ───────── .save / réponse « save » à un statut ───────── */
  async function saveStatus({ jid, content, reply, requireStatus }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    if (!ci?.quotedMessage) {
      if (requireStatus) return false;
      await reply(box('📤 *SAVE*', [`Répondez à un statut (ou un média) avec *${P()}save*.`]));
      return true;
    }
    if (requireStatus && ci.remoteJid !== 'status@broadcast') return false;

    const q = norm(ci.quotedMessage);
    const from = ci.participant ? `@${num(ci.participant)}` : '—';
    const caption = box('📤 *STATUS SAVED*', [`De : ${from}`]);
    const me = ownJid();
    if (!me) return true;

    const media = q.imageMessage ? ['image', q.imageMessage] : q.videoMessage ? ['video', q.videoMessage] : null;
    if (!media) {
      const text = q.conversation || q.extendedTextMessage?.text;
      if (text) await send(me, { text: `${caption}\n\n${text}` }, null);
      else await reply(box('❌ *SAVE*', ['Ce type de statut n\'est pas pris en charge.']));
      return true;
    }
    if (toNum(media[1].fileLength) > MAX_STATUS_BYTES) {
      await reply(box('❌ *SAVE*', ['Média trop gros (max 64 MB).']));
      return true;
    }
    const buf = await downloadMediaMessage(
      { key: { remoteJid: ci.remoteJid || jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q },
      'buffer',
      {},
      { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage },
    );
    await send(me, { [media[0]]: buf, caption }, null, true);
    return true;
  }

  /* ───────── réglages ───────── */
  async function toggle(key, name, arg, reply) {
    const i = INFO[key];
    const v = String(arg || '').toLowerCase();
    if (['on', 'true', '1'].includes(v)) settings[key] = true;
    else if (['off', 'false', '0'].includes(v)) settings[key] = false;
    else {
      return reply(box(`${i.emoji} *${i.label}*`, [`Statut : *${settings[key] ? 'ON' : 'OFF'}*`, i.desc, `Usage : *${P()}${name} on* ou *off*`]));
    }
    await saveSettings(authDir, settings);
    return reply(box(`${i.emoji} *${i.label}*`, [`Statut : *${settings[key] ? 'ON' : 'OFF'}* ✅`]));
  }

  async function setPrefix(arg, reply) {
    if (!arg || arg.length !== 1 || !PREFIX_CHARS.includes(arg)) {
      return reply(box('🔖 *PREFIX*', [`Actuel : *${P()}*`, `Choix : ${[...PREFIX_CHARS].join(' ')}`, `Usage : *${P()}setprefix <symbole>*`]));
    }
    settings.prefix = arg;
    await saveSettings(authDir, settings);
    return reply(box('🔖 *PREFIX*', [`Nouveau prefix : *${arg}*`, `Exemple : *${arg}menu*`, 'Secours : *.setprefix .* marche toujours.']));
  }

  /* ───────── points d'entrée ───────── */
  async function handleCommand({ cmd, args, q, jid, m, content, reply }) {
    const name = ALIASES[cmd] || cmd;
    if (name === 'apk') return apk(q, { reply, jid, m });
    if (name === 'unblock') return unblock({ jid, content, reply });
    if (name === 'save') return saveStatus({ jid, content, reply, requireStatus: false });
    if (name === 'setprefix') return setPrefix(args[0], reply);
    if (INFO[name]) return toggle(name, cmd, args[0], reply);
    return null;
  }

  // Réponse « save / send / sendme » à un statut (sans préfixe).
  const saveFromStatus = (a) => saveStatus({ ...a, requireStatus: true });

  const safe = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      log('warn', `wa ${label} failed`, { err: e?.message || 'error' });
    }
  };

  // Messages reçus d'AUTRES personnes : seules les métadonnées servent (jamais le contenu).
  async function onIncoming(m, type) {
    if (type !== 'notify' || !m.key) return;
    const jid = m.key.remoteJid;
    if (!jid) return;
    if (jid === 'status@broadcast') {
      if (settings.autoviewstatus) await safe('status view', () => sock.readMessages([m.key]));
      if (settings.autolikestatus && m.key.participant) {
        await safe('status like', () =>
          sock.sendMessage('status@broadcast', { react: { text: '❤️', key: m.key } }, { statusJidList: [m.key.participant, ownJid()].filter(Boolean) }),
        );
      }
      return;
    }
    if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    if (settings.autoread) await safe('read', () => sock.readMessages([m.key]));
    if (settings.autorecording) await safe('presence', () => sock.sendPresenceUpdate('recording', jid));
    else if (settings.autotyping) await safe('presence', () => sock.sendPresenceUpdate('composing', jid));
  }

  async function onCalls(calls) {
    if (!settings.anticall) return;
    for (const c of calls || []) {
      if (c.status === 'offer' && c.id && c.from) await safe('reject call', () => sock.rejectCall(c.id, c.from));
    }
  }

  async function onGroupUpdate({ id, participants, action }) {
    const wanted = (action === 'add' && settings.welcome) || (action === 'remove' && settings.goodbye);
    if (!wanted) return;
    let subject = 'ce groupe';
    try {
      subject = (await sock.groupMetadata(id))?.subject || subject;
    } catch {
      /* on garde le texte par défaut */
    }
    for (const p of participants || []) {
      const who = typeof p === 'string' ? p : p?.phoneNumber || p?.id;
      if (!who || isSelf(who)) continue;
      const lines = action === 'add' ? [`Bienvenue @${num(who)} 🎉`, `Dans : *${subject}*`] : [`@${num(who)} a quitté le groupe.`, `Groupe : *${subject}*`];
      const title = action === 'add' ? '👋 *WELCOME*' : '🚪 *GOODBYE*';
      await safe('group message', () => send(id, { text: box(title, lines), mentions: [who] }, null));
    }
  }

  return { settings, has: (cmd) => COMMANDS.has(cmd), handleCommand, saveFromStatus, onIncoming, onCalls, onGroupUpdate };
}
