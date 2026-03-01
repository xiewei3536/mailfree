/**
 * 結構化日誌模組
 * @module utils/logger
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * 輸出結構化 JSON 日誌
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {object} extra
 */
export function log(level, msg, extra = {}) {
  const entry = { level, msg, ts: Date.now(), ...extra };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (msg, extra) => log('debug', msg, extra),
  info: (msg, extra) => log('info', msg, extra),
  warn: (msg, extra) => log('warn', msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};

export default logger;
