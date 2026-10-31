// Commandes WhatsApp qui ont besoin du socket : .apk, .unblock, .save, réglages (.autoread, …).
// Réservées au propriétaire du compte lié : engine-baileys.js n'appelle ce module que pour les
// messages écrits PAR le propriétaire. Les réglages sont enregistrés dans settings.json (dossier
// de session de l'utilisateur, supprimé avec la session).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { box } from './wa-menu.js';

const SETTINGS_FILE = 'settings.json';
const PREFIX_CHARS = '.!#+-$~^?&';
const MAX_APK_BYTES = 100 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 30 * 60;
const MAX_STICKERS = 50;

export const DEFAULT_SETTINGS = Object.freeze({
  prefix: '.',
  mode: 'private', // private = seulement le propriétaire · public = les autres ont accès aux commandes publiques
  autorecording: false,
  autotyping: false,
  anticall: false,
  welcome: false,
  goodbye: false,
  autoread: false,
  autoviewstatus: false,
  autolikestatus: false,
});
const BOOL_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'prefix' && k !== 'mode');

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

const CMD_ALIASES = {
  ytmp4: 'video', vdl: 'video',
  pin: 'pinterest', pindl: 'pinterest',
  tgsticker: 'telegram', tg: 'telegram',
  chatid: 'jid', gjid: 'jid', mylid: 'jid',
  fancytext: 'fancy',
};
const COMMANDS = new Set([
  'apk', 'unblock', 'save', 'setprefix', 'mode', 'video', 'pinterest', 'telegram', 'jid', 'fancy',
  ...Object.keys(INFO), ...Object.keys(ALIASES), ...Object.keys(CMD_ALIASES),
]);

/* ───────── mode public : ce que les autres peuvent utiliser ───────── */
// Tout le reste (réglages, unblock, save, pair, telegram, jid, mode…) reste réservé au propriétaire.
const PUBLIC_CMDS = new Set(['menu', 'help', 'owner', 'alive', 'ping', 'runtime', 'status', 'apk', 'video', 'pinterest', 'fancy']);
const HEAVY_CMDS = new Set(['apk', 'video', 'pinterest']);
const OWNER_ONLY_BASE = new Set(['pair', 'getpair', 'depair', 'unpair']);
const GUEST_WINDOW_MS = 60_000;
const GUEST_MAX_PER_WINDOW = 8;
const GUEST_HEAVY_COOLDOWN_MS = 60_000;
const GUEST_MAX_HEAVY_PARALLEL = 2;

/* ───────── .fancy : 10 styles d'écriture ───────── */
const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const alpha = (up, low, dig, over = {}) => (ch) => {
  if (over[ch]) return over[ch];
  const c = ch.codePointAt(0);
  if (up != null && c >= 65 && c <= 90) return String.fromCodePoint(up + c - 65);
  if (low != null && c >= 97 && c <= 122) return String.fromCodePoint(low + c - 97);
  if (dig != null && c >= 48 && c <= 57) return String.fromCodePoint(dig + c - 48);
  return ch;
};
const circled = (ch) => {
  const c = ch.codePointAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(0x24b6 + c - 65);
  if (c >= 97 && c <= 122) return String.fromCodePoint(0x24d0 + c - 97);
  if (c === 48) return '⓪';
  if (c >= 49 && c <= 57) return String.fromCodePoint(0x2460 + c - 49);
  return ch;
};
export const FANCY_STYLES = [
  ['ꜱᴍᴀʟʟ ᴄᴀᴘs', (ch) => SMALL_CAPS[ch.toLowerCase()] || ch],
  ['𝐁𝐨𝐥𝐝', alpha(0x1d400, 0x1d41a, 0x1d7ce)],
  ['𝐼𝑡𝑎𝑙𝑖𝑐', alpha(0x1d434, 0x1d44e, null, { h: 'ℎ' })],
  ['𝑩𝒐𝒍𝒅 𝑰𝒕𝒂𝒍𝒊𝒄', alpha(0x1d468, 0x1d482, null)],
  ['𝒮𝒸𝓇𝒾𝓅𝓉', alpha(0x1d49c, 0x1d4b6, null, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' })],
  ['𝔻𝕠𝕦𝕓𝕝𝕖', alpha(0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' })],
  ['𝙼𝚘𝚗𝚘', alpha(0x1d670, 0x1d68a, 0x1d7f6)],
  ['𝗦𝗮𝗻𝘀 𝗕𝗼𝗹𝗱', alpha(0x1d5d4, 0x1d5ee, 0x1d7ec)],
  ['Ⓒⓘⓡⓒⓛⓔ', circled],
  ['Ｆｕｌｌｗｉｄｔｈ', alpha(0xff21, 0xff41, 0xff10)],
];
export const fancyAll = (text) => FANCY_STYLES.map(([name, fn]) => [name, [...String(text)].map(fn).join('')]);

/* ───────── utilitaires réseau ───────── */
// Les liens renvoyés par des API tierces ne sont jamais suivis s'ils pointent vers un réseau interne.
export const isPublicHttps = (u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h.startsWith('[')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    return true;
  } catch {
    return false;
  }
};
const execFileP = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30_000, ...opts }, (err) => (err ? reject(err) : resolve())));

