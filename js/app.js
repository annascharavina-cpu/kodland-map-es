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
//  SKILL MAP MODAL
// ═══════════════════════════════════════════════════════════════════════════════

const SKM_SKILLS = [
  { w:1, h:'Pensamiento algorítmico: secuencia, descomposición simple', s:'Comunicación básica (presentarse, hablar de sí mismo)', e:'Confianza, sentido de pertenencia' },
  { w:2, h:'Programación por bloques: secuencias y eventos',            s:'Discusión abierta de errores',                          e:'Mentalidad de crecimiento (el error es normal)' },
  { w:3, h:'Ciclos (bucles)',                                            s:'Formular preguntas claramente',                         e:'Persistencia (intenta de nuevo)' },
  { w:4, h:'Condiciones (if / else)',                                    s:'Feedback básico entre compañeros',                      e:'Autorreflexión' },
  { w:5, h:'Variables (contadores, puntos)',                             s:'Explicar su solución',                                  e:'Autorregulación (enfoque, atención)' },
  { w:6, h:'Fundamentos de game design (reglas, objetivos)',             s:'Trabajo en pareja',                                     e:'Planificación (dividir en pasos)' },
  { w:7, h:'Integración: creación de mini-juego',                       s:'Presentación del proyecto',                             e:'Completar tareas, constancia' },
];

const SKM_PROJ_SKILLS = [
  { w:1, h:'Construir un algoritmo simple en un proyecto',  s:'Contar sobre su proyecto',         e:'"¡Puedo hacerlo!" (autoeficacia)' },
  { w:2, h:'Usar eventos e interactividad básica',          s:'Compartir resultados',              e:'Aceptar errores' },
  { w:3, h:'Aplicar ciclos en juego/animación',             s:'Explicar un problema',              e:'Persistencia' },
  { w:4, h:'Usar condiciones para lógica',                  s:'Dar y recibir feedback',            e:'Autorreflexión' },
  { w:5, h:'Usar variables (puntos, contadores)',           s:'Explicar mecánicas del juego',      e:'Autorregulación' },
  { w:6, h:'Crear mecánica básica de juego',                s:'Colaboración en equipo',            e:'Planificación' },
  { w:7, h:'Crear un mini-juego completo',                  s:'Presentar y responder preguntas',   e:'Orgullo por el resultado' },
];

const SKM_CHAL_SKILLS = [
  { w:1, s:'Comunicación (autopresentación)',  e:'Confianza, pertenencia' },
  { w:2, s:'Compartir experiencias',           e:'Mentalidad de crecimiento' },
  { w:3, s:'Pedir ayuda correctamente',        e:'Persistencia, conciencia' },
  { w:4, s:'Colaboración, feedback',           e:'Aceptar feedback' },
  { w:5, s:'Reflexión sobre el proceso',       e:'Autoconciencia, autorregulación' },
  { w:6, s:'Reflexión en grupo',               e:'Entender qué ayuda a aprender' },
];

const SKM_TRACKS = [
  { key:'hard', field:'h', label:'💻 Técnico',       color:'#06b6d4', dark:'#083344', icon:'💻', colIdx:0 },
  { key:'soft', field:'s', label:'🗣️ Comunicación',  color:'#8b5cf6', dark:'#2e1065', icon:'🗣️', colIdx:1 },
  { key:'self', field:'e', label:'🌱 Mentalidad',     color:'#f59e0b', dark:'#1c0d00', icon:'🌱', colIdx:2 },
];

// ── Vertical 3-column skill grid layout ──────────────────────────────────────
// Each column = one category; each row = one world tier (1–7, top→bottom)
// viewBox: 0 0 760 460
const SKM_COL_XS  = { hard: 130, soft: 380, self: 630 };
const SKM_ROW_YS  = [60, 120, 180, 240, 300, 360, 420];
const SKM_NODE_R  = 22;

