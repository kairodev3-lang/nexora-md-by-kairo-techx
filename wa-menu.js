// Commandes WhatsApp texte (préfixe « . » par défaut, modifiable avec .setprefix).
// Elles ne répondent QU'AUX messages écrits par le propriétaire du compte lié
// (voir engine-baileys.js). Liste fermée : aucune commande dynamique, aucun eval.

export const PREFIX = '.';

const DEFAULT_BRAND = {
  botName: 'NEXORA MD',
  ownerName: 'KAIRO',
  ownerNumber: '+50939360237',
  ownerTg: '',
  ownerWa: 'https://wa.me/50939360237',
  channelLink: 'https://whatsapp.com/channel/0029VbDmi1g77qVOA4cfRq13',
};

// Source unique de la liste des commandes (menu + compteur de .alive).
export const SECTIONS = [
  { title: '🏠 GENERAL', bullet: '✧', cmds: ['menu', 'help', 'owner'] },
  { title: '⚡ SESSION', bullet: '◈', cmds: ['alive', 'ping', 'runtime', 'status'] },
  { title: '📥 DOWNLOAD', bullet: '⌁', cmds: ['apk', 'video', 'pinterest', 'telegram'] },
  { title: '🧰 TOOLS', bullet: '✧', cmds: ['fancy', 'jid'] },
  { title: '🛠️ OWNER TOOLS', bullet: '◈', cmds: ['unblock', 'save', 'pair', 'depair'] },
  {
    title: '⚙️ SETTINGS',
    bullet: '⌁',
    cmds: ['autorecording', 'autotyping', 'anticall', 'welcome', 'goodbye', 'autoread', 'autoviewstatus', 'autolikestatus', 'setprefix'],
  },
];
export const COMMAND_COUNT = SECTIONS.reduce((n, s) => n + s.cmds.length, 0);

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m ${s % 60}s`;
}

/** Texte en gras mathématique (𝐏𝐎𝐖𝐄𝐑𝐄𝐃) pour la signature. */
export function boldUnicode(str) {
  return [...String(str)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d400 + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d41a + c - 97);
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ce + c - 48);
      return ch;
    })
    .join('');
}

const LINE_END = '└━━━━━━━━━━━━━━━━━━';

/** Petit cadre commun à toutes les réponses : ┌─『 titre 』 │ ✧ ligne … └━━━ */
export function box(title, lines, bullet = '✧') {
  return [`┌─『 ${title} 』`, ...lines.map((l) => `│ ${bullet} ${l}`), LINE_END].join('\n');
}

export function signature(b = DEFAULT_BRAND) {
  return `⟦ ${boldUnicode('POWERED BY')} ${boldUnicode(`${b.ownerName} DEV`.toUpperCase())} ⟧`;
}

export function buildMenu(ctx = {}) {
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const P = ctx.prefix || PREFIX;
  const now = ctx.now ?? Date.now();
  const up = ctx.startedAt ? fmtDuration(now - ctx.startedAt) : '—';
  const out = [
    `╭━━━⟦ *${b.botName}* ⟧━━━╮`,
    `┃ ▸ Bot      : ${b.botName}`,
    `┃ ▸ Owner    : ${b.ownerName}`,
    `┃ ▸ Prefix   : ${P}`,
    `┃ ▸ Commands : ${COMMAND_COUNT}`,
    `┃ ▸ Runtime  : ${up}`,
    '╰━━━━━━━━━━━━━━━━━━╯',
  ];
  for (const s of SECTIONS) {
    out.push('', box(`*${s.title}*`, s.cmds.map((c) => `${P}${c}`), s.bullet));
  }
  out.push('', signature(b));
  return out.join('\n');
}

/** @returns {string|null} texte de réponse, ou null si ce n'est pas une commande connue. */
export function handleWaCommand(text, ctx = {}) {
  const P = ctx.prefix || PREFIX;
  const t = String(text || '').trim();
  if (!t.startsWith(P)) return null;
  const cmd = t.slice(P.length).split(/\s+/)[0].toLowerCase();
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const now = ctx.now ?? Date.now();
  const since = (v) => (v ? fmtDuration(now - v) : '—');

  switch (cmd) {
    case 'menu':
    case 'help':
      return buildMenu(ctx);
    case 'ping':
      return box('🏓 *PING*', [`Pong ! ${ctx.latencyMs != null ? `${ctx.latencyMs} ms` : '✅'}`]);
    case 'alive':
      return `${box('🟢 *ALIVE*', [
        `Bot      : *${b.botName}*`,
        'Status   : *Online* ✅',
        `Owner    : *${b.ownerName}*`,
        `Prefix   : *${P}*`,
        `Commands : *${COMMAND_COUNT}*`,
        `Uptime   : *${since(ctx.startedAt)}*`,
      ])}\n\n${signature(b)}`;
    case 'runtime':
      return box('⏱️ *RUNTIME*', [`Service : ${since(ctx.startedAt)}`, `Session : ${since(ctx.sessionSince)}`]);
    case 'status':
      return box('📡 *SESSION*', ['État : 🟢 connectée', `Depuis : ${since(ctx.sessionSince)}`]);
    case 'owner':
      return box(
        '👑 *OWNER*',
        [
          `Created by : ${b.ownerName}`,
          `Numéro : ${b.ownerNumber}`,
          b.ownerTg ? `Telegram : ${b.ownerTg}` : null,
          b.ownerWa ? `WhatsApp : ${b.ownerWa}` : null,
          b.channelLink ? `Chaîne : ${b.channelLink}` : null,
        ].filter(Boolean),
      );
    default:
      return null; // commande inconnue : silence
  }
}
