// Gestionnaire de sessions WhatsApp multi-utilisateurs.
//
// Règles d'isolation :
//  - la clé d'une session est le tg_id Telegram (jamais le numéro) ;
//  - un utilisateur ne peut lire / modifier / supprimer QUE sa propre session ;
//  - un numéro ne peut être lié qu'à un seul utilisateur Telegram à la fois ;
//  - chaque session a son dossier chiffré avec sa propre clé dérivée.
//
// Le moteur WhatsApp (Baileys) est injecté : voir engine-baileys.js pour le contrat.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, maskPhone, withTimeout, sleep } from './util.js';
import { deriveKey, sealJson, unsealJson } from './crypto-store.js';
import { buildMenu, handleWaCommand } from './wa-menu.js';

const PHONE_RE = /^[1-9]\d{7,14}$/;
const TG_RE = /^[1-9]\d{0,14}$/;
const RE_PAIR_COOLDOWN_MS = 20_000;

export function normalizeTgId(v) {
  const s = String(v ?? '').trim();
  if (!TG_RE.test(s)) throw new ApiError('BAD_TG_ID', 400, 'Identifiant Telegram invalide.');
  return s;
}

export function normalizePhone(v) {
  const s = String(v ?? '').replace(/[\s().+-]/g, '');
  if (!PHONE_RE.test(s)) {
    throw new ApiError(
      'BAD_PHONE',
      400,
      'Numéro invalide. Utilisez le format international sans « + » ni « 0 » initial (ex. 50937000000).',
    );
  }
  return s;
}

export class SessionManager {
  constructor({ config, engine, notifier, logger, backoffBaseMs = 2000, backoffMaxMs = 60_000, welcomeDelayMs = 2500 }) {
    this.welcomeDelayMs = welcomeDelayMs;
    this.startedAt = Date.now();
    this.config = config;
    this.engine = engine;
    this.notifier = notifier;
    this.logger = logger;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.sessions = new Map(); // tgId -> session
    this.locks = new Map();
    this.closing = false;
  }

  /* ─────────────── helpers ─────────────── */

  dir(tgId) {
    return path.join(this.config.sessionsDir, tgId);
  }

  _key(tgId) {
    return deriveKey(this.config.encKey, tgId);
  }

