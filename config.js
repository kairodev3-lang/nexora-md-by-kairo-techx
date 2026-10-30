import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(env = process.env) {
  const apiKey = env.API_KEY || '';
  if (apiKey.length < 24) {
    throw new Error('API_KEY manquante ou trop courte (24 caractères minimum). Générez-la avec : openssl rand -hex 24');
  }
  const encHex = env.SESSION_ENC_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(encHex)) {
    throw new Error('SESSION_ENC_KEY invalide : 64 caractères hexadécimaux requis. Générez-la avec : openssl rand -hex 32');
  }
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    apiKey,
    encKey: Buffer.from(encHex, 'hex'),
    sessionsDir: path.resolve(env.SESSIONS_DIR || path.join(root, 'data', 'sessions')),
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    brand: {
      botName: env.BOT_NAME || 'NEXORA MD',
      ownerName: env.OWNER_NAME || 'KAIRO',
      ownerNumber: env.OWNER_NUMBER || '+50939360237',
      ownerTg: env.OWNER_TG || '',
      ownerWa: env.OWNER_WA || 'https://wa.me/50939360237',
    },
    maxSessions: int(env.MAX_SESSIONS, 200),
    pairingTtlMs: int(env.PAIRING_TTL_SEC, 180) * 1000,
  };
}