export async function loadSettings(dir) {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    for (const k of BOOL_KEYS) if (typeof raw[k] === 'boolean') s[k] = raw[k];
    if (raw.mode === 'public' || raw.mode === 'private') s.mode = raw.mode;
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


  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const getJson = async (url, ms = 25_000) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  };
  const remoteSize = async (url) => {
    try {
      const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      const n = Number(r.headers.get('content-length'));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  /* ───────── .pinterest ───────── */
  async function pinterest(q, { reply, jid, m }) {
    if (!q) return reply(box('📌 *PINTEREST*', [`Usage : *${P()}pinterest <lien>*`, 'Lien pinterest.com ou pin.it']));
    let host = '';
    try {
      host = new URL(q.trim()).hostname.toLowerCase();
    } catch {
      /* lien invalide */
    }
    if (!/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(host)) return reply(box('❌ *PINTEREST*', ['Lien invalide : utilisez un lien pinterest.com ou pin.it.']));
    react(jid, m, '⏳');
    const data = await getJson(`https://jawad-tech.vercel.app/download/pinterest?url=${encodeURIComponent(q.trim())}`);
    const r = data?.result;
    if (!data?.status || !r?.url || !isPublicHttps(r.url)) {
      react(jid, m, '❌');
      return reply(box('❌ *PINTEREST*', ['Impossible de récupérer ce média.', 'Vérifiez le lien et réessayez.']));
    }
    if ((await remoteSize(r.url)) > MAX_MEDIA_BYTES) return reply(box('❌ *PINTEREST*', ['Fichier trop gros (max 100 MB).']));
    const isVideo = r.type === 'video' || /\.mp4(\?|$)/i.test(r.url);
    const caption = box('📌 *PINTEREST*', [`Titre : *${String(r.title || '—').slice(0, 80)}*`, `Type  : *${isVideo ? 'Vidéo' : 'Image'}*`]);
    await send(jid, isVideo ? { video: { url: r.url }, mimetype: 'video/mp4', caption } : { image: { url: r.url }, caption }, m, true);
    react(jid, m, '✅');
  }

  /* ───────── .video (YouTube) ───────── */
  async function ytVideo(q, { reply, jid, m }) {
    if (!q) return reply(box('🎥 *VIDEO*', [`Usage : *${P()}video <nom ou lien YouTube>*`, `Exemple : *${P()}video perfect ed sheeran*`]));
    let yts;
    try {
      const mod = await import('yt-search');
      yts = mod.default || mod;
    } catch {
      return reply(box('❌ *VIDEO*', ['Module yt-search non installé sur le serveur.']));
    }
    react(jid, m, '🔍');
    const id = q.match(/(?:youtu\.be\/|youtube\.com\/shorts\/|[?&]v=)([A-Za-z0-9_-]{11})/)?.[1];
    let v;
    if (id) v = await yts({ videoId: id });
    else v = (await yts(q)).videos?.[0];
    if (!v) return reply(box('❌ *VIDEO*', ['Aucune vidéo trouvée.']));
    if (toNum(v.seconds) > MAX_VIDEO_SECONDS) return reply(box('❌ *VIDEO*', ['Vidéo trop longue (max 30 minutes).']));
    const thumb = v.thumbnail || v.image;
    const info = box('🎥 *YOUTUBE VIDEO*', [
      `Titre  : *${String(v.title || '').slice(0, 90)}*`,
      `Chaîne : *${v.author?.name || '—'}*`,
      `Durée  : *${v.timestamp || '—'}*`,
      `Vues   : *${Number(v.views || 0).toLocaleString('fr-FR')}*`,
      'Préparation du fichier…',
    ]);
    if (thumb && isPublicHttps(thumb)) await send(jid, { image: { url: thumb }, caption: info }, m, true);
    else await reply(info);
    react(jid, m, '⏳');

    let dl = null;
    for (let i = 0; i < 3 && !dl; i++) {
      try {
        const d = await getJson(`https://jawad-tech.vercel.app/download/ytdl?url=${encodeURIComponent(v.url)}`, 20_000);
        if (d?.status === true && d.result?.mp4 && isPublicHttps(d.result.mp4)) dl = d.result;
      } catch {
        /* nouvel essai */
      }
      if (!dl && i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!dl) {
      react(jid, m, '❌');
      return reply(box('❌ *VIDEO*', ['Lien de téléchargement indisponible.', 'Réessayez plus tard.']));
    }
    if ((await remoteSize(dl.mp4)) > MAX_MEDIA_BYTES) return reply(box('❌ *VIDEO*', ['Fichier trop gros (max 100 MB).']));
    await send(jid, { video: { url: dl.mp4 }, mimetype: 'video/mp4', caption: box('✅ *VIDEO*', [String(dl.title || v.title || '').slice(0, 90)]) }, m, true);
    react(jid, m, '✅');
  }

  /* ───────── .telegram : pack de stickers Telegram → WhatsApp ───────── */
  let tgBusy = false;
  async function tgStickers(args, { reply, jid, m }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return reply(box('❌ *STICKERS*', ['TELEGRAM_BOT_TOKEN absent côté serveur.']));
    const pack = (args[0] || '').match(/^https:\/\/t\.me\/addstickers\/([A-Za-z0-9_]{1,64})$/i)?.[1];
    if (!pack) return reply(box('📦 *TELEGRAM STICKERS*', [`Usage : *${P()}telegram <lien> [nom du pack]*`, 'Exemple : https://t.me/addstickers/NomDuPack Mon pack']));
    if (tgBusy) return reply(box('⏳ *STICKERS*', ['Un pack est déjà en cours d\'envoi.']));
    let webp;
    try {
      const mod = await import('node-webpmux');
      webp = mod.default || mod;
    } catch {
      return reply(box('❌ *STICKERS*', ['Module node-webpmux non installé sur le serveur.']));
    }
    const label = args.slice(1).join(' ').trim().slice(0, 40) || 'Stickers';
    const ffmpeg = await execFileP('ffmpeg', ['-version'], { timeout: 5000 }).then(() => true, () => false);
    tgBusy = true;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stk-'));
    try {
      const set = await getJson(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(pack)}`);
      const all = set?.result?.stickers;
      if (!set?.ok || !Array.isArray(all) || !all.length) return reply(box('❌ *STICKERS*', ['Pack introuvable.']));
      const list = all.slice(0, MAX_STICKERS);
      await reply(box('📦 *TELEGRAM STICKERS*', [`Stickers : *${list.length}*${all.length > list.length ? ` (sur ${all.length}, max ${MAX_STICKERS})` : ''}`, `Pack    : *${label}*`, 'Envoi en cours…']));
      let ok = 0;
      let failed = 0;
      for (const [i, st] of list.entries()) {
        try {
          if (st.is_animated) throw new Error('animated');
          const info = await getJson(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(st.file_id)}`);
          if (!info?.ok || !info.result?.file_path) throw new Error('getFile');
          const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`, { signal: AbortSignal.timeout(25_000) });
          if (!res.ok) throw new Error('download');
          let buf = Buffer.from(await res.arrayBuffer());
          if (st.is_video) {
            if (!ffmpeg) throw new Error('ffmpeg');
            const inP = path.join(tmp, `${i}.webm`);
            const outP = path.join(tmp, `${i}.webp`);
            await fs.writeFile(inP, buf);
            const vf = 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0';
            const enc = ['-vf', vf, '-c:v', 'libwebp', '-loop', '0', '-pix_fmt', 'yuva420p', '-quality', '70', '-an', '-t', '8', outP];
            try {
              await execFileP('ffmpeg', ['-y', '-c:v', 'libvpx-vp9', '-i', inP, ...enc]);
            } catch {
              await execFileP('ffmpeg', ['-y', '-i', inP, ...enc]);
            }
            buf = await fs.readFile(outP);
          }
          const img = new webp.Image();
          await img.load(buf);
          const meta = { 'sticker-pack-id': crypto.randomBytes(16).toString('hex'), 'sticker-pack-name': label, emojis: st.emoji ? [st.emoji] : ['🤖'] };
          const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
          const json = Buffer.from(JSON.stringify(meta), 'utf8');
          const exif = Buffer.concat([head, json]);
          exif.writeUIntLE(json.length, 14, 4);
          img.exif = exif;
          await send(jid, { sticker: await img.save(null) }, m, true);
          ok++;
        } catch (e) {
          failed++;
          log('warn', 'wa sticker failed', { why: String(e?.message || 'error').slice(0, 40) });
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      await reply(box('✅ *STICKERS*', [`Envoyés : *${ok}/${list.length}*`, `Échecs  : *${failed}*`, failed ? 'Les stickers animés (.tgs) ne sont pas pris en charge.' : 'Terminé !']));
    } finally {
      tgBusy = false;
      fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ───────── .jid ───────── */
  async function jidInfo({ jid, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    const me = ownJid();
    const lid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : 'non détecté';
    if (jid.endsWith('@g.us')) return reply(box('🏠 *GROUP JID*', [`ID : \`${jid}\``]));
    const lines = [`Chat : \`${jid}\``];
    if (ci?.participant) lines.push(`Cible : \`${ci.participant}\``);
    lines.push(`Moi JID : \`${me || '—'}\``, `Moi LID : \`${lid}\``);
    return reply(box('🆔 *USER DETAILS*', lines));
  }

  /* ───────── .fancy ───────── */
  async function fancy(q, reply) {
    if (!q) return reply(box('✨ *FANCY*', [`Usage : *${P()}fancy <texte>*`, '10 styles d\'écriture.']));
    const text = q.slice(0, 120);
    return reply(box('✨ *FANCY TEXT*', fancyAll(text).map(([name, out], i) => `${i + 1}. ${out}`)));
  }


  /* ───────── .mode ───────── */
  async function setMode(arg, reply) {
    const v = String(arg || '').toLowerCase();
    if (v !== 'public' && v !== 'private') {
      return reply(box('🌐 *MODE*', [
        `Statut : *${settings.mode.toUpperCase()}*`,
        'public  : les autres utilisent les commandes publiques',
        'private : vous seul',
        `Usage : *${P()}mode public* ou *${P()}mode private*`,
      ]));
    }
    settings.mode = v;
    await saveSettings(authDir, settings);
    return reply(box('🌐 *MODE*', [
      `Mode : *${v.toUpperCase()}* ✅`,
      v === 'public'
        ? `Accessible à tous : ${[...PUBLIC_CMDS].map((c) => P() + c).join(' ')}`
        : 'Seul le propriétaire peut utiliser le bot.',
    ]));
  }

  /* ───────── contrôle d'accès des autres utilisateurs (mode public) ───────── */
  const guests = new Map(); // expéditeur -> { times: number[], heavyAt: number, warnedAt: number }
  let heavyActive = 0;
  function guestCheck(cmd, sender, now = Date.now()) {
    const name = CMD_ALIASES[cmd] || cmd;
    const known = PUBLIC_CMDS.has(name);
    if (!known) return { status: COMMANDS.has(cmd) || OWNER_ONLY_BASE.has(cmd) ? 'owner_only' : 'ignore' };
    let g = guests.get(sender);
    if (!g) {
      g = { times: [], heavyAt: 0, warnedAt: 0 };
      guests.set(sender, g);
      if (guests.size > 500) for (const [k, v] of guests) if (!v.times.some((t) => now - t < GUEST_WINDOW_MS)) guests.delete(k);
    }
    g.times = g.times.filter((t) => now - t < GUEST_WINDOW_MS);
    const slow = (wait) => {
      const notify = now - g.warnedAt > 15_000;
      if (notify) g.warnedAt = now;
      return { status: 'slow', wait: Math.max(1, Math.ceil(wait / 1000)), notify };
    };
    if (g.times.length >= GUEST_MAX_PER_WINDOW) return slow(GUEST_WINDOW_MS - (now - g.times[0]));
    const heavy = HEAVY_CMDS.has(name);
    if (heavy) {
      if (now - g.heavyAt < GUEST_HEAVY_COOLDOWN_MS) return slow(GUEST_HEAVY_COOLDOWN_MS - (now - g.heavyAt));
      if (heavyActive >= GUEST_MAX_HEAVY_PARALLEL) return { status: 'busy' };
      g.heavyAt = now;
      heavyActive++;
    }
    g.times.push(now);
    let released = !heavy;
    return { status: 'ok', release: () => { if (!released) { released = true; heavyActive--; } } };
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
    const name = CMD_ALIASES[cmd] || ALIASES[cmd] || cmd;
    try {
      if (name === 'apk') return await apk(q, { reply, jid, m });
      if (name === 'unblock') return await unblock({ jid, content, reply });
      if (name === 'save') return await saveStatus({ jid, content, reply, requireStatus: false });
      if (name === 'setprefix') return await setPrefix(args[0], reply);
      if (name === 'mode') return await setMode(args[0], reply);
      if (name === 'pinterest') return await pinterest(q, { reply, jid, m });
      if (name === 'video') return await ytVideo(q, { reply, jid, m });
      if (name === 'telegram') return await tgStickers(args, { reply, jid, m });
      if (name === 'jid') return await jidInfo({ jid, content, reply });
      if (name === 'fancy') return await fancy(q, reply);
      if (INFO[name]) return await toggle(name, cmd, args[0], reply);
    } catch (e) {
      log('warn', 'wa command failed', { cmd: name, err: String(e?.message || 'error').slice(0, 80) });
      react(jid, m, '❌');
      await reply(box('⚠️ *ERREUR*', [`La commande ${P()}${name} a échoué.`, 'Réessayez dans un instant.'])).catch(() => {});
    }
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

  return { settings, has: (cmd) => COMMANDS.has(cmd), guestCheck, handleCommand, saveFromStatus, onIncoming, onCalls, onGroupUpdate };
}
