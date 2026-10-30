// Commandes WhatsApp (préfixe ".") — répondent UNIQUEMENT dans le chat « Vous-même » du
// propriétaire du compte lié (voir engine-baileys.js). Liste fermée : aucune commande
// dynamique, aucun eval, aucune action sur d'autres conversations.

export const PREFIX = '.';

const DEFAULT_BRAND = {
  botName: 'NEXORA MD',
  ownerName: 'KAIRO',
  ownerNumber: '+50939360237',
  ownerTg: '',
  ownerWa: 'https://wa.me/50939360237',
};

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m ${s % 60}s`;
}

const FRAME_END = '╰━━━━━━━━━━━━━━━━━━⊷';

export function buildMenu(ctx = {}) {
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const now = ctx.now ?? Date.now();
  const up = ctx.startedAt ? fmtDuration(now - ctx.startedAt) : '—';
  return [
    `╭━━━⟦ *${b.botName}* ⟧━━━⊷`,
    '┃ ✧ ━━━━━━━━━━━━━━━',
    `┃ ⟡ Bot     : ${b.botName}`,
    `┃ ⟡ Prefix  : ${PREFIX}`,
    '┃ ⟡ Mode    : Self (vous seul)',
    `┃ ⟡ Runtime : ${up}`,
    '┃ ⟡ Status  : Connected',
    FRAME_END,
    '',
    '『 ✦ *WHATSAPP CONNECTION* 』',
    '╭━━━━━━━━━━━━━━━━━━⊷',
    `┃ ◈ ${PREFIX}status`,
    `┃ ◈ ${PREFIX}alive`,
    FRAME_END,
    '',
    '『 ✦ *SESSION & RUNTIME* 』',
    '╭━━━━━━━━━━━━━━━━━━⊷',
    `┃ ◈ ${PREFIX}ping`,
    `┃ ◈ ${PREFIX}runtime`,
    FRAME_END,
    '',
    '『 ✦ *HELP & SUPPORT* 』',
    '╭━━━━━━━━━━━━━━━━━━⊷',
    `┃ ◈ ${PREFIX}menu`,
    `┃ ◈ ${PREFIX}owner`,
    FRAME_END,
    '',
    `⟪ *POWERED BY ${b.botName}* ⟫`,
    '_CONNECT • CONTROL • AUTOMATE_',
    `_Created by ${b.ownerName} • Owner ${b.ownerNumber}_`,
    '',
    '_Déconnexion : commande /disconnect sur Telegram._',
  ].join('\n');
}

/** @returns {string|null} texte de réponse, ou null si ce n'est pas une commande connue. */
export function handleWaCommand(text, ctx = {}) {
  const t = String(text || '').trim();
  if (!t.startsWith(PREFIX)) return null;
  const cmd = t.slice(PREFIX.length).split(/\s+/)[0].toLowerCase();
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const now = ctx.now ?? Date.now();

  switch (cmd) {
    case 'menu':
    case 'help':
      return buildMenu(ctx);
    case 'ping':
      return `🏓 *Pong !* ${ctx.latencyMs != null ? `${ctx.latencyMs} ms` : '✅'}`;
    case 'alive':
      return `🟦 *${b.botName}* est en ligne ✅\n_CONNECT • CONTROL • AUTOMATE_`;
    case 'runtime':
      return `⏱ *Runtime*\nService : ${ctx.startedAt ? fmtDuration(now - ctx.startedAt) : '—'}\nSession : ${ctx.sessionSince ? fmtDuration(now - ctx.sessionSince) : '—'}`;
    case 'status':
      return `📡 *Session* : 🟢 connectée\n🕒 Depuis : ${ctx.sessionSince ? fmtDuration(now - ctx.sessionSince) : '—'}`;
    case 'owner':
      return [
        '👑 *OWNER*',
        `👤 Created by ${b.ownerName}`,
        `📞 ${b.ownerNumber}`,
        b.ownerTg ? `✈️ Telegram : ${b.ownerTg}` : null,
        b.ownerWa ? `💬 WhatsApp : ${b.ownerWa}` : null,
      ].filter(Boolean).join('\n');
    default:
      return null; // commande inconnue : silence
  }
}
