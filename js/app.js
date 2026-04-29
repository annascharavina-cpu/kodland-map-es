import { configLoader }  from './modules/configLoader.js?v=3';
import { storage }       from './modules/storage.js?v=3';
import { state }         from './modules/state.js?v=3';
import { codeValidator } from './modules/codeValidator.js?v=3';
import { renderer }      from './modules/renderer.js?v=3';
import { getURLParams, interpolateText } from './utils/helpers.js?v=3';
import { logger }        from './utils/logger.js?v=3';

let config    = null;
let isViewMode = false;

const AVATARS = ['🧑‍💻','👩‍💻','👨‍💻','🧙','🧙‍♀️','🧝','🧝‍♀️','🦸','🦸‍♀️','⚔️','🌟','🚀'];

// ── Encode / decode share state (Unicode-safe base64) ─────────────────────────
function encodeShareState(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  const bin   = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeShareState(str) {
  const b64  = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin  = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const REACTION_EMOJIS = ['🧠', '🚀', '❤️', '✨', '🎯'];

// ── Supabase helpers ──────────────────────────────────────────────────────────

function sbHeaders() {
  const key = config?.supabase?.key;
  return {
    'apikey':        key,
    'Authorization': `Bearer ${key}`,
    'Content-Type':  'application/json'
  };
}

async function sbGet(table, query) {
  if (!config?.supabase?.url) return [];
  try {
    const res = await fetch(
      `${config.supabase.url}/rest/v1/${table}?${query}`,
      { headers: sbHeaders() }
    );
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

async function sbUpsert(table, data) {
  if (!config?.supabase?.url) return;
  try {
    await fetch(`${config.supabase.url}/rest/v1/${table}`, {
      method:  'POST',
      headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(data)
    });
  } catch {}
}

async function sbDelete(table, query) {
  if (!config?.supabase?.url) return;
  try {
    await fetch(`${config.supabase.url}/rest/v1/${table}?${query}`, {
      method:  'DELETE',
      headers: sbHeaders()
    });
  } catch {}
}

function getViewerId() {
  let vid = localStorage.getItem('kodland_viewer_id');
  if (!vid) {
    vid = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('kodland_viewer_id', vid);
  }
  return vid;
}

// Returns { projId: { emoji: count, … }, … } for all reactions on a student's projects
async function fetchReactions(studentId) {
  const rows = await sbGet(
    'reactions',
    `student_id=eq.${encodeURIComponent(studentId)}&select=proj_id,emoji`
  );
  const agg = {};
  for (const { proj_id, emoji } of rows) {
    if (!agg[proj_id]) agg[proj_id] = {};
    agg[proj_id][emoji] = (agg[proj_id][emoji] || 0) + 1;
  }
  return agg;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  const { studentId, courseId, configId } = getURLParams();

  // View-only share mode
  const viewParam = new URLSearchParams(window.location.search).get('view');
  if (viewParam) {
    await initViewMode(viewParam, configId);
    return;
  }

  // 1. Load config
  config = await configLoader.load(configId);
  codeValidator.configure(config);

  // 2. Apply config texts
  applyConfigTexts(config);

  // 3. Init SVG renderer
  const svg = document.getElementById('adventure-map');
  if (svg) {
    svg.setAttribute('viewBox', `0 0 ${config.mapConfig.width} ${config.mapConfig.height}`);
    await renderer.init(svg, config);
  }

  // 4. Load or init state
  const resolvedId = studentId || 'demo-student';
  let saved = storage.load(resolvedId);

  if (saved) {
    while (saved.worldsState.length < config.worlds.length) {
      const id = saved.worldsState.length + 1;
      saved.worldsState.push({
        worldId: id, unlocked: false, unlockedAt: null, unlockedCode: null,
        elements: {
          project:   { unlocked: false, unlockedAt: null, unlockedCode: null },
          challenge: { unlocked: false, unlockedAt: null, unlockedCode: null }
        }
      });
    }
    state.load(saved);
    logger.info('State: restored');
  } else {
    state.init(resolvedId, courseId || config.courseId, config.worlds.length);
    logger.info('State: fresh');
  }

  // 5. First render
  renderer.render(state.get());
  renderer.updateStats(state.getStats());
  renderer.updateCodeHistory(state.getStats().recentCodes);
  updateChallengeBar();
  updateProfileUI();

  // 6. Wire everything
  wireEvents(resolvedId);
  wireProfile(resolvedId);
  wireProjectsPanel();
  wireShare();

  // 7. Auto-save
  window.addEventListener('beforeunload', () => storage.save(resolvedId, state.get()));
}

// ── View-only mode ─────────────────────────────────────────────────────────────
async function initViewMode(viewParam, configId) {
  isViewMode = true;
  try {
    const shareState = decodeShareState(viewParam);
    config = await configLoader.load(configId);
    applyConfigTexts(config);

    const svg = document.getElementById('adventure-map');
    if (svg) {
      svg.setAttribute('viewBox', `0 0 ${config.mapConfig.width} ${config.mapConfig.height}`);
      await renderer.init(svg, config);
    }

    state.load({
      studentId:    'view-mode',
      courseId:     config.courseId,
      startDate:    new Date().toISOString(),
      currentWeek:  shareState.currentWeek  || 1,
      studentName:  shareState.studentName  || '',
      avatarEmoji:  shareState.avatarEmoji  || '🧑‍💻',
      projectLinks: shareState.projectLinks || {},
      worldsState:  shareState.worldsState  || [],
      unlockedCodes: []
    });

    renderer.render(state.get());
    renderer.updateStats(state.getStats());
    updateChallengeBar();
    updateProfileUI();

    // View banner
    const banner    = document.getElementById('view-banner');
    const bannerTxt = document.getElementById('view-banner-text');
    if (banner) {
      const name = shareState.studentName || 'Restaurador';
      bannerTxt.textContent = `👁  Progreso — ${name} · solo visualización`;
      banner.classList.remove('hidden');
    }

    // Hide interactive elements
    const codePanel = document.getElementById('code-panel');
    if (codePanel) codePanel.style.display = 'none';
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) shareBtn.style.display = 'none';
    const editBtn = document.getElementById('profile-edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    const avatarBtn = document.getElementById('avatar-btn');
    if (avatarBtn) avatarBtn.style.pointerEvents = 'none';

    // Show project links strip with reaction buttons
    const projectLinks  = shareState.projectLinks || {};
    const viewProjects  = document.getElementById('view-projects');
    const viewProjInner = document.getElementById('view-projects-inner');
    if (viewProjects && viewProjInner && config.projects) {
      const linked = config.projects.filter(p => {
        const link = projectLinks[p.id];
        const ws   = shareState.worldsState?.find(w => w.worldId === p.worldId);
        return ws?.elements?.project?.unlocked && link && link.trim();
      });
      if (linked.length) {
        const rxBtns = REACTION_EMOJIS
          .map(e => `<button class="reaction-btn" data-emoji="${e}">${e}</button>`)
          .join('');
        viewProjInner.innerHTML = linked.map(p => {
          const link = projectLinks[p.id];
          return `<div class="view-proj-card" data-proj="${p.id}">
            <a href="${link}" target="_blank" rel="noopener noreferrer" class="view-proj-link">
              <span class="view-proj-name">${p.name}</span>
              <span class="view-proj-url">${link}</span>
            </a>
            <div class="reaction-bar">${rxBtns}</div>
          </div>`;
        }).join('');
        viewProjects.classList.remove('hidden');
        await wireReactionButtons(shareState);
      }
    }

  } catch (e) {
    logger.error('View mode failed', e.message);
    window.location.href = window.location.pathname;
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
function updateProfileUI() {
  const s = state.get();
  const avatarEl = document.getElementById('avatar-display');
  const nameEl   = document.getElementById('profile-name');
  if (avatarEl) avatarEl.textContent = s.avatarEmoji || '🧑‍💻';
  if (nameEl)   nameEl.textContent   = s.studentName  || 'Restaurador';
}

function wireProfile(studentId) {
  const avatarBtn    = document.getElementById('avatar-btn');
  const avatarPicker = document.getElementById('avatar-picker');
  const grid         = document.getElementById('avatar-picker-grid');

  // Build emoji grid
  if (grid) {
    grid.innerHTML = AVATARS.map(e =>
      `<button class="avatar-option" data-emoji="${e}">${e}</button>`
    ).join('');
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.avatar-option');
      if (!btn) return;
      state.setAvatarEmoji(btn.dataset.emoji);
      updateProfileUI();
      storage.save(studentId, state.get());
      avatarPicker?.classList.add('hidden');
    });
  }

  avatarBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!avatarPicker) return;
    avatarPicker.classList.toggle('hidden');
    if (!avatarPicker.classList.contains('hidden')) {
      const rect = avatarBtn.getBoundingClientRect();
      avatarPicker.style.top  = (rect.bottom + 6) + 'px';
      avatarPicker.style.left = rect.left + 'px';
    }
  });

  document.addEventListener('click', e => {
    if (!avatarPicker?.classList.contains('hidden')
        && !avatarPicker.contains(e.target)
        && e.target !== avatarBtn) {
      avatarPicker.classList.add('hidden');
    }
  });

  // Name modal
  const editBtn      = document.getElementById('profile-edit-btn');
  const nameModal    = document.getElementById('name-modal');
  const nameInput    = document.getElementById('name-input');
  const nameSaveBtn  = document.getElementById('name-save-btn');
  const nameCancelBtn = document.getElementById('name-cancel-btn');

  editBtn?.addEventListener('click', () => {
    if (nameInput) nameInput.value = state.get().studentName || '';
    nameModal?.classList.remove('hidden');
    setTimeout(() => nameInput?.focus(), 50);
  });

  const saveName = () => {
    state.setStudentName(nameInput?.value || '');
    updateProfileUI();
    storage.save(studentId, state.get());
    nameModal?.classList.add('hidden');
  };

  nameSaveBtn?.addEventListener('click',   saveName);
  nameCancelBtn?.addEventListener('click', () => nameModal?.classList.add('hidden'));
  nameInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  saveName();
    if (e.key === 'Escape') nameModal?.classList.add('hidden');
  });

  nameModal?.addEventListener('click', e => {
    if (e.target === nameModal) nameModal.classList.add('hidden');
  });
}

