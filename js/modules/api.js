import { logger } from '../utils/logger.js';

export const api = {
  _endpoint: null,
  _reachable: null,

  configure(endpoint) {
    this._endpoint = endpoint;
    this._reachable = null;
  },

  async isReachable() {
    if (this._reachable !== null) return this._reachable;
    if (!this._endpoint) return (this._reachable = false);
    try {
      const healthUrl = this._endpoint.replace(/\/code\/validate.*$/, '/health');
      const resp = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      this._reachable = resp.ok;
    } catch {
      this._reachable = false;
    }
    return this._reachable;
  },

  async validateCode(code, studentId, courseId) {
    try {
      const resp = await fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, studentId, courseId }),
        signal: AbortSignal.timeout(5000)
      });
      const body = await resp.json().catch(() => ({}));
      return { ...body, fromServer: true };
    } catch (e) {
      logger.warn('API.validateCode error', e.message);
      return { valid: false, error: 'CONNECTION_ERROR', fromServer: false };
    }
  },

  async saveProgress(studentId, courseId, progressState) {
    if (!this._endpoint) return { success: false };
    try {
      const url = this._endpoint.replace(/\/code\/validate.*$/, '/progress/save');
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, courseId, progressState }),
        signal: AbortSignal.timeout(10000)
      });
      return { success: resp.ok };
    } catch (e) {
      logger.warn('API.saveProgress error', e.message);
      return { success: false };
    }
  },

  async loadProgress(studentId, courseId) {
    if (!this._endpoint) return null;
    try {
      const url = this._endpoint.replace(/\/code\/validate.*$/, '/progress/load');
      const resp = await fetch(`${url}?studentId=${studentId}&courseId=${courseId}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return null;
      const body = await resp.json();
      return body.progressState ?? null;
    } catch (e) {
      logger.warn('API.loadProgress error', e.message);
      return null;
    }
  }
};
