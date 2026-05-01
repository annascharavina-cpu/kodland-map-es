import { configLoader }  from './modules/configLoader.js?v=4';
import { storage }       from './modules/storage.js?v=4';
import { state }         from './modules/state.js?v=4';
import { codeValidator } from './modules/codeValidator.js?v=4';
import { renderer }      from './modules/renderer.js?v=4';
import { getURLParams, interpolateText } from './utils/helpers.js?v=4';
import { logger }        from './utils/logger.js?v=4';

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
  wireSkillMap();

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

    // Show view-mode skills button & wire skill map
    const viewSkillsBar = document.getElementById('view-skills-bar');
    if (viewSkillsBar) viewSkillsBar.classList.remove('hidden');
    document.getElementById('view-skills-btn')?.addEventListener('click', openSkillMapStandalone);
    wireSkillMap();

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
  setEl('header-course',     t.courseName      || cfg.courseName || 'Universo Kodland');
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

  showSkillMapModal(result.type, result.worldId, result.elementType, successMsg);

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

// ═══════════════════════════════════════════════════════════════════════════════
//  SKILL MAP MODAL — text-based 3-column layout
// ═══════════════════════════════════════════════════════════════════════════════

const SKM_TRACKS = [
  { key: 'hard', title: 'Hard Skills', icon: '💻', color: '#06b6d4' },
  { key: 'soft', title: 'Soft Skills', icon: '🗣️', color: '#8b5cf6' },
  { key: 'self', title: 'Self Skills', icon: '🌱', color: '#f59e0b' },
];

let skmFilter = 'all'; // 'all' | 'unlocked' | 'locked'

