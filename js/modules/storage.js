import { logger } from '../utils/logger.js';

const PRIMARY_PREFIX = 'kodland_progress_';
const BACKUP_PREFIX  = 'kodland_backup_';

export const storage = {
  save(studentId, data) {
    try {
      const payload = { data, savedAt: new Date().toISOString(), version: '1.0' };
      localStorage.setItem(PRIMARY_PREFIX + studentId, JSON.stringify(payload));
      this._saveBackup(studentId, data);
      return true;
    } catch (e) {
      logger.error('Storage.save failed', e.message);
      return false;
    }
  },

  load(studentId) {
    try {
      const raw = localStorage.getItem(PRIMARY_PREFIX + studentId);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!this._isValid(payload)) {
        logger.warn('Storage: primary corrupted, trying backup');
        return this._loadBackup(studentId);
      }
      return payload.data;
    } catch (e) {
      logger.error('Storage.load failed', e.message);
      return this._loadBackup(studentId);
    }
  },

  clear(studentId) {
    localStorage.removeItem(PRIMARY_PREFIX + studentId);
    try { sessionStorage.removeItem(BACKUP_PREFIX + studentId); } catch (_) {}
  },

  _saveBackup(studentId, data) {
    try {
      sessionStorage.setItem(BACKUP_PREFIX + studentId, JSON.stringify({ data, savedAt: new Date().toISOString() }));
    } catch (_) {}
  },

  _loadBackup(studentId) {
    try {
      const raw = sessionStorage.getItem(BACKUP_PREFIX + studentId);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      return payload?.data ?? null;
    } catch (_) { return null; }
  },

  _isValid(payload) {
    return payload &&
      typeof payload === 'object' &&
      payload.data &&
      payload.savedAt &&
      payload.data.studentId &&
      Array.isArray(payload.data.worldsState);
  }
};
