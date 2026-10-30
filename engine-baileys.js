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
// Messages : seul le chat « Vous-même » du propriétaire est écouté, et uniquement pour la liste
// fermée de commandes de wa-menu.js. Aucun autre message n'est lu ni envoyé. (L'ancien code
// exécutait des commandes arbitraires, dont un `eval`, sur les comptes : supprimé.)
//
// ⚠️ Ce fichier n'a pas pu être exécuté contre les serveurs WhatsApp pendant sa rédaction
// (réseau de l'environnement de build bloqué) : voir README, étape « premier test réel ».

import { useEncryptedAuthState } from './crypto-store.js';
import { silentBaileysLogger } from './util.js';
import { readFile } from 'node:fs/promises';
import { PREFIX } from './wa-menu.js';

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
  const sendReply = async (sock, jid, text, quoted) => {
    const opts = quoted ? { quoted } : undefined;
    if (menuImage && isMenuText(text)) {
      if (text.length <= 1000) {
        await sock.sendMessage(jid, { image: menuImage, caption: text }, opts);
      } else {
        await sock.sendMessage(jid, { image: menuImage }, opts);
        await sock.sendMessage(jid, { text }, opts);
      }
      return;
    }
    await sock.sendMessage(jid, { text }, opts);
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

      let readyResolve;
      const ready = new Promise((r) => { readyResolve = r; });

      sock.ev.on('creds.update', () => {
        store.saveCreds().catch(() => {});
      });

      sock.ev.on('connection.update', (u) => {
        if (u.qr) readyResolve(); // le socket est prêt à demander un code de jumelage
        if (u.connection === 'open') onEvent({ type: 'open' });
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          onEvent({ type: 'close', reason: CODE_BY_NUMBER[code] || 'other', code });
        }
      });

      // Commandes « . » : uniquement les messages ÉCRITS PAR le propriétaire du compte (fromMe),
      // dans n'importe quel chat. Personne d'autre ne peut déclencher une commande.
      // Les réponses du bot ne commencent pas par « . » → pas de boucle.
      const tsOf = (m) => {
        const t = m.messageTimestamp;
        if (t == null) return 0;
        return typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
      };
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!onCommand) return;
        for (const m of messages || []) {
          try {
            if (!m.message || !m.key?.fromMe) continue;
            const jid = m.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            // messages synchronisés (append) : on ignore les anciens pour ne rien rejouer au redémarrage
            if (type !== 'notify' && Date.now() / 1000 - tsOf(m) > 60) continue;
            const content = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
            const text = content.conversation || content.extendedTextMessage?.text || '';
            if (!text.startsWith(PREFIX)) continue;
            const cmd = text.slice(PREFIX.length).split(/\s+/)[0].toLowerCase();
            const reply = onCommand(text);
            log('info', 'wa command', { cmd, known: Boolean(reply), type });
            if (reply) await sendReply(sock, jid, reply, m);
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
          if (me) await sendReply(sock, jidNormalizedUser(me), text, null);
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
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
          } catch { /* ignore */ }
          try { sock.end(undefined); } catch { /* ignore */ }
        },
      };
    },
  };
}