// ── Share link ─────────────────────────────────────────────────────────────────
function wireShare() {
  document.getElementById('share-btn')?.addEventListener('click', () => {
    try {
      const encoded = encodeShareState(state.getShareState());
      const url = `${location.origin}${location.pathname}?view=${encoded}`;
      navigator.clipboard.writeText(url)
        .then(showShareToast)
        .catch(() => { prompt('Copy your share link:', url); });
    } catch (e) {
      logger.error('Share error', e.message);
    }
  });
}

function showShareToast() {
  const toast = document.getElementById('share-toast');
  if (!toast) return;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2600);
}

// ── Projects panel ─────────────────────────────────────────────────────────────
function wireProjectsPanel() {
  const btn   = document.getElementById('projects-btn');
  const panel = document.getElementById('projects-panel');
  const close = document.getElementById('projects-close');

  btn?.addEventListener('click', async () => {
    await renderProjectsPanel();
    panel?.classList.toggle('hidden');
  });
  close?.addEventListener('click', () => panel?.classList.add('hidden'));
}

async function renderProjectsPanel() {
  if (!config) return;
  const list = document.getElementById('projects-list');
  if (!list) return;

  const appState = state.get();
  const fixed = (config.projects || []).filter(p => {
    const ws = appState.worldsState.find(w => w.worldId === p.worldId);
    return ws?.elements?.project?.unlocked;
  });

  if (!fixed.length) {
    list.innerHTML = '<div class="projects-empty">Restaura proyectos en el mapa para agregar enlaces</div>';
    return;
  }

  // Load live reactions from Supabase
  const reactions = config?.supabase?.url
    ? await fetchReactions(appState.studentId)
    : {};

  list.innerHTML = fixed.map(p => {
    const world  = config.worlds.find(w => w.id === p.worldId)?.name || `Mundo ${p.worldId}`;
    const link   = appState.projectLinks?.[p.id] || '';
    const pr     = reactions[p.id] || {};
    const badges = Object.entries(pr)
      .filter(([, n]) => n > 0)
      .map(([emoji, n]) => `<span class="reaction-badge">${emoji}<span class="reaction-count">${n}</span></span>`)
      .join('');
    return `
      <div class="project-link-item">
        <div class="project-link-name">
          <span class="proj-dot">●</span>
          <strong>${p.name}</strong>
          <span class="proj-world-badge">${world}</span>
          ${badges ? `<span class="reaction-badges">${badges}</span>` : ''}
        </div>
        <div class="project-link-row">
          <input type="url" class="project-link-input" data-proj="${p.id}"
            placeholder="https://replit.com/..." value="${link}" />
          <button class="project-link-save" data-proj="${p.id}">Save</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.project-link-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.proj;
      const inp = list.querySelector(`.project-link-input[data-proj="${id}"]`);
      state.setProjectLink(id, inp?.value || '');
      storage.save(appState.studentId, state.get());
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = 'Save'; }, 1600);
    });
  });
}

// ── Reaction buttons (view mode) ──────────────────────────────────────────────
async function wireReactionButtons(shareState) {
  const studentId = shareState.studentId;
  if (!studentId || !config?.supabase?.url) return;

  const viewerId = getViewerId();

  // Fetch this viewer's existing picks for this student
  const rows = await sbGet(
    'reactions',
    `student_id=eq.${encodeURIComponent(studentId)}&viewer_id=eq.${encodeURIComponent(viewerId)}&select=proj_id,emoji`
  );
  const viewerChoices = {}; // projId → emoji
  for (const { proj_id, emoji } of rows) {
    viewerChoices[proj_id] = emoji;
  }

  // Restore active state in UI
  Object.entries(viewerChoices).forEach(([projId, emoji]) => {
    document.querySelector(`.view-proj-card[data-proj="${projId}"] .reaction-btn[data-emoji="${emoji}"]`)
      ?.classList.add('active');
  });

  // Wire click handlers
  document.querySelectorAll('.view-proj-card').forEach(card => {
    const projId = card.dataset.proj;
    card.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const emoji     = btn.dataset.emoji;
        const wasActive = btn.classList.contains('active');

        // Update UI immediately
        card.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('active'));

        if (!wasActive) {
          btn.classList.add('active');
          viewerChoices[projId] = emoji;
          await sbUpsert('reactions', {
            student_id: studentId,
            proj_id:    projId,
            emoji:      emoji,
            viewer_id:  viewerId
          });
        } else {
          delete viewerChoices[projId];
          await sbDelete(
            'reactions',
            `student_id=eq.${encodeURIComponent(studentId)}&proj_id=eq.${encodeURIComponent(projId)}&viewer_id=eq.${encodeURIComponent(viewerId)}`
          );
        }
      });
    });
  });
}

// ── Challenge bar ──────────────────────────────────────────────────────────────
function updateChallengeBar() {
  if (!config) return;
  const items = document.getElementById('challenge-bar-items');
  const empty = document.getElementById('challenge-bar-empty');
  if (!items) return;

  const appState = state.get();
  const unlocked = (config.challenges || []).filter(c => {
    const ws = appState.worldsState.find(w => w.worldId === c.worldId);
    return ws?.elements?.challenge?.unlocked;
  });

  if (!unlocked.length) {
    items.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  items.innerHTML = unlocked.map(c => `
    <div class="chal-bar-item" title="${c.name}">
      <img src="${c.imageUrl}" alt="${c.name}" class="chal-bar-img" />
      <span class="chal-bar-name">${c.name}</span>
    </div>`).join('');
}

// ── Code input ────────────────────────────────────────────────────────────────
function applyConfigTexts(cfg) {
  const t = cfg.texts || {};
  setEl('header-course',     t.courseName      || cfg.courseName || 'Kodland Universe');
  setEl('stat-worlds-label', t.statsWorlds     || 'Mundos');
  setEl('stat-proj-label',   t.statsProjects   || 'Proyectos');
  setEl('stat-chal-label',   t.statsChallenges || 'Desafíos');
  setEl('stat-prog-label',   t.statsProgress   || 'Progreso');
  const inp = document.getElementById('code-input');
  if (inp) inp.placeholder = t.inputPlaceholder || 'STAR-TECH-OPEN';
}

function wireEvents(studentId) {
  const btn   = document.getElementById('code-btn');
  const input = document.getElementById('code-input');

  btn?.addEventListener('click',  () => handleCode(studentId));
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') handleCode(studentId); });
  input?.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    clearMessage();
  });

  document.getElementById('unlock-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', closeModal);
}

async function handleCode(studentId) {
  const input = document.getElementById('code-input');
  if (!input) return;
  const code = input.value.trim();
  if (!code) return;

  const btn = document.getElementById('code-btn');
  if (btn) { btn.disabled = true; btn.textContent = '···'; }

  const result = await codeValidator.validate(
    code, state.get().studentId, state.get().courseId, state.get().unlockedCodes
  );

  if (btn) { btn.disabled = false; btn.textContent = 'Restaurar Conexión'; }

  const msgs = config.texts?.messages || {};
  if (!result.valid) {
    const errMap = {
      INVALID_FORMAT:    msgs.errorCodeFormat   || 'Código de fragmento inválido',
      CODE_ALREADY_USED: msgs.errorCodeUsed     || 'Fragmento ya activado',
      CODE_NOT_FOUND:    msgs.errorCodeNotFound  || 'Fragmento no reconocido',
      CODE_EXPIRED:      msgs.errorCodeExpired   || 'El fragmento ha expirado',
      CONNECTION_ERROR:  msgs.errorConnection    || 'Sin conexión — verificado localmente'
    };
    showMessage(errMap[result.error] || result.error, 'error');
    return;
  }

  const normalized = code.trim().toUpperCase();
  let successMsg   = '';
  const worldName  = config.worlds.find(w => w.id === result.worldId)?.name || `Mundo ${result.worldId}`;

  if (result.type === 'world') {
    if (!state.unlockWorld(result.worldId)) { showMessage('Ya desbloqueado', 'warn'); return; }
    state.setWorldCode(result.worldId, normalized);
    successMsg = interpolateText(msgs.successWorldUnlock || 'Mundo desbloqueado: {worldName}', { worldName });
    state.setWeek(Math.max(state.get().currentWeek, result.worldId));

  } else if (result.type === 'element') {
    const ws = state.get().worldsState.find(w => w.worldId === result.worldId);
    if (!ws?.unlocked) { showMessage(`Desbloquea primero el mundo «${worldName}»`, 'error'); return; }
    if (!state.unlockElement(result.worldId, result.elementType)) {
      showMessage('Ya activado', 'warn'); return;
    }
    state.setElementCode(result.worldId, result.elementType, normalized);
    successMsg = interpolateText(msgs.successElementUnlock || 'Restored: {elementName}',
      { elementName: result.unlockData?.elementName || result.elementType });
  }

  state.addUsedCode({ code: normalized, worldId: result.worldId, elementType: result.elementType, type: result.type });
  storage.save(state.get().studentId, state.get());

  renderer.render(state.get());
  renderer.updateStats(state.getStats());
  renderer.updateCodeHistory(state.getStats().recentCodes);
  updateChallengeBar();

  if (result.type === 'world')  renderer.animateWorldUnlock(result.worldId);
  else renderer.animateElementUnlock(result.worldId, result.elementType);

  const icon = result.type === 'world' ? '🌍' : result.elementType === 'project' ? '✅' : '⭐';
  showUnlockModal(icon, successMsg, []);

  input.value = '';
  clearMessage();

  if (!result.fromServer) {
    const warn = document.getElementById('server-warn');
    if (warn) {
      warn.textContent = '⚠ Verificado localmente';
      warn.style.display = 'block';
      setTimeout(() => { warn.style.display = 'none'; }, 4000);
    }
  }
}

function showMessage(text, type) {
  const el = document.getElementById('code-message');
  if (!el) return;
  el.textContent = text;
  el.className   = `code-message code-message--${type}`;
}
function clearMessage() {
  const el = document.getElementById('code-message');
  if (el) { el.textContent = ''; el.className = 'code-message'; }
}

function showUnlockModal(icon, title, activationLines) {
  const modal   = document.getElementById('unlock-modal');
  const overlay = document.getElementById('modal-overlay');
  const actEl   = document.getElementById('unlock-activation');
  if (!modal) return;
  setEl('unlock-icon',  icon);
  setEl('unlock-title', title);
  if (actEl) {
    actEl.innerHTML = activationLines
      .map(l => `<div class="activation-line">${l}</div>`).join('');
  }
  modal.classList.remove('hidden');
  overlay?.classList.remove('hidden');
}
function closeModal() {
  document.getElementById('unlock-modal')?.classList.add('hidden');
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

function setEl(id, text) {
  const e = document.getElementById(id);
  if (e) e.textContent = text;
}

document.addEventListener('DOMContentLoaded', init);