const SKM_COLUMNS = {
  hard: [
    { id: 'hard-world-1', text: 'Sé organizar los pasos en orden y dividir una tarea grande en partes pequeñas', stage: 'world', worldId: 1, label: 'Mundo 1' },
    { id: 'hard-world-2', text: 'Sé armar un programa con bloques: hacer que las acciones vayan una tras otra y agregar reacciones a eventos (pulsar un botón, clic)', stage: 'world', worldId: 2, label: 'Mundo 2' },
    { id: 'hard-world-3', text: 'Sé usar ciclos para que el programa repita acciones solo, sin copiar', stage: 'world', worldId: 3, label: 'Mundo 3' },
    { id: 'hard-world-4', text: 'Sé establecer condiciones: si pasa una cosa — haz esto, si otra — haz aquello (if / else)', stage: 'world', worldId: 4, label: 'Mundo 4' },
    { id: 'hard-world-5', text: 'Sé crear variables — por ejemplo, contar puntos o vidas en un juego', stage: 'world', worldId: 5, label: 'Mundo 5' },
    { id: 'hard-world-6', text: 'Sé inventar reglas para un juego: qué hay que hacer, cómo ganar, cómo perder', stage: 'world', worldId: 6, label: 'Mundo 6' },
    { id: 'hard-world-7', text: 'Sé unir todos los conocimientos y hacer un mini-juego funcional', stage: 'world', worldId: 7, label: 'Mundo 7' },
    { id: 'hard-project-1', text: 'Puedo armar un algoritmo simple en mi propio proyecto', stage: 'project', worldId: 1, label: 'Proyecto 1' },
    { id: 'hard-project-2', text: 'Puedo agregar interactividad al proyecto — para que un personaje u objeto reaccione a las acciones', stage: 'project', worldId: 2, label: 'Proyecto 2' },
    { id: 'hard-project-3', text: 'Puedo usar ciclos en un juego o animación para que algo se mueva o se repita', stage: 'project', worldId: 3, label: 'Proyecto 3' },
    { id: 'hard-project-4', text: 'Puedo usar condiciones para que el proyecto tenga lógica (por ejemplo: si tocas al enemigo — pierdes una vida)', stage: 'project', worldId: 4, label: 'Proyecto 4' },
    { id: 'hard-project-5', text: 'Puedo usar variables para contar puntos o resultados en el proyecto', stage: 'project', worldId: 5, label: 'Proyecto 5' },
    { id: 'hard-project-6', text: 'Puedo crear una mecánica de juego funcional (por ejemplo: recoger monedas, evitar obstáculos)', stage: 'project', worldId: 6, label: 'Proyecto 6' },
    { id: 'hard-project-7', text: 'Puedo hacer un mini-juego completo de principio a fin', stage: 'project', worldId: 7, label: 'Proyecto 7' },
  ],
  soft: [
    { id: 'soft-project-1', text: 'Puedo presentarme y hablar de mí a los demás', stage: 'project', worldId: 1, label: 'Proyecto 1' },
    { id: 'soft-project-2', text: 'Puedo mostrar mi proyecto y contar lo que hice', stage: 'project', worldId: 2, label: 'Proyecto 2' },
    { id: 'soft-project-3', text: 'Puedo hacer preguntas si no entiendo algo. Puedo hablar abiertamente de los errores', stage: 'project', worldId: 3, label: 'Proyecto 3' },
    { id: 'soft-project-4', text: 'Puedo dar un consejo y escuchar tranquilamente un consejo a cambio. Puedo explicar cuál es el problema', stage: 'project', worldId: 4, label: 'Proyecto 4' },
    { id: 'soft-project-5', text: 'Puedo explicar por qué lo hice así. Puedo evaluar el trabajo de otro alumno', stage: 'project', worldId: 5, label: 'Proyecto 5' },
    { id: 'soft-project-6', text: 'Puedo trabajar con un compañero o en grupo. Puedo explicar cómo funciona mi juego', stage: 'project', worldId: 6, label: 'Proyecto 6' },
    { id: 'soft-project-7', text: 'Puedo presentar mi proyecto ante los demás. Puedo trabajar en pareja', stage: 'project', worldId: 7, label: 'Proyecto 7' },
  ],
  self: [
    { id: 'self-project-1', text: 'Sé terminar una tarea hasta el final, incluso si es difícil', stage: 'project', worldId: 1, label: 'Proyecto 1' },
    { id: 'self-project-2', text: 'Entiendo que los errores son normales y no me desanimo por ellos', stage: 'project', worldId: 2, label: 'Proyecto 2' },
    { id: 'self-project-3', text: 'No me rindo si algo no sale a la primera — lo intento de nuevo', stage: 'project', worldId: 3, label: 'Proyecto 3' },
    { id: 'self-project-4', text: 'Sé reflexionar sobre lo que salió bien y lo que puedo mejorar', stage: 'project', worldId: 4, label: 'Proyecto 4' },
    { id: 'self-project-5', text: 'Sé controlar mi atención y no distraerme cuando es importante', stage: 'project', worldId: 5, label: 'Proyecto 5' },
    { id: 'self-project-6', text: 'Sé planificar — dividir una tarea grande en pasos y seguir el plan', stage: 'project', worldId: 6, label: 'Proyecto 6' },
    { id: 'self-project-7', text: 'Termino lo que empiezo y me siento orgulloso/a del resultado', stage: 'project', worldId: 7, label: 'Proyecto 7' },
    { id: 'self-challenge-1', text: 'Me siento seguro/a en el grupo, siento que soy parte del equipo', stage: 'challenge', worldId: 1, label: 'Desafío 1' },
    { id: 'self-challenge-2', text: 'Creo que puedo aprender lo que sea si me esfuerzo. No tengo miedo a equivocarme', stage: 'challenge', worldId: 2, label: 'Desafío 2' },
    { id: 'self-challenge-3', text: 'No me rindo y noto cuando me resulta difícil — sé pedir ayuda a tiempo', stage: 'challenge', worldId: 3, label: 'Desafío 3' },
    { id: 'self-challenge-4', text: 'Acepto con calma cuando me dicen que puedo hacerlo mejor', stage: 'challenge', worldId: 4, label: 'Desafío 4' },
    { id: 'self-challenge-5', text: 'Conozco mis puntos fuertes y sé gestionar mis emociones mientras estudio', stage: 'challenge', worldId: 5, label: 'Desafío 5' },
    { id: 'self-challenge-6', text: 'Sé qué me ayuda personalmente a aprender mejor (silencio, música, descansos, trabajo en pareja...)', stage: 'challenge', worldId: 6, label: 'Desafío 6' },
  ],
};

