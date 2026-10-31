// Moteur WhatsApp basé sur Baileys.
//
// Contrat attendu par SessionManager :
//   engine.open({ tgId, authDir, key, onEvent }) -> Promise<Handle>
//   Handle = {
//     requestPairingCode(phone): Promise<string>   // "ABCD-EFGH"
//     logout(): Promise<void>                       // délie l'appareil côté WhatsApp
//     sendSelf(text): Promise<void>                 // message dans le chat « Vous-même »
//     close(): void                                 // ferme le socket, bloque toute écriture disque
//   }
//   onEvent({ type: 'open' })
//   onEvent({ type: 'close', reason: 'logged_out'|'bad_session'|'forbidden'|'restart_required'|'replaced'|'other', code })
//
// Messages : seules les commandes ÉCRITES PAR le propriétaire du compte (fromMe) sont exécutées,
// dans la liste fermée de wa-menu.js / wa-extras.js. Le contenu des messages des autres personnes
// n'est jamais lu (seules des métadonnées servent aux réglages auto-read / présence).
// (L'ancien code exécutait des commandes arbitraires, dont un `eval`, sur les comptes : supprimé.)
//
// ⚠️ Ce fichier n'a pas pu être exécuté contre les serveurs WhatsApp pendant sa rédaction
// (réseau de l'environnement de build bloqué) : voir README, étape « premier test réel ».

import { readFile } from 'node:fs/promises';
import { useEncryptedAuthState } from './crypto-store.js';
import { silentBaileysLogger } from './util.js';
import { createExtras } from './wa-extras.js';

const CODE_BY_NUMBER = {
  401: 'logged_out',
  500: 'bad_session',
  403: 'forbidden',
  515: 'restart_required',
  440: 'replaced',
};

