import { generateUUID } from '../utils/helpers.js?v=2';

function makeWorldState(worldId) {
  return {
    worldId,
    unlocked:    false,
    unlockedAt:  null,
    unlockedCode: null,
    elements: {
      project:   { unlocked: false, unlockedAt: null, unlockedCode: null },
      challenge: { unlocked: false, unlockedAt: null, unlockedCode: null }
    }
  };
}

export const state = {
  _data: null,

  init(studentId, courseId, worldCount = 7) {
    this._data = {
      studentId:    studentId || generateUUID(),
      courseId:     courseId  || 'default',
      startDate:    new Date().toISOString(),
      currentWeek:  1,
      studentName:  '',
      avatarEmoji:  '🧑‍💻',
      projectLinks: {},
      worldsState:  Array.from({ length: worldCount }, (_, i) => makeWorldState(i + 1)),
      unlockedCodes: []
    };
    return this._data;
  },

  load(data) {
    // Migrate: add new fields if missing from older saved states
    this._data = {
      studentName:  '',
      avatarEmoji:  '🧑‍💻',
      projectLinks: {},
      ...data
    };
    return this._data;
  },

  get() { return this._data; },

  // ── Profile ─────────────────────────────────────────────────────────────────
  setStudentName(name)    { this._data.studentName  = (name || '').trim(); },
  setAvatarEmoji(emoji)   { this._data.avatarEmoji  = emoji || '🧑‍💻'; },
  setProjectLink(projId, url) {
    if (!this._data.projectLinks) this._data.projectLinks = {};
    this._data.projectLinks[projId] = (url || '').trim();
  },

  // ── World unlock ─────────────────────────────────────────────────────────────
  unlockWorld(worldId) {
    const ws = this._findWorld(worldId);
    if (!ws || ws.unlocked) return false;
    ws.unlocked   = true;
    ws.unlockedAt = new Date().toISOString();
    return true;
  },

  setWorldCode(worldId, code) {
    const ws = this._findWorld(worldId);
    if (ws) ws.unlockedCode = code;
  },

  unlockElement(worldId, elementType) {
    const ws = this._findWorld(worldId);
    if (!ws || !ws.unlocked) return false;
    const el = ws.elements[elementType];
    if (!el || el.unlocked) return false;
    el.unlocked   = true;
    el.unlockedAt = new Date().toISOString();
    return true;
  },

  setElementCode(worldId, elementType, code) {
    const ws = this._findWorld(worldId);
    if (ws && ws.elements[elementType]) ws.elements[elementType].unlockedCode = code;
  },

  addUsedCode(codeData) {
    this._data.unlockedCodes.push({ ...codeData, redeemedAt: new Date().toISOString() });
  },

  isCodeUsed(code) {
    return this._data.unlockedCodes.some(c => c.code === code);
  },

  setWeek(week) { this._data.currentWeek = week; },

  // ── Stats ────────────────────────────────────────────────────────────────────
  getStats() {
    const d = this._data;
    const total        = d.worldsState.length;
    const unlockedW    = d.worldsState.filter(w => w.unlocked).length;
    const unlockedProj = d.worldsState.filter(w => w.elements.project.unlocked).length;
    const unlockedChal = d.worldsState.filter(w => w.elements.challenge.unlocked).length;
    const unlockedEl   = unlockedProj + unlockedChal;
    const totalEl      = total * 2;
    const pct          = Math.round(((unlockedW + unlockedEl) / (total + totalEl)) * 100);

    return {
      currentWeek: d.currentWeek,
      totalWeeks: total,
      unlockedWorlds: unlockedW,
      totalWorlds: total,
      unlockedProjects: unlockedProj,
      unlockedChallenges: unlockedChal,
      unlockedElements: unlockedEl,
      totalElements: totalEl,
      progress: pct,
      recentCodes: [...d.unlockedCodes].reverse().slice(0, 5)
    };
  },

  // ── Share ────────────────────────────────────────────────────────────────────
  getShareState() {
    return {
      studentId:    this._data.studentId,
      studentName:  this._data.studentName,
      avatarEmoji:  this._data.avatarEmoji,
      currentWeek:  this._data.currentWeek,
      worldsState:  this._data.worldsState,
      projectLinks: this._data.projectLinks || {}
    };
  },

  _findWorld(worldId) {
    return this._data?.worldsState.find(w => w.worldId === worldId) ?? null;
  }
};