  _lock(tgId, fn) {
    const prev = this.locks.get(tgId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(tgId, tail);
    tail.then(() => {
      if (this.locks.get(tgId) === tail) this.locks.delete(tgId);
    });
    return run;
  }

  async _writeMeta(s) {
    const dir = this.dir(s.tgId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const blob = sealJson(this._key(s.tgId), 'meta', {
      phone: s.phone,
      linked: s.linked,
      createdAt: s.createdAt,
    });
    await fs.writeFile(path.join(dir, 'meta.enc'), blob, { mode: 0o600 });
  }

  async _readMeta(tgId) {
    const blob = await fs.readFile(path.join(this.dir(tgId), 'meta.enc'));
    return unsealJson(this._key(tgId), 'meta', blob);
  }

  _notify(tgId, html) {
    this.notifier.notify(tgId, html).catch(() => {});
  }

  _clearTimers(s) {
    clearTimeout(s.pairingTimer);
    clearTimeout(s.reconnectTimer);
    s.pairingTimer = s.reconnectTimer = null;
  }

  /* ─────────────── cycle de vie d'un socket ─────────────── */

  async _openHandle(s) {
    const gen = ++s.gen;
    const handle = await this.engine.open({
      tgId: s.tgId,
      authDir: this.dir(s.tgId),
      key: this._key(s.tgId),
      onEvent: (e) => this._onEvent(s, gen, e),
      onCommand: (text, extra = {}) =>
        handleWaCommand(text, { brand: this.config.brand, startedAt: this.startedAt, sessionSince: s.connectedAt, ...extra }),
    });
    if (s.gen !== gen || s.state === 'removed' || this.closing) {
      handle.close();
      throw new Error('session fermée pendant l\'ouverture');
    }
    s.handle = handle;
    return handle;
  }

  _onEvent(s, gen, e) {
    if (gen !== s.gen || s.state === 'removed') return; // événement d'un ancien socket
    if (e.type === 'open') return this._onOpen(s);
    if (e.type === 'close') return this._onClose(s, e);
  }

  _onOpen(s) {
    s.state = 'connected';
    s.attempts = 0;
    s.notifiedUnstable = false;
    s.connectedAt = Date.now();
    clearTimeout(s.pairingTimer);
    s.pairingTimer = null;
    s.linked = true;
    this._writeMeta(s).catch((err) => this.logger.warn('meta write failed', { err: err.message }));
    if (!s.announced) {
      s.announced = true;
      this.logger.info('session connected', { tg: s.tgId });
      // menu de bienvenue dans le chat « Vous-même » du compte qui vient d'être lié
      const t = setTimeout(() => {
        const h = s.handle;
        if (h?.sendSelf && s.state === 'connected') {
          Promise.resolve(h.sendSelf(buildMenu({ brand: this.config.brand, startedAt: this.startedAt }))).catch(() => {});
        }
      }, this.welcomeDelayMs);
      t.unref?.();
      this._notify(
        s.tgId,
        '✅ <b>WhatsApp connecté</b>\nVotre session NEXORA MD est active.\nUtilisez /status pour la vérifier, /disconnect pour la supprimer.',
      );
    }
  }

  _onClose(s, e) {
    try { s.handle?.close(); } catch { /* déjà fermé */ }
    s.handle = null;
    if (this.closing) return;

    switch (e.reason) {
      case 'restart_required': {
        // Normal juste après la saisie du code : WhatsApp impose de rouvrir le socket.
        s.linked = true;
        clearTimeout(s.pairingTimer);
        s.pairingTimer = null;
        s.state = 'connecting';
        this._writeMeta(s).catch(() => {});
        this._openHandle(s).catch((err) => {
          this.logger.warn('reopen after pairing failed', { tg: s.tgId, err: err.message });
          this._scheduleReconnect(s);
        });
        return;
      }
      case 'logged_out':
      case 'bad_session':
      case 'forbidden': {
        const wasLinked = s.linked;
        const text =
          e.reason === 'forbidden'
            ? '⛔ <b>WhatsApp a refusé la connexion</b> pour ce compte. La session a été supprimée.'
            : wasLinked
              ? '🔌 <b>Session WhatsApp fermée</b> (appareil retiré depuis WhatsApp ou session invalide). Utilisez /connect pour la relier.'
              : null;
        this.logger.info('session closed by whatsapp', { tg: s.tgId, reason: e.reason });
        this._remove(s, { notifyHtml: text }).catch(() => {});
        return;
      }
      default: {
        if (!s.linked) {
          // Le code n'a jamais été saisi : inutile de reconnecter, il faut un nouveau code.
          const text = s.state === 'pairing' ? '⌛ Le code de jumelage a expiré. Relancez /connect pour en obtenir un nouveau.' : null;
          this._remove(s, { notifyHtml: text }).catch(() => {});
          return;
        }
        this._scheduleReconnect(s, e.reason === 'replaced' ? 30_000 : undefined);
      }
    }
  }

  _scheduleReconnect(s, forcedDelayMs) {
    if (this.closing || s.state === 'removed') return;
    clearTimeout(s.reconnectTimer);
    s.state = 'reconnecting';
    s.attempts += 1;
    const delay =
      forcedDelayMs ?? Math.min(this.backoffBaseMs * 2 ** Math.min(s.attempts - 1, 10), this.backoffMaxMs);
    if (s.attempts === 6 && !s.notifiedUnstable) {
      s.notifiedUnstable = true;
      this._notify(s.tgId, '⚠️ <b>Connexion WhatsApp instable</b> : nouvelle tentative automatique en cours.');
    }
    s.reconnectTimer = setTimeout(async () => {
      if (this.closing || s.state === 'removed') return;
      s.state = 'connecting';
      try {
        await this._openHandle(s);
      } catch (err) {
        this.logger.warn('reconnect failed', { tg: s.tgId, attempt: s.attempts, err: err.message });
        this._scheduleReconnect(s);
      }
    }, delay);
    s.reconnectTimer.unref?.();
  }

  /** Supprime la session (mémoire + disque). logout = délier aussi l'appareil côté WhatsApp. */
  async _remove(s, { notifyHtml = null, logout = false } = {}) {
    if (s.state === 'removed') return;
    s.state = 'removed';
    s.gen += 1; // invalide tout événement en vol
    this._clearTimers(s);
    const handle = s.handle;
    s.handle = null;
    if (handle) {
      if (logout) {
        try { await withTimeout(handle.logout(), 8000, 'logout'); } catch { /* best effort */ }
      }
      try { handle.close(); } catch { /* déjà fermé */ }
    }
    if (this.sessions.get(s.tgId) === s) this.sessions.delete(s.tgId);
    await fs.rm(this.dir(s.tgId), { recursive: true, force: true });
    if (notifyHtml) this._notify(s.tgId, notifyHtml);
  }

  /* ─────────────── API publique ─────────────── */

  async connect(tgIdRaw, phoneRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    const phone = normalizePhone(phoneRaw);
    return this._lock(tgId, async () => {
      if (this.closing) throw new ApiError('SHUTTING_DOWN', 503, 'Service en cours de redémarrage, réessayez dans un instant.');

      const existing = this.sessions.get(tgId);
      if (existing) {
        if (existing.linked) {
          if (existing.phone === phone) {
            return { status: 'already_connected', state: existing.state, phone: maskPhone(phone) };
          }
          throw new ApiError('SESSION_EXISTS', 409, 'Vous avez déjà un numéro lié. Utilisez /disconnect avant d\'en lier un autre.');
        }
        if (Date.now() - existing.pairingAt < RE_PAIR_COOLDOWN_MS) {
          throw new ApiError('TOO_SOON', 429, 'Un code vient d\'être généré. Patientez quelques secondes avant d\'en redemander un.');
        }
        await this._remove(existing); // code précédent abandonné → on repart de zéro
      }

      for (const other of this.sessions.values()) {
        if (other.tgId !== tgId && other.phone === phone) {
          throw new ApiError('PHONE_IN_USE', 409, 'Ce numéro est déjà lié à un autre compte Telegram.');
        }
      }
      if (this.sessions.size >= this.config.maxSessions) {
        throw new ApiError('CAPACITY', 503, 'Le service est complet pour le moment. Réessayez plus tard.');
      }

      const s = {
        tgId,
        phone,
        state: 'pairing',
        linked: false,
        announced: false,
        handle: null,
        gen: 0,
        attempts: 0,
        notifiedUnstable: false,
        createdAt: Date.now(),
        pairingAt: Date.now(),
        connectedAt: null,
        pairingTimer: null,
        reconnectTimer: null,
      };
      this.sessions.set(tgId, s);

      try {
        await this._writeMeta(s);
        const handle = await this._openHandle(s);
        const code = await withTimeout(handle.requestPairingCode(phone), 30_000, 'pairing');
        s.pairingTimer = setTimeout(() => {
          if (!s.linked && s.state === 'pairing') {
            this._remove(s, { notifyHtml: '⌛ Le code de jumelage a expiré. Relancez /connect pour en obtenir un nouveau.' }).catch(() => {});
          }
        }, this.config.pairingTtlMs);
        s.pairingTimer.unref?.();
        this.logger.info('pairing code issued', { tg: tgId });
        return { status: 'pairing', code, expires_in: Math.round(this.config.pairingTtlMs / 1000), phone: maskPhone(phone) };
      } catch (err) {
        await this._remove(s).catch(() => {});
        if (err instanceof ApiError) throw err;
        this.logger.warn('pairing failed', { tg: tgId, err: err.message });
        throw new ApiError('PAIRING_FAILED', 502, 'Impossible d\'obtenir un code de jumelage WhatsApp pour le moment. Vérifiez le numéro et réessayez.');
      }
    });
  }

  status(tgIdRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    const s = this.sessions.get(tgId);
    if (!s) return { state: 'none' };
    return {
      state: s.state, // pairing | connecting | connected | reconnecting
      phone: maskPhone(s.phone),
      connected_since: s.state === 'connected' ? new Date(s.connectedAt).toISOString() : null,
    };
  }

  async disconnect(tgIdRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    return this._lock(tgId, async () => {
      const s = this.sessions.get(tgId);
      if (!s) return { found: false };
      await this._remove(s, { logout: true });
      this.logger.info('session removed by user', { tg: tgId });
      return { found: true };
    });
  }

  /** Au démarrage : rouvre toutes les sessions déjà liées, supprime les jumelages inachevés. */
  async restoreAll({ gapMs = 1500 } = {}) {
    await fs.mkdir(this.config.sessionsDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.config.sessionsDir, { withFileTypes: true });
    let restored = 0;
    for (const ent of entries) {
      if (!ent.isDirectory() || !TG_RE.test(ent.name)) continue;
      const tgId = ent.name;
      let meta;
      try {
        meta = await this._readMeta(tgId);
      } catch {
        meta = null;
      }
      if (!meta || !meta.linked || !PHONE_RE.test(String(meta.phone))) {
        await fs.rm(this.dir(tgId), { recursive: true, force: true });
        continue;
      }
      const s = {
        tgId,
        phone: String(meta.phone),
        state: 'connecting',
        linked: true,
        announced: true,
        handle: null,
        gen: 0,
        attempts: 0,
        notifiedUnstable: false,
        createdAt: meta.createdAt ?? Date.now(),
        pairingAt: 0,
        connectedAt: null,
        pairingTimer: null,
        reconnectTimer: null,
      };
      this.sessions.set(tgId, s);
      try {
        await this._openHandle(s);
      } catch (err) {
        this.logger.warn('restore failed, will retry', { tg: tgId, err: err.message });
        this._scheduleReconnect(s);
      }
      restored += 1;
      await sleep(gapMs);
    }
    this.logger.info('sessions restored', { count: restored });
    return restored;
  }

  /** Arrêt propre : ferme les sockets SANS déconnecter les appareils ni effacer les sessions. */
  async shutdown() {
    this.closing = true;
    for (const s of this.sessions.values()) {
      this._clearTimers(s);
      try { s.handle?.close(); } catch { /* ignore */ }
    }
  }
}