// ── Check if a specific skill is unlocked ──────────────────────────────────────
function skmIsSkillUnlocked(skill, appState) {
  const ws = (appState.worldsState || []).find(w => w.worldId === skill.worldId);
  if (!ws) return false;
  if (skill.stage === 'world') return !!ws.unlocked;
  if (skill.stage === 'project') return !!ws.elements?.project?.unlocked;
  if (skill.stage === 'challenge') return !!ws.elements?.challenge?.unlocked;
  return false;
}

// ── Compute overall and per-category progress ─────────────────────────────────
function skmComputeProgress(appState) {
  let unlocked = 0;
  let total = 0;
  const counts = {};
  for (const track of SKM_TRACKS) {
    const skills = SKM_COLUMNS[track.key];
    const n = skills.filter(s => skmIsSkillUnlocked(s, appState)).length;
    counts[track.key] = { unlocked: n, total: skills.length };
    unlocked += n;
    total += skills.length;
  }
  return { unlocked, total, pct: total > 0 ? Math.round((unlocked / total) * 100) : 0, counts };
}

// ── Update progress ring ──────────────────────────────────────────────────────
function skmUpdateRing(pct) {
  const r = 22;
  const circumference = 2 * Math.PI * r;
  const fill = document.getElementById('skm-ring-fill');
  const pctEl = document.getElementById('skm-ring-pct');
  if (fill) {
    fill.style.strokeDasharray = circumference;
    fill.style.strokeDashoffset = (circumference * (1 - pct / 100)).toFixed(2);
  }
  if (pctEl) pctEl.textContent = `${pct}%`;
}

// ── Update category progress bars ─────────────────────────────────────────────
function skmUpdateCatBars(appState) {
  const { counts } = skmComputeProgress(appState);
  SKM_TRACKS.forEach(track => {
    const c = counts[track.key];
    const fill = document.getElementById(`skm-fill-${track.key}`);
    const cnt = document.getElementById(`skm-count-${track.key}`);
    if (fill) fill.style.width = `${c.total > 0 ? Math.round((c.unlocked / c.total) * 100) : 0}%`;
    if (cnt) cnt.textContent = `${c.unlocked}/${c.total}`;
  });
}