export async function createBaileysEngine() {
  const mod = await import('@whiskeysockets/baileys');
  const makeWASocket = typeof mod.default === 'function' ? mod.default : mod.makeWASocket;
  const {
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    BufferJSON,
    initAuthCreds,
    proto,
    jidNormalizedUser,
    normalizeMessageContent,
    downloadMediaMessage,
  } = mod;

  const logger = silentBaileysLogger();
  const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

  // Image du menu (menu.jpg à côté des fichiers .js). Absente → menu en texte seul.
  let menuImage = null;
  try {
    menuImage = await readFile(new URL('./menu.jpg', import.meta.url));
  } catch {
    log('warn', 'menu.jpg introuvable : menu envoyé sans image');
  }
  const isMenuText = (t) => typeof t === 'string' && t.startsWith('╭━━━⟦');

  // Les messages du bot apparaissent comme « transférés » depuis la chaîne WhatsApp (bouton « Voir la chaîne »).
  const forwarded = {
    isForwarded: true,
    forwardingScore: 999,
    forwardedNewsletterMessageInfo: {
      newsletterJid: process.env.CHANNEL_JID || '120363409975095814@newsletter',
      newsletterName: process.env.CHANNEL_NAME || 'NEXORA MD',
      serverMessageId: 143,
    },
  };

  /** content : texte (string) ou objet Baileys. plain = true → sans habillage « chaîne » (médias, fichiers). */
  const sendMsg = async (sock, jid, content, quoted, plain = false) => {
    const opts = quoted ? { quoted } : undefined;
    let msg = typeof content === 'string' ? { text: content } : { ...content };
    if (menuImage && typeof content === 'string' && isMenuText(content) && content.length <= 3500) {
      msg = { image: menuImage, caption: content };
    }
    if (plain) return sock.sendMessage(jid, msg, opts);
    try {
      return await sock.sendMessage(jid, { ...msg, contextInfo: { ...(msg.contextInfo || {}), ...forwarded } }, opts);
    } catch (e) {
      log('warn', 'envoi avec habillage chaîne refusé, nouvel essai simple', { err: e?.message || 'error' });
      return sock.sendMessage(jid, msg, opts);
    }
  };

  return {
    async open({ authDir, key, onEvent, onCommand }) {
      const store = await useEncryptedAuthState(authDir, key, { BufferJSON, initAuthCreds, proto });

      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        /* on garde la version par défaut de la librairie */
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger,
        printQRInTerminal: false,
        auth: {
          creds: store.state.creds,
          keys: makeCacheableSignalKeyStore(store.state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'), // nom affiché dans « Appareils connectés »
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
      });

      const send = (jid, content, quoted, plain) => sendMsg(sock, jid, content, quoted, plain);
      const extras = await createExtras({
        sock,
        authDir,
        send,
        log,
        helpers: { downloadMediaMessage, normalizeMessageContent, jidNormalizedUser, logger },
      });

      let readyResolve;
      const ready = new Promise((r) => { readyResolve = r; });

      sock.ev.on('creds.update', () => {
        store.saveCreds().catch(() => {});
      });

      sock.ev.on('connection.update', (u) => {
        if (u.connection) log('info', 'wa connection', { connection: u.connection, code: u.lastDisconnect?.error?.output?.statusCode });
        if (u.qr) readyResolve(); // le socket est prêt à demander un code de jumelage
        if (u.connection === 'open') onEvent({ type: 'open' });
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          onEvent({ type: 'close', reason: CODE_BY_NUMBER[code] || 'other', code });
        }
      });

      sock.ev.on('call', (calls) => {
        extras.onCalls(calls).catch(() => {});
      });
      sock.ev.on('group-participants.update', (u) => {
        extras.onGroupUpdate(u).catch(() => {});
      });

      // Commandes : uniquement les messages ÉCRITS PAR le propriétaire du compte (fromMe), dans
      // n'importe quel chat. Les réponses du bot ne commencent jamais par le préfixe → pas de boucle.
      const tsOf = (m) => {
        const t = m.messageTimestamp;
        if (t == null) return 0;
        return typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
      };
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!onCommand) return;
        for (const m of messages || []) {
          try {
            if (!m.message) continue;
            if (!m.key?.fromMe) {
              await extras.onIncoming(m, type); // métadonnées seulement (lu, présence, statuts)
              continue;
            }
            const jid = m.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            // messages synchronisés (append) : on ignore les anciens pour ne rien rejouer au redémarrage
            if (type !== 'notify' && Date.now() / 1000 - tsOf(m) > 60) continue;
            const content = (normalizeMessageContent ? normalizeMessageContent(m.message) : null) || m.message;
            const text = String(content.conversation || content.extendedTextMessage?.text || '').trim();
            if (!text) continue;
            const reply = (c) => send(jid, c, m);

            // « save » / « send » / « sendme » en réponse à un statut
            if (['save', 'send', 'sendme'].includes(text.toLowerCase())) {
              if (await extras.saveFromStatus({ jid, content, reply })) log('info', 'wa status save', { type });
              continue;
            }

            // préfixe courant ; « .setprefix » reste toujours utilisable (secours si on oublie le préfixe)
            const prefix = extras.settings.prefix;
            const used = text.startsWith(prefix) ? prefix : /^\.setprefix(\s|$)/i.test(text) ? '.' : null;
            if (!used) continue;
            const [rawCmd = '', ...rest] = text.slice(used.length).split(/\s+/);
            const cmd = rawCmd.toLowerCase();
            if (!cmd) continue;
            const args = rest.filter(Boolean);

            if (extras.has(cmd)) {
              log('info', 'wa command', { cmd, known: true, type });
              await extras.handleCommand({ cmd, args, q: args.join(' '), jid, m, content, reply });
              continue;
            }
            const out = await onCommand(text, { prefix: used });
            log('info', 'wa command', { cmd, known: Boolean(out), type });
            if (out) await reply(out);
          } catch (e) {
            // une commande qui échoue ne doit jamais casser la session
            log('warn', 'wa command failed', { err: e?.message || 'error' });
          }
        }
      });

      let closed = false;
      return {
        async sendSelf(text) {
          const me = sock.user?.id;
          if (me) await send(jidNormalizedUser(me), text, null);
        },
        async requestPairingCode(phone) {
          await Promise.race([ready, new Promise((r) => setTimeout(r, 5000))]);
          if (sock.authState.creds.registered) throw new Error('déjà enregistré');
          const raw = await sock.requestPairingCode(phone);
          return String(raw).match(/.{1,4}/g)?.join('-') ?? String(raw);
        },
        async logout() {
          await sock.logout();
        },
        close() {
          if (closed) return;
          closed = true;
          store.close();
          try {
            for (const ev of ['connection.update', 'creds.update', 'messages.upsert', 'call', 'group-participants.update']) {
              sock.ev.removeAllListeners(ev);
            }
          } catch { /* ignore */ }
          try { sock.end(undefined); } catch { /* ignore */ }
        },
      };
    },
  };
}
