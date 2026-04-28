const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = 'info';

export const logger = {
  setLevel(level) { currentLevel = level; },

  debug(msg, data) { this._log('debug', msg, data); },
  info(msg, data)  { this._log('info',  msg, data); },
  warn(msg, data)  { this._log('warn',  msg, data); },
  error(msg, data) { this._log('error', msg, data); },

  _log(level, msg, data) {
    if (LEVELS[level] < LEVELS[currentLevel]) return;
    const prefix = `[Kodland][${level.toUpperCase()}]`;
    const method = level === 'debug' ? 'log' : level;
    data !== undefined ? console[method](prefix, msg, data) : console[method](prefix, msg);
  }
};
