import { logger } from '../utils/logger.js?v=2';
import { api } from './api.js?v=2';

export const codeValidator = {
  _cfg: null,
  _demoCodes: [],

  configure(config) {
    this._cfg = config.codeValidation || {};
    this._demoCodes = config.demoCodes || [];
    if (this._cfg.validateOnServer && this._cfg.serverEndpoint) {
      api.configure(this._cfg.serverEndpoint);
    }
  },

  validateFormat(code) {
    if (!code || typeof code !== 'string') return false;
    const pattern = this._cfg?.pattern ?? '^[A-Z]+-W[1-8]-[A-Z0-9]{4}$';
    return new RegExp(pattern).test(code.trim().toUpperCase());
  },

  async validate(code, studentId, courseId, usedCodes) {
    const normalized = code.trim().toUpperCase();

    if (!this.validateFormat(normalized)) {
      return { valid: false, error: 'INVALID_FORMAT' };
    }

    if ((usedCodes || []).some(c => c.code === normalized)) {
      return { valid: false, error: 'CODE_ALREADY_USED' };
    }

    if (this._cfg?.validateOnServer) {
      const result = await api.validateCode(normalized, studentId, courseId);
      if (result.fromServer) return result;
      if (!this._cfg.fallbackToLocal) {
        return { valid: false, error: 'CONNECTION_ERROR' };
      }
      logger.warn('CodeValidator: server unreachable, using local fallback');
    }

    const demo = this._demoCodes.find(d => d.code === normalized);
    if (demo) {
      return {
        valid: true,
        worldId: demo.worldId,
        type: demo.type,
        elementType: demo.elementType,
        unlockData: { elementName: demo.elementName, description: demo.description || '' },
        fromServer: false
      };
    }

    return { valid: false, error: 'CODE_NOT_FOUND' };
  }
};