function skmBuildSkillNodes() {
  const nodes = [];
  const conns = [];

  SKM_TRACKS.forEach(track => {
    const cx = SKM_COL_XS[track.key];
    SKM_ROW_YS.forEach((cy, i) => {
      const worldId   = i + 1;
      const skill     = SKM_SKILLS.find(s => s.w === worldId);
      const skillName = skill ? skill[track.field] : `M${worldId}`;
      const id        = `skill-${track.key}-${worldId}`;
      nodes.push({
        id, worldId,
        x: cx, y: cy, r: SKM_NODE_R,
        trackKey: track.key, color: track.color, dark: track.dark,
        skillName, skillFull: skill ? skill[track.field] : skillName,
      });
      // Connect to previous node in same column
      if (i > 0) {
        conns.push({
          from: `skill-${track.key}-${i}`,
          to:   id,
          color: track.color,
        });
      }
    });
  });

  return { nodes, conns };
}

// ── Unlock check helpers ──────────────────────────────────────────────────────
function skmIsUnlocked(nodeId, appState) {
  const parts   = nodeId.split('-');
  const worldId = parseInt(parts[2]);
  const ws      = (appState.worldsState || []).find(w => w.worldId === worldId);
  return !!ws?.unlocked;
}

function skmIsAvailable(nodeId, appState) {
  const parts   = nodeId.split('-');
  const tier    = parseInt(parts[2]);
  if (tier <= 1) return true;
  const prevId  = `skill-${parts[1]}-${tier - 1}`;
  return skmIsUnlocked(prevId, appState) && !skmIsUnlocked(nodeId, appState);
}

function skmHasBadge(type, worldId, appState) {
  const ws = (appState.worldsState || []).find(w => w.worldId === worldId);
  if (!ws) return false;
  return type === 'project'
    ? !!ws.elements?.project?.unlocked
    : !!ws.elements?.challenge?.unlocked;
}

// ── Compute skill progress percentages ───────────────────────────────────────
function skmComputePct(appState) {
  const total   = 21;
  const unlocked = (appState.worldsState || []).filter(w => w.unlocked).length * 3;
  return Math.round((Math.min(unlocked, total) / total) * 100);
}

function skmComputeCatPcts(appState) {
  const worlds = (appState.worldsState || []);
  const counts = { hard: 0, soft: 0, self: 0 };
  worlds.forEach(w => { if (w.unlocked) { counts.hard++; counts.soft++; counts.self++; } });
  return counts;
}

// ── Update progress ring ──────────────────────────────────────────────────────
function skmUpdateRing(pct) {
  const r             = 22;
  const circumference = 2 * Math.PI * r;
  const fill          = document.getElementById('skm-ring-fill');
  const pctEl         = document.getElementById('skm-ring-pct');
  if (fill) {
    fill.style.strokeDasharray  = circumference;
    fill.style.strokeDashoffset = (circumference * (1 - pct / 100)).toFixed(2);
  }
  if (pctEl) pctEl.textContent = `${pct}%`;
}

// ── Update category progress bars ────────────────────────────────────────────
function skmUpdateCatBars(appState) {
  const counts = skmComputeCatPcts(appState);
  const total  = 7;
  SKM_TRACKS.forEach(track => {
    const n    = counts[track.key];
    const fill = document.getElementById(`skm-fill-${track.key}`);
    const cnt  = document.getElementById(`skm-count-${track.key}`);
    if (fill) fill.style.width = `${Math.round((n / total) * 100)}%`;
    if (cnt)  cnt.textContent  = `${n}/${total}`;
  });
}

// ── Small star background ─────────────────────────────────────────────────────
function skmStarsBg(w, h, count) {
  const g = svgEl('g', { class: 'skm-stars-bg', 'pointer-events': 'none' });
  for (let i = 0; i < count; i++) {
    const r = Math.random() < 0.6 ? 0.8 : 1.3;
    g.appendChild(svgEl('circle', {
      cx:           (Math.random() * w).toFixed(1),
      cy:           (Math.random() * h).toFixed(1),
      r,
      fill:         '#ffffff',
      'fill-opacity': (0.06 + Math.random() * 0.12).toFixed(2),
    }));
  }
  return g;
}

