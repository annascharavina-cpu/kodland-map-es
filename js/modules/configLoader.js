import { logger } from '../utils/logger.js';

const CACHE_KEY = 'kodland_config_';
const CACHE_TTL = 5 * 60 * 1000;

export const configLoader = {
  async load(configId = null) {
    if (configId) {
      const cached = this._fromCache(configId);
      if (cached) { logger.info('Config: from cache', configId); return cached; }

      try {
        const remote = await this._fromServer(configId);
        if (remote) {
          this._toCache(configId, remote);
          logger.info('Config: from server', configId);
          return remote;
        }
      } catch (e) {
        logger.warn('Config: server fetch failed', e.message);
      }
    }

    return this._default();
  },

  async _fromServer(configId) {
    const resp = await fetch(`/api/config/${configId}`, { signal: AbortSignal.timeout(5000) });
    return resp.ok ? resp.json() : null;
  },

  _fromCache(configId) {
    try {
      const raw = localStorage.getItem(CACHE_KEY + configId);
      if (!raw) return null;
      const { config, cachedAt } = JSON.parse(raw);
      if (Date.now() - new Date(cachedAt).getTime() > CACHE_TTL) {
        localStorage.removeItem(CACHE_KEY + configId);
        return null;
      }
      return config;
    } catch { return null; }
  },

  _toCache(configId, config) {
    try {
      localStorage.setItem(CACHE_KEY + configId, JSON.stringify({ config, cachedAt: new Date().toISOString() }));
    } catch (_) {}
  },

  async _default() {
    try {
      const resp = await fetch('./config/default.json');
      if (resp.ok) { logger.info('Config: from default.json'); return resp.json(); }
    } catch (_) {}
    logger.warn('Config: using inline fallback');
    return this._inline();
  },

  _inline() {
    return {
      courseId: 'default', courseName: 'Universo Kodland', version: '1.0',
      mapConfig: { width: 1280, height: 640, backgroundColor: '#0a0e1a' },
      worlds: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1, name: `Mundo ${i + 1}`,
        x: 140 + i * 150, y: i % 2 === 0 ? 420 : 240,
        color: '#6366f1', colorDark: '#312e81'
      })),
      connectors: Array.from({ length: 7 }, (_, i) => ({
        id: `c-${i+1}-${i+2}`, from: i + 1, to: i + 2, type: 'curve'
      })),
      colors: {
        worldLocked: { fill: '#1a1f3a', stroke: '#2d3562', text: '#4a5280' },
        worldUnlocked: { stroke: '#ffffff', text: '#ffffff' },
        projectElement:   { fill: '#10b981', stroke: '#34d399' },
        challengeElement: { fill: '#f59e0b', stroke: '#fcd34d' },
        connectorLocked: '#1e2654', connectorUnlocked: '#6366f1'
      },
      texts: {
        headerTitle: 'Mapa de aventuras', courseName: 'Universo Kodland',
        statsCurrentWeek: 'Semana', statsWorlds: 'Mundos',
        statsElements: 'Elementos', statsProgress: 'Progreso',
        inputPlaceholder: 'Ingresa el código…', buttonApply: 'Aplicar',
        messages: {
          successWorldUnlock: '¡Nuevo mundo abierto: {worldName}!',
          successElementUnlock: '¡Desbloqueado: {elementName}!',
          errorCodeFormat: 'Formato de código inválido',
          errorCodeUsed: 'Este código ya fue utilizado',
          errorCodeNotFound: 'Código no encontrado',
          errorCodeExpired: 'El código ha expirado',
          errorConnection: 'Sin conexión, código verificado localmente'
        }
      },
      codeValidation: { pattern: '^[A-Z]+-W[1-8]-[A-Z0-9]{4}$', validateOnServer: false, fallbackToLocal: true },
      demoCodes: []
    };
  }
};
