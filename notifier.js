// Notifications Telegram envoyées directement par le backend (optionnel).
// Utilise l'API Bot officielle ; le token n'est jamais journalisé.

export function createTelegramNotifier({ token, fetchImpl = globalThis.fetch, logger }) {
  if (!token) {
    return { enabled: false, notify: async () => false, sendTemp: async () => false };
  }
  return {
    enabled: true,
    async notify(tgId, html) {
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(tgId),
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
        if (!res.ok) logger?.warn('telegram notify refused', { status: res.status });
        return res.ok;
      } catch (e) {
        logger?.warn('telegram notify failed', { err: e?.name || 'error' });
        return false;
      }
    },
    // Envoie un message puis le supprime automatiquement après ttlMs (ex. 10 minutes).
    async sendTemp(tgId, html, ttlMs) {
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(tgId),
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
        if (!res.ok) {
          logger?.warn('telegram sendTemp refused', { status: res.status });
          return false;
        }
        const data = await res.json();
        const messageId = data?.result?.message_id;
        if (messageId) {
          const timer = setTimeout(() => {
            fetchImpl(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: Number(tgId), message_id: messageId }),
            }).catch(() => {});
          }, ttlMs);
          timer.unref?.();
        }
        return true;
      } catch (e) {
        logger?.warn('telegram sendTemp failed', { err: e?.name || 'error' });
        return false;
      }
    },
  };
}