// ── Render HTML columns ───────────────────────────────────────────────────────
function skmRenderHTML(newItemIds, appState) {
  const container = document.getElementById('skill-tree-container');
  if (!container) return;
  const activeTab = container.getAttribute('data-tab') || 'all';

  container.innerHTML = SKM_TRACKS.map(track => {
    const visible = activeTab === 'all' || activeTab === track.key;
    const skills = SKM_COLUMNS[track.key];
    const itemsHTML = skills.map(skill => {
      const unlocked = skmIsSkillUnlocked(skill, appState);
      const isNew = newItemIds.includes(skill.id);
      const hidden = (skmFilter === 'unlocked' && !unlocked) || (skmFilter === 'locked' && unlocked);
      return `<div class="skm-skill-item ${unlocked ? 'unlocked' : 'locked'}${isNew ? ' is-new' : ''}${hidden ? ' skm-filtered-out' : ''}" data-id="${skill.id}" data-track="${track.key}">
        <span class="skm-skill-icon">${unlocked ? '✓' : '🔒'}</span>
        <div class="skm-skill-content">
          <span class="skm-skill-label">${skill.label}</span>
          <span class="skm-skill-text">${skill.text}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="skm-col${visible ? '' : ' skm-col--hidden'}" data-track="${track.key}">
      <div class="skm-col-header">
        <span class="skm-col-icon">${track.icon}</span>
        <span class="skm-col-title">${track.title}</span>
      </div>
      <div class="skm-col-items">${itemsHTML}</div>
    </div>`;
  }).join('');
}

// ── Animate newly unlocked items ──────────────────────────────────────────────
function skmActivateItems(newItemIds) {
  const container = document.getElementById('skill-tree-container');
  if (!container || !newItemIds.length) return;
  const first = container.querySelector(`.skm-skill-item[data-id="${newItemIds[0]}"]`);
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Show detail card for newly unlocked skills ────────────────────────────────
function skmShowNewDetail(newItemIds, appState) {
  const iconEl = document.getElementById('skm-detail-icon');
  const typeEl = document.getElementById('skm-detail-type');
  const nameEl = document.getElementById('skm-detail-name');
  const descEl = document.getElementById('skm-detail-desc');

  if (newItemIds.length > 0) {
    const firstId = newItemIds[0];
    const trackKey = firstId.split('-')[0];
    const track = SKM_TRACKS.find(t => t.key === trackKey);
    const allSkills = Object.values(SKM_COLUMNS).flat();
    const newSkills = newItemIds.map(id => allSkills.find(s => s.id === id)).filter(Boolean);

    if (iconEl) iconEl.textContent = newSkills.length > 1 ? '💻🗣️🌱' : (track ? track.icon : '✨');
    if (typeEl) {
      typeEl.textContent = newSkills.length > 1 ? 'NUEVAS HABILIDADES' : 'NUEVA HABILIDAD';
      typeEl.style.color = track ? track.color : '';
    }
    if (nameEl) nameEl.textContent = newSkills[0]?.text || '—';
    if (descEl) descEl.textContent = newSkills.slice(1).map(s => s.text).join(' · ');
  } else {
    const { unlocked, total } = skmComputeProgress(appState);
    if (iconEl) iconEl.textContent = '💻🗣️🌱';
    if (typeEl) { typeEl.textContent = 'TUS HABILIDADES'; typeEl.style.color = ''; }
    if (nameEl) nameEl.textContent = `${unlocked} de ${total} habilidades desbloqueadas`;
    if (descEl) descEl.textContent = 'Toca una habilidad para ver los detalles';
  }
}

// ── Show detail for a clicked item ────────────────────────────────────────────
function skmShowItemDetail(skillId) {
  const iconEl = document.getElementById('skm-detail-icon');
  const typeEl = document.getElementById('skm-detail-type');
  const nameEl = document.getElementById('skm-detail-name');
  const descEl = document.getElementById('skm-detail-desc');

  const allSkills = Object.values(SKM_COLUMNS).flat();
  const skill = allSkills.find(s => s.id === skillId);
  if (!skill) return;

  const trackKey = skillId.split('-')[0];
  const track = SKM_TRACKS.find(t => t.key === trackKey);
  const appState = state.get();
  const unlocked = skmIsSkillUnlocked(skill, appState);

  if (iconEl) iconEl.textContent = track ? track.icon : '✨';
  if (typeEl) {
    typeEl.textContent = `${skill.label} · ${track ? track.title : ''}`;
    typeEl.style.color = track ? track.color : '';
  }
  if (nameEl) nameEl.textContent = skill.text;
  if (descEl) {
    if (unlocked) {
      descEl.textContent = '✓ Habilidad desbloqueada';
    } else {
      const stageNames = { world: 'mundo', project: 'proyecto', challenge: 'desafío' };
      descEl.textContent = `🔒 Se desbloquea con: ${stageNames[skill.stage]} ${skill.worldId}`;
    }
  }
}

// ── Open Skill Map after unlock ───────────────────────────────────────────────
function showSkillMapModal(unlockType, worldId, elementType, successMsg) {
  const modal = document.getElementById('skill-map-modal');
  if (!modal || !config) {
    const icon = unlockType === 'world' ? '🌍' : elementType === 'project' ? '✅' : '⭐';
    showUnlockModal(icon, successMsg, []);
    return;
  }

  let newItemIds;
  if (unlockType === 'world') {
    newItemIds = [`hard-world-${worldId}`];
  } else if (elementType === 'project') {
    newItemIds = [
      `hard-project-${worldId}`,
      `soft-project-${worldId}`,
      `self-project-${worldId}`,
    ];
  } else {
    newItemIds = [`self-challenge-${worldId}`];
  }

  const appState = state.get();
  const { pct } = skmComputeProgress(appState);

  const badgeEl = document.getElementById('skm-new-badge');
  if (badgeEl) {
    const typeKey = unlockType === 'world' ? 'world' : (elementType || 'project');
    const labels = { world: '🌍 MUNDO DESBLOQUEADO', project: '🛠 PROYECTO RESTAURADO', challenge: '⭐ DESAFÍO COMPLETADO' };
    badgeEl.textContent = labels[typeKey] || '✨ NUEVA HABILIDAD';
  }

  skmUpdateRing(Math.max(0, pct - 5));
  skmUpdateCatBars(appState);

  const container = document.getElementById('skill-tree-container');
  if (container) container.setAttribute('data-tab', 'all');
  document.querySelectorAll('.skm-tab').forEach(t => {
    t.classList.toggle('skm-tab--active', t.dataset.tab === 'all');
  });
  skmFilter = 'all';
  document.querySelectorAll('.skm-filter').forEach(f => {
    f.classList.toggle('skm-filter--active', f.dataset.filter === 'all');
  });

  skmRenderHTML(newItemIds, appState);
  modal.classList.remove('skm-leaving', 'hidden');

  requestAnimationFrame(() => { setTimeout(() => skmUpdateRing(pct), 80); });
  skmShowNewDetail(newItemIds, appState);
  setTimeout(() => skmActivateItems(newItemIds), 420);
}

// ── Open Skill Map standalone (from button) ───────────────────────────────────
function openSkillMapStandalone() {
  const modal = document.getElementById('skill-map-modal');
  if (!modal || !config) return;

  const appState = state.get();
  const { pct } = skmComputeProgress(appState);

  const badgeEl = document.getElementById('skm-new-badge');
  if (badgeEl) badgeEl.textContent = isViewMode ? '👁 HABILIDADES' : '🗺️ MIS HABILIDADES';

  const skmShareBtn = document.getElementById('skm-share-btn');
  if (skmShareBtn) skmShareBtn.style.display = isViewMode ? 'none' : '';

  const container = document.getElementById('skill-tree-container');
  if (container) container.setAttribute('data-tab', 'all');
  document.querySelectorAll('.skm-tab').forEach(t => {
    t.classList.toggle('skm-tab--active', t.dataset.tab === 'all');
  });
  skmFilter = 'all';
  document.querySelectorAll('.skm-filter').forEach(f => {
    f.classList.toggle('skm-filter--active', f.dataset.filter === 'all');
  });

  skmUpdateRing(pct);
  skmUpdateCatBars(appState);
  skmRenderHTML([], appState);
  modal.classList.remove('skm-leaving', 'hidden');
  skmShowNewDetail([], appState);
}

// ── Close Skill Map modal ─────────────────────────────────────────────────────
function closeSkillMapModal() {
  const modal = document.getElementById('skill-map-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('skm-leaving');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('skm-leaving');
  }, 280);
}

// ── Wire Skill Map events ─────────────────────────────────────────────────────
function wireSkillMap() {
  document.getElementById('skills-btn')?.addEventListener('click', openSkillMapStandalone);
  document.getElementById('skm-close-btn')?.addEventListener('click', closeSkillMapModal);
  document.getElementById('skm-continue-btn')?.addEventListener('click', closeSkillMapModal);
  document.getElementById('skill-map-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('skill-map-modal')) closeSkillMapModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSkillMapModal();
  });

  // Tab switching
  document.getElementById('skm-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.skm-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.skm-tab').forEach(t => {
      t.classList.toggle('skm-tab--active', t.dataset.tab === tab);
    });
    const container = document.getElementById('skill-tree-container');
    if (container) {
      container.setAttribute('data-tab', tab);
      skmRenderHTML([], state.get());
    }
  });

  // Filter switching (all / unlocked / locked)
  document.getElementById('skm-filters')?.addEventListener('click', e => {
    const btn = e.target.closest('.skm-filter');
    if (!btn) return;
    skmFilter = btn.dataset.filter;
    document.querySelectorAll('.skm-filter').forEach(f => {
      f.classList.toggle('skm-filter--active', f.dataset.filter === skmFilter);
    });
    skmRenderHTML([], state.get());
  });

  // Item click → show detail
  document.getElementById('skill-tree-container')?.addEventListener('click', e => {
    const item = e.target.closest('.skm-skill-item[data-id]');
    if (!item) return;
    document.querySelectorAll('.skm-skill-item--selected').forEach(el => el.classList.remove('skm-skill-item--selected'));
    item.classList.add('skm-skill-item--selected');
    skmShowItemDetail(item.getAttribute('data-id'));
  });

  // Share button
  document.getElementById('skm-share-btn')?.addEventListener('click', () => {
    document.getElementById('share-btn')?.click();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
