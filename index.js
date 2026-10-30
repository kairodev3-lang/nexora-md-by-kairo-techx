import { loadConfig } from './config.js';
import { createLogger } from './util.js';
import { createTelegramNotifier } from './notifier.js';
import { createBaileysEngine } from './engine-baileys.js';
import { SessionManager } from './sessions.js';
import { createHttpServer } from './server.js';

const logger = createLogger(process.env.LOG_LEVEL || 'info');

let config;
try {
  config = loadConfig();
} catch (e) {
  logger.error('configuration invalide', { err: e.message });
  process.exit(1);
}

const engine = await createBaileysEngine();
const notifier = createTelegramNotifier({ token: config.telegramToken, logger });
const manager = new SessionManager({ config, engine, notifier, logger });
const server = createHttpServer({ config, manager, logger });

server.listen(config.port, config.host, () => {
  logger.info('NEXORA MD backend prêt', { port: config.port, notifications: notifier.enabled });
  manager.restoreAll().catch((e) => logger.error('restoreAll failed', { err: e.message }));
});

const stop = async (sig) => {
  logger.info('arrêt', { sig });
  await manager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

// Un état inattendu vaut mieux qu'un processus à moitié cassé : on journalise puis on laisse
// le superviseur (Docker restart / PM2 / Pterodactyl) relancer ; les sessions sont restaurées au boot.
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err?.message });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection', { err: err?.message || String(err) });
});