// ── SVG element helper ────────────────────────────────────────────────────────
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// ── Render SVG — 3 vertical columns ──────────────────────────────────────────
function skmRenderSVG(newNodeIds, appState) {
  const svg = document.getElementById('skill-tree-svg');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Defs: gradients + glow filter
  const defs = svgEl('defs');
  const { nodes, conns } = skmBuildSkillNodes();
  nodes.forEach(n => {
    const rg = svgEl('radialGradient', { id: `skm-rg-${n.id}`, cx: '38%', cy: '38%', r: '62%' });
    rg.appendChild(svgEl('stop', { offset: '0%',   'stop-color': n.color, 'stop-opacity': '0.95' }));
    rg.appendChild(svgEl('stop', { offset: '100%', 'stop-color': n.dark,  'stop-opacity': '0.7' }));
    defs.appendChild(rg);
  });
  const fGlow = svgEl('filter', { id: 'skm-fg-sm', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  fGlow.appendChild(svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3.5', result: 'blur' }));
  defs.appendChild(fGlow);
  svg.appendChild(defs);
  svg.appendChild(skmStarsBg(760, 460, 55));

  // Active tab
  const activeTab = svg.getAttribute('data-tab') || 'all';

  // Column backgrounds + labels
  const lanesG = svgEl('g', { 'pointer-events': 'none' });
  SKM_TRACKS.forEach(track => {
    const cx = SKM_COL_XS[track.key];
    const visible = activeTab === 'all' || activeTab === track.key;

    // Lane background
    lanesG.appendChild(svgEl('rect', {
      x: cx - 58, y: 35, width: 116, height: 400, rx: 14,
      fill: track.color, 'fill-opacity': visible ? '0.08' : '0.02',
    }));

    // Column label
    const lbl = svgEl('text', {
      x: cx, y: 24,
      'text-anchor': 'middle',
      'font-size': '11',
      fill: visible ? track.color : '#2a3060',
      'fill-opacity': visible ? '1' : '0.3',
      'font-family': 'Inter, system-ui, sans-serif',
      'font-weight': '700',
    });
    lbl.textContent = track.label;
    lanesG.appendChild(lbl);
  });
  svg.appendChild(lanesG);

  // Connection lines (vertical, within each column)
  const connsG = svgEl('g', { id: 'skm-conns' });
  conns.forEach(conn => {
    const fn = nodes.find(n => n.id === conn.from);
    const tn = nodes.find(n => n.id === conn.to);
    if (!fn || !tn) return;
    const fromUnlocked = skmIsUnlocked(conn.from, appState);
    const toUnlocked   = skmIsUnlocked(conn.to,   appState);
    const isNew        = newNodeIds.includes(conn.to);
    const trackKey     = conn.from.split('-')[1];
    const visible      = activeTab === 'all' || activeTab === trackKey;

    const line = svgEl('line', { x1: fn.x, y1: fn.y + fn.r, x2: tn.x, y2: tn.y - tn.r });

    if (fromUnlocked && toUnlocked) {
      line.setAttribute('stroke', isNew ? conn.color : (visible ? conn.color : '#2a3060'));
      line.setAttribute('stroke-width',   '2');
      line.setAttribute('stroke-opacity', isNew ? '0.85' : (visible ? '0.4' : '0.08'));
      if (isNew) {
        const len = Math.abs(tn.y - fn.y - fn.r - tn.r).toFixed(1);
        line.style.strokeDasharray  = len;
        line.style.strokeDashoffset = len;
        line.classList.add('skm-conn-new');
      }
    } else {
      line.setAttribute('stroke',          visible ? '#2a3060' : '#111630');
      line.setAttribute('stroke-width',    '1.5');
      line.setAttribute('stroke-opacity',  visible ? '0.35' : '0.1');
      line.setAttribute('stroke-dasharray', '4 6');
    }
    connsG.appendChild(line);
  });
  svg.appendChild(connsG);

  // Nodes
  const nodesG = svgEl('g', { id: 'skm-nodes' });
  nodes.forEach(node => {
    const unlocked  = skmIsUnlocked(node.id, appState);
    const available = !unlocked && skmIsAvailable(node.id, appState);
    const isNew     = newNodeIds.includes(node.id);
    const trackKey  = node.trackKey;
    const visible   = activeTab === 'all' || activeTab === trackKey;

    const hasProjBadge = skmHasBadge('project',   node.worldId, appState);
    const hasChalBadge = skmHasBadge('challenge',  node.worldId, appState);
    const isProjNew    = newNodeIds.includes(`badge-project-${node.worldId}`);
    const isChalNew    = newNodeIds.includes(`badge-challenge-${node.worldId}`);

    // Outer group: position only
    const wrap = svgEl('g', { transform: `translate(${node.x},${node.y})` });
    wrap.style.opacity = visible ? '1' : '0.08';

    // Inner group: animation + interaction target
    const g = svgEl('g', {
      class: [
        'skm-node',
        unlocked  ? 'unlocked'  : '',
        available ? 'available' : '',
        isNew     ? 'is-new'    : '',
        `skm-node--skill`,
      ].filter(Boolean).join(' '),
      'data-id': node.id,
    });
    if (isNew) g.style.opacity = '0';

    // Glow circle for unlocked nodes
    if (unlocked && !isNew) {
      g.appendChild(svgEl('circle', {
        r: node.r + 10, fill: node.color,
        'fill-opacity': '0.1', class: 'skm-node-glow',
        filter: 'url(#skm-fg-sm)',
      }));
    }

    // Available ring pulse
    if (available) {
      g.appendChild(svgEl('circle', {
        r: node.r + 7,
        fill: 'none',
        stroke: node.color,
        'stroke-width': '1.5',
        'stroke-opacity': '0.4',
        class: 'skm-avail-ring',
      }));
    }

    // Main body circle
    const circle = svgEl('circle', { r: node.r });
    if (unlocked) {
      circle.setAttribute('fill',           `url(#skm-rg-${node.id})`);
      circle.setAttribute('stroke',         node.color);
      circle.setAttribute('stroke-width',   '1.5');
      circle.setAttribute('stroke-opacity', '0.8');
    } else if (available) {
      circle.setAttribute('fill',           '#0d1232');
      circle.setAttribute('stroke',         node.color);
      circle.setAttribute('stroke-width',   '1.5');
      circle.setAttribute('stroke-opacity', '0.5');
      circle.setAttribute('stroke-dasharray', '4 3');
    } else {
      circle.setAttribute('fill',           '#060a1a');
      circle.setAttribute('stroke',         '#1e2654');
      circle.setAttribute('stroke-width',   '1.5');
      circle.setAttribute('stroke-opacity', '0.3');
    }
    g.appendChild(circle);

    // Lock icon for locked nodes
    if (!unlocked && !available) {
      const lock = svgEl('text', {
        y: 5, 'text-anchor': 'middle',
        'font-size': '12', 'fill-opacity': '0.25', fill: '#8892bf',
        'font-family': 'Inter, system-ui, sans-serif',
      });
      lock.textContent = '🔒';
      g.appendChild(lock);
    }

    // World number label above node
    const worldLbl = svgEl('text', {
      y: -(node.r + 5),
      'text-anchor': 'middle', 'font-size': '7',
      fill: unlocked ? node.color : (available ? node.color : '#2a3060'),
      'fill-opacity': unlocked ? '0.75' : (available ? '0.5' : '0.3'),
      'font-family': 'Inter, system-ui, sans-serif', 'font-weight': '600',
    });
    worldLbl.textContent = `M${node.worldId}`;
    g.appendChild(worldLbl);

    // Skill name below node (truncated)
    if (unlocked || available) {
      const maxLen    = 14;
      const truncName = node.skillName.length > maxLen
        ? node.skillName.slice(0, maxLen - 1) + '…'
        : node.skillName;
      const nameLbl = svgEl('text', {
        y: node.r + 13,
        'text-anchor': 'middle', 'font-size': '7.5',
        fill: unlocked ? '#a5b4fc' : '#4a5280',
        'font-family': 'Inter, system-ui, sans-serif',
      });
      nameLbl.textContent = truncName;
      g.appendChild(nameLbl);
    }

    // Checkmark for fully unlocked nodes
    if (unlocked && !isNew) {
      const check = svgEl('text', {
        y: 4, 'text-anchor': 'middle',
        'font-size': '13', fill: '#ffffff', 'fill-opacity': '0.7',
        'font-family': 'Inter, system-ui, sans-serif',
      });
      check.textContent = '✓';
      g.appendChild(check);
    }

    // Project badge (top-right, green)
    if (hasProjBadge) {
      g.appendChild(svgEl('circle', {
        cx: (node.r * 0.65).toFixed(1), cy: -(node.r * 0.65).toFixed(1),
        r: '5', fill: '#10b981', stroke: '#022c22', 'stroke-width': '1',
        class: `skm-badge-proj${isProjNew ? ' skm-badge-new' : ''}`,
      }));
    }

    // Challenge badge (top-left, amber) — soft/self tracks only
    if (hasChalBadge && trackKey !== 'hard') {
      g.appendChild(svgEl('circle', {
        cx: -(node.r * 0.65).toFixed(1), cy: -(node.r * 0.65).toFixed(1),
        r: '4', fill: '#f59e0b', stroke: '#1c0d00', 'stroke-width': '1',
        class: `skm-badge-chal${isChalNew ? ' skm-badge-new' : ''}`,
      }));
    }

    wrap.appendChild(g);
    nodesG.appendChild(wrap);
  });
  svg.appendChild(nodesG);
}

// ── Activate new nodes with staggered animation ───────────────────────────────
function skmActivateNodes(newNodeIds, appState) {
  const svg = document.getElementById('skill-tree-svg');
  if (!svg) return;
  const { nodes: allNodes } = skmBuildSkillNodes();

  const skillIds = newNodeIds.filter(id => id.startsWith('skill-'));
  skillIds.forEach((nodeId, idx) => {
    const node = allNodes.find(n => n.id === nodeId);
    if (!node) return;
    setTimeout(() => {
      const g = svg.querySelector(`.skm-node[data-id="${nodeId}"]`);
      if (!g) return;
      g.style.opacity = '';
      g.classList.add('activating');

      // Ripple burst
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          const ripple = svgEl('circle', {
            cx: node.x, cy: node.y, r: node.r + 2,
            fill: 'none', stroke: node.color, 'stroke-width': '2.5', class: 'skm-ripple',
          });
          svg.appendChild(ripple);
          setTimeout(() => { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 900);
        }, i * 230);
      }

      // Sparkles
      const count  = 8;
      const angles = Array.from({ length: count }, (_, i) => (i / count) * Math.PI * 2);
      angles.forEach(rad => {
        const dist  = 32 + Math.random() * 22;
        const tx    = (Math.cos(rad) * dist).toFixed(1);
        const ty    = (Math.sin(rad) * dist).toFixed(1);
        const spark = svgEl('circle', { cx: node.x, cy: node.y, r: '2.5', fill: node.color });
        spark.classList.add('skm-spark');
        spark.style.setProperty('--tx', tx + 'px');
        spark.style.setProperty('--ty', ty + 'px');
        svg.appendChild(spark);
        setTimeout(() => { if (spark.parentNode) spark.parentNode.removeChild(spark); }, 700);
      });
    }, idx * 150);
  });

  // Badge activations
  const badgeIds = newNodeIds.filter(id => id.startsWith('badge-'));
  badgeIds.forEach(badgeId => {
    const parts   = badgeId.split('-');
    const type    = parts[1];
    const worldId = parseInt(parts[2]);
    const cls     = type === 'project' ? '.skm-badge-proj.skm-badge-new' : '.skm-badge-chal.skm-badge-new';
    svg.querySelectorAll(`.skm-node[data-id$="-${worldId}"] ${cls}`).forEach(el => {
      el.style.transform = 'scale(0)';
      el.style.opacity   = '0';
      requestAnimationFrame(() => {
        el.style.transform = '';
        el.style.opacity   = '';
      });
    });
  });
}

// ── Show detail card for a skill ──────────────────────────────────────────────
function skmShowSkillDetail(newNodeIds, appState) {
  const iconEl = document.getElementById('skm-detail-icon');
  const typeEl = document.getElementById('skm-detail-type');
  const nameEl = document.getElementById('skm-detail-name');
  const descEl = document.getElementById('skm-detail-desc');

  const skillIds = newNodeIds.filter(id => id.startsWith('skill-'));
  const badgeIds = newNodeIds.filter(id => id.startsWith('badge-'));

  if (skillIds.length > 0) {
    const earnedTracks = [];
    const earnedNames  = [];
    SKM_TRACKS.forEach(track => {
      const ids = skillIds.filter(id => id.startsWith(`skill-${track.key}-`));
      if (!ids.length) return;
      earnedTracks.push(track.icon);
      ids.forEach(id => {
        const worldId = parseInt(id.split('-')[2]);
        const skill   = SKM_SKILLS.find(s => s.w === worldId);
        if (skill) earnedNames.push(skill[track.field]);
      });
    });
    if (iconEl) iconEl.textContent = earnedTracks.join('') || '✨';
    if (typeEl) { typeEl.textContent = 'HABILIDADES GANADAS'; typeEl.style.color = ''; }
    if (nameEl) nameEl.textContent = earnedNames[0] || '—';
    if (descEl) descEl.textContent = earnedNames.slice(1).join(' · ');

  } else if (badgeIds.length > 0) {
    const badgeNames = [];
    badgeIds.forEach(id => {
      const parts   = id.split('-');
      const type    = parts[1];
      const worldId = parseInt(parts[2]);
      if (type === 'project') {
        const ps = SKM_PROJ_SKILLS.find(s => s.w === worldId);
        if (ps) { badgeNames.push(ps.h); badgeNames.push(ps.s); badgeNames.push(ps.e); }
      } else {
        const cs = SKM_CHAL_SKILLS.find(s => s.w === worldId);
        if (cs) { badgeNames.push(cs.s); badgeNames.push(cs.e); }
      }
    });
    const isBadgeProj = badgeIds.some(id => id.startsWith('badge-project-'));
    if (iconEl) iconEl.textContent = isBadgeProj ? '🛠' : '⭐';
    if (typeEl) { typeEl.textContent = isBadgeProj ? 'PROYECTO COMPLETADO' : 'ARTEFACTO HALLADO'; typeEl.style.color = ''; }
    if (nameEl) nameEl.textContent = badgeNames[0] || '—';
    if (descEl) descEl.textContent = badgeNames.slice(1).join(' · ');

  } else {
    const unlockedCount = (appState.worldsState || []).filter(w => w.unlocked).length * 3;
    if (iconEl) iconEl.textContent = '💻🗣️🌱';
    if (typeEl) { typeEl.textContent = 'TUS HABILIDADES'; typeEl.style.color = ''; }
    if (nameEl) nameEl.textContent = `${unlockedCount} habilidades desbloqueadas`;
    if (descEl) descEl.textContent = 'Toca un nodo para ver los detalles';
  }
}

// ── Show detail for a clicked node ───────────────────────────────────────────
function skmShowNodeDetail(nodeId) {
  const iconEl = document.getElementById('skm-detail-icon');
  const typeEl = document.getElementById('skm-detail-type');
  const nameEl = document.getElementById('skm-detail-name');
  const descEl = document.getElementById('skm-detail-desc');

  const parts    = nodeId.split('-');
  const trackKey = parts[1];
  const worldId  = parseInt(parts[2]);
  const track    = SKM_TRACKS.find(t => t.key === trackKey);
  const skill    = SKM_SKILLS.find(s => s.w === worldId);
  if (!track || !skill) return;

  // Also show project/challenge skills for same world
  const ps = SKM_PROJ_SKILLS.find(s => s.w === worldId);
  const cs = SKM_CHAL_SKILLS.find(s => s.w === worldId);
  const extras = [];
  if (ps && ps[track.field]) extras.push(ps[track.field]);
  if (cs && cs[track.field]) extras.push(cs[track.field]);

  if (iconEl) iconEl.textContent = track.icon;
  if (typeEl) { typeEl.textContent = `${track.label} · Mundo ${worldId}`; typeEl.style.color = track.color; }
  if (nameEl) nameEl.textContent = skill[track.field];
  if (descEl) descEl.textContent = extras.length ? '+ ' + extras.join(' · ') : `Nivel ${worldId}`;
}

// ── Open Skill Map after unlock ───────────────────────────────────────────────
function showSkillMapModal(unlockType, worldId, elementType, successMsg) {
  const modal = document.getElementById('skill-map-modal');
  if (!modal || !config) {
    const icon = unlockType === 'world' ? '🌍' : elementType === 'project' ? '✅' : '⭐';
    showUnlockModal(icon, successMsg, []);
    return;
  }

  let newNodeIds;
  if (unlockType === 'world') {
    newNodeIds = [
      `skill-hard-${worldId}`,
      `skill-soft-${worldId}`,
      `skill-self-${worldId}`,
    ];
  } else if (elementType === 'project') {
    newNodeIds = [`badge-project-${worldId}`];
  } else {
    newNodeIds = [`badge-challenge-${worldId}`];
  }

  const appState = state.get();
  const pct      = skmComputePct(appState);

  const badgeEl = document.getElementById('skm-new-badge');
  if (badgeEl) {
    const typeKey = unlockType === 'world' ? 'world' : (elementType || 'project');
    const labels  = { world: '🌍 MUNDO DESBLOQUEADO', project: '🛠 PROYECTO RESTAURADO', challenge: '⭐ ARTEFACTO HALLADO' };
    badgeEl.textContent = labels[typeKey] || '✨ NUEVA HABILIDAD';
  }

  skmUpdateRing(Math.max(0, pct - 5));
  skmUpdateCatBars(appState);

  const svg = document.getElementById('skill-tree-svg');
  if (svg) svg.setAttribute('data-tab', 'all');
  document.querySelectorAll('.skm-tab').forEach(t => {
    t.classList.toggle('skm-tab--active', t.dataset.tab === 'all');
  });

  skmRenderSVG(newNodeIds, appState);
  modal.classList.remove('skm-leaving', 'hidden');

  requestAnimationFrame(() => { setTimeout(() => skmUpdateRing(pct), 80); });
  skmShowSkillDetail(newNodeIds, appState);
  setTimeout(() => skmActivateNodes(newNodeIds, appState), 420);
}

// ── Open Skill Map standalone (from button) ───────────────────────────────────
function openSkillMapStandalone() {
  const modal = document.getElementById('skill-map-modal');
  if (!modal || !config) return;

  const newNodeIds = [];
  const appState   = state.get();
  const pct        = skmComputePct(appState);

  const badgeEl = document.getElementById('skm-new-badge');
  if (badgeEl) badgeEl.textContent = '🗺️ MIS HABILIDADES';

  const svg = document.getElementById('skill-tree-svg');
  if (svg) svg.setAttribute('data-tab', 'all');
  document.querySelectorAll('.skm-tab').forEach(t => {
    t.classList.toggle('skm-tab--active', t.dataset.tab === 'all');
  });

  skmUpdateRing(pct);
  skmUpdateCatBars(appState);
  skmRenderSVG(newNodeIds, appState);
  modal.classList.remove('skm-leaving', 'hidden');
  skmShowSkillDetail(newNodeIds, appState);
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

// ── Show detail for a specific clicked node ───────────────────────────────────
function skmHandleNodeClick(nodeId) {
  document.querySelectorAll('.skm-node--selected').forEach(n => n.classList.remove('skm-node--selected'));
  const g = document.querySelector(`#skill-tree-svg .skm-node[data-id="${nodeId}"]`);
  if (g) g.classList.add('skm-node--selected');
  skmShowNodeDetail(nodeId);
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
    const svg = document.getElementById('skill-tree-svg');
    if (svg) {
      svg.setAttribute('data-tab', tab);
      skmRenderSVG([], state.get());
    }
  });

  // Node click → show detail
  document.getElementById('skill-tree-svg')?.addEventListener('click', e => {
    const nodeG = e.target.closest('.skm-node[data-id]');
    if (!nodeG || !nodeG.classList.contains('unlocked')) return;
    skmHandleNodeClick(nodeG.getAttribute('data-id'));
  });

  // Share button → copy share URL (same as main share button)
  document.getElementById('skm-share-btn')?.addEventListener('click', () => {
    document.getElementById('share-btn')?.click();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
