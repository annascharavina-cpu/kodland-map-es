const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c) e.appendChild(c);
  return e;
}

// ─── Standalone helpers ─────────────────────────────────────────────────────

// Check if an image URL exists (HEAD request — reliable 404 detection)
function checkImage(url) {
  return fetch(url, { method: 'HEAD' })
    .then(r => r.ok)
    .catch(() => false);
}

export const renderer = {
  _svg: null,
  _config: null,
  _availableImages: null,   // Set of URLs that loaded successfully

  // ─── Public API ────────────────────────────────────────────────────────────

  async init(svgEl, config) {
    this._svg = svgEl;
    this._config = config;

    // Collect every image URL used in config
    const allUrls = [
      ...(config.decorative  || []).map(d => d.imageUrl),
      ...(config.worlds      || []).map(w => w.imageUrl),
      ...(config.projects    || []).flatMap(p => [p.broken.url, p.fixed.url]),
      ...(config.challenges  || []).map(c => c.imageUrl)
    ];

    // Check all in parallel — only render images that actually load
    const results = await Promise.all(allUrls.map(url => checkImage(url).then(ok => ({ url, ok }))));
    this._availableImages = new Set(results.filter(r => r.ok).map(r => r.url));

    this._setupTooltip();
    this._buildDefs();
    this._buildLayers();
    this._generateStars();
    this._buildDecoration();
    this._buildProjects();
    this._buildChallenges();
    this._buildWorlds();
  },

  render(appState) {
    this._updateWorldStates(appState);
    this._updateProjectStates(appState);
    this._updateChallengeStates(appState);
  },

  // ─── Tooltip ────────────────────────────────────────────────────────────────

  _setupTooltip() {
    this._tt = document.getElementById('map-tooltip');
    document.addEventListener('mousemove', e => {
      if (this._tt?.classList.contains('visible')) this._moveTooltip(e.clientX, e.clientY);
    });
  },

  _showTooltip(type, title, desc, e) {
    if (!this._tt) return;
    const badge = this._tt.querySelector('#tt-badge');
    const ttitle = this._tt.querySelector('#tt-title');
    const tdesc  = this._tt.querySelector('#tt-desc');

    const labels = { world: '🌍 Мир', locked: '🔒 Мир', project: '🛠 Проект', challenge: '⭐ Челлендж' };
    badge.textContent = labels[type] || type;
    badge.className   = `tt-badge tt-badge--${type}`;
    ttitle.textContent = title;
    tdesc.textContent  = desc;

    this._tt.classList.add('visible');
    this._moveTooltip(e.clientX, e.clientY);
  },

  _hideTooltip() {
    this._tt?.classList.remove('visible');
  },

  _moveTooltip(cx, cy) {
    if (!this._tt) return;
    const tw = this._tt.offsetWidth  || 230;
    const th = this._tt.offsetHeight || 90;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 16;
    let x = cx + gap;
    let y = cy - th / 2;
    if (x + tw > vw - 8) x = cx - tw - gap;
    if (y < 8) y = 8;
    if (y + th > vh - 8) y = vh - th - 8;
    this._tt.style.left = `${x}px`;
    this._tt.style.top  = `${y}px`;
  },

  _attachTooltip(svgEl, getInfo) {
    svgEl.addEventListener('mouseenter', e => {
      const { type, title, desc } = getInfo();
      this._showTooltip(type, title, desc, e);
    });
    svgEl.addEventListener('mouseleave', () => this._hideTooltip());
  },

  // ─── Stats ──────────────────────────────────────────────────────────────────

  updateStats(stats) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    const totalProj = (this._config?.projects   || []).length;
    const totalChal = (this._config?.challenges  || []).length;
    set('stat-worlds', `${stats.unlockedWorlds}    / ${stats.totalWorlds}`);
    set('stat-proj',   `${stats.unlockedProjects}  / ${totalProj}`);
    set('stat-chal',   `${stats.unlockedChallenges} / ${totalChal}`);
    set('stat-pct',    `${stats.progress}%`);
    const fill = document.getElementById('stat-progress-fill');
    if (fill) fill.style.width = `${stats.progress}%`;
  },

  updateCodeHistory(recentCodes) {
    const container = document.getElementById('code-history');
    if (!container) return;
    if (!recentCodes.length) { container.innerHTML = ''; return; }
    container.innerHTML = recentCodes.map(c => {
      const t = new Date(c.redeemedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return `<div class="history-item">
        <span class="history-code">${c.code}</span>
        <span class="history-time">${t}</span>
      </div>`;
    }).join('');
  },

  animateWorldUnlock(worldId) {
    const g = this._svg.querySelector(`#world-${worldId}`);
    if (!g) return;
    g.classList.add('world-just-unlocked');
    setTimeout(() => g.classList.remove('world-just-unlocked'), 1200);
  },

  animateElementUnlock(worldId, type) {
    if (type === 'project') {
      const fixed = this._svg.querySelector(`#proj-fixed-${worldId}`);
      if (fixed) {
        fixed.classList.add('project-just-fixed');
        setTimeout(() => fixed.classList.remove('project-just-fixed'), 900);
      }
    }
    if (type === 'challenge') {
      const chal = this._svg.querySelector(`#chal-img-${worldId}`);
      if (chal) {
        chal.classList.add('challenge-just-appeared');
        setTimeout(() => chal.classList.remove('challenge-just-appeared'), 900);
      }
    }
  },

  // Create SVG <image> only if the URL is in the available set
  _img(attrs) {
    const url = attrs.href;
    if (url && !this._availableImages.has(url)) return null;
    return el('image', attrs);
  },

  // ─── Init helpers (run once) ────────────────────────────────────────────────

  _buildDefs() {
    const defs = el('defs');

    // Glow filter for unlock flash
    defs.appendChild(el('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, [
      el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '6', result: 'blur' }),
      el('feMerge', {}, [
        el('feMergeNode', { in: 'blur' }),
        el('feMergeNode', { in: 'SourceGraphic' })
      ])
    ]));

    this._svg.insertBefore(defs, this._svg.firstChild);
  },

  _buildLayers() {
    for (const id of ['bg-layer', 'project-layer', 'challenge-layer', 'world-layer']) {
      if (!this._svg.querySelector(`#${id}`)) {
        this._svg.appendChild(el('g', { id }));
      }
    }
  },

  _generateStars() {
    const bg = this._svg.querySelector('#bg-layer');
    const { width: W, height: H, backgroundColor } = this._config.mapConfig;

    bg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: backgroundColor }));

    const g = el('g', { id: 'stars', opacity: '0.9' });
    const rng = this._seededRandom(42);
    for (let i = 0; i < 200; i++) {
      const x  = rng() * W;
      const y  = rng() * H;
      const r  = rng() < 0.08 ? 1.6 : rng() < 0.3 ? 1.1 : 0.6;
      const op = 0.35 + rng() * 0.65;
      g.appendChild(el('circle', {
        cx: x.toFixed(1), cy: y.toFixed(1), r,
        fill: '#ffffff', opacity: op.toFixed(2)
      }));
    }
    bg.appendChild(g);
  },

  _buildDecoration() {
    const bg = this._svg.querySelector('#bg-layer');
    for (const d of (this._config.decorative || [])) {
      const e = this._img({ id: `deco-${d.id}`, href: d.imageUrl,
        x: d.x, y: d.y, width: d.width, height: d.height,
        preserveAspectRatio: 'xMidYMid meet', class: 'deco-core' });
      if (e) {
        bg.appendChild(e);
        this._buildCoreShimmer(bg, d);
      }
    }
  },

  _buildCoreShimmer(layer, deco) {
    const g   = el('g', { id: `core-shimmer-${deco.id}`, class: 'core-shimmer' });
    const rng = this._seededRandom(77);
    const cx  = deco.x + deco.width  / 2;
    const cy  = deco.y + deco.height / 2;

    for (let i = 0; i < 40; i++) {
      const angle = rng() * Math.PI * 2;
      const dist  = Math.sqrt(rng());
      const x = cx + Math.cos(angle) * deco.width  * 0.43 * dist;
      const y = cy + Math.sin(angle) * deco.height * 0.43 * dist;
      const sr = rng();
      const r  = sr < 0.12 ? 2.3 : sr < 0.38 ? 1.3 : 0.65;
      const delay = (rng() * 6).toFixed(1);
      const dur   = (2 + rng() * 3.5).toFixed(1);
      const cr    = rng();
      const fill  = cr < 0.55 ? '#ffffff'
                  : cr < 0.70 ? '#c4b5fd'
                  : cr < 0.83 ? '#93c5fd'
                  : cr < 0.93 ? '#6ee7b7' : '#fde68a';
      g.appendChild(el('circle', {
        cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1),
        fill, opacity: '0',
        style: `animation:coreStarTwinkle ${dur}s ease-in-out ${delay}s infinite`
      }));
    }
    layer.appendChild(g);
  },

  _buildProjects() {
    const layer = this._svg.querySelector('#project-layer');
    for (const proj of (this._config.projects || [])) {
      const worldName = this._config.worlds.find(w => w.id === proj.worldId)?.name || `Мир ${proj.worldId}`;
      const g = el('g', { id: `project-${proj.worldId}`, class: 'project-group' });

      const broken = this._img({
        id: `proj-broken-${proj.worldId}`, href: proj.broken.url,
        x: proj.broken.x, y: proj.broken.y,
        width: proj.broken.width, height: proj.broken.height,
        preserveAspectRatio: 'xMidYMid meet', class: 'proj-broken'
      });
      if (broken) {
        this._attachTooltip(broken, () => ({
          type:  'project',
          title: `${proj.name || 'Проект'} · ${worldName}`,
          desc:  (proj.desc || '') + ' Ещё не исправлен.'
        }));
        g.appendChild(broken);
      }

      const fixed = this._img({
        id: `proj-fixed-${proj.worldId}`, href: proj.fixed.url,
        x: proj.fixed.x, y: proj.fixed.y,
        width: proj.fixed.width, height: proj.fixed.height,
        preserveAspectRatio: 'xMidYMid meet', class: 'proj-fixed hidden-element'
      });
      if (fixed) {
        this._attachTooltip(fixed, () => ({
          type:  'project',
          title: `${proj.name || 'Проект'} · ${worldName}`,
          desc:  (proj.desc || '') + ' Починен!'
        }));
        g.appendChild(fixed);
      }

      layer.appendChild(g);
    }
  },

  _buildChallenges() {
    const layer = this._svg.querySelector('#challenge-layer');
    for (const chal of (this._config.challenges || [])) {
      const e = this._img({
        id: `chal-img-${chal.worldId}`, href: chal.imageUrl,
        x: chal.x, y: chal.y, width: chal.width, height: chal.height,
        preserveAspectRatio: 'xMidYMid meet', class: 'chal-img hidden-element'
      });
      if (!e) continue;
      this._attachTooltip(e, () => ({
        type: 'challenge',
        title: chal.name || `Челлендж · Мир ${chal.worldId}`,
        desc:  chal.desc || ''
      }));
      layer.appendChild(e);
    }
  },

  _buildWorlds() {
    const layer = this._svg.querySelector('#world-layer');
    for (const w of this._config.worlds) {
      const cx = w.x + w.width  / 2;
      const cy = w.y + w.height / 2;

      const g = el('g', {
        id: `world-${w.id}`,
        class: 'world-group locked',
        'data-world': w.id,
        style: 'cursor: default'
      });

      // World PNG image
      const worldImg = this._img({
        id: `world-img-${w.id}`, href: w.imageUrl,
        x: w.x, y: w.y, width: w.width, height: w.height,
        preserveAspectRatio: 'xMidYMid meet', class: 'world-img'
      });
      if (worldImg) g.appendChild(worldImg);

      // Lock icon (shown when locked, hidden when unlocked)
      const lockG = el('g', {
        id: `world-lock-${w.id}`,
        class: 'world-lock-icon',
        transform: `translate(${cx.toFixed(0)}, ${cy.toFixed(0)})`
      });
      lockG.appendChild(el('circle', { cx: 0, cy: 0, r: 22, fill: 'rgba(0,2,15,0.65)' }));
      lockG.appendChild(el('rect',   { x: -9, y: 0, width: 18, height: 14, rx: 3,
        fill: '#1e2a5a', stroke: '#5567c0', 'stroke-width': 1.5 }));
      lockG.appendChild(el('path',   { d: 'M -5 0 A 5 5 0 0 1 5 0',
        fill: 'none', stroke: '#5567c0', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
      lockG.appendChild(el('circle', { cx: 0, cy: 7, r: 2.5, fill: '#5567c0' }));
      g.appendChild(lockG);

      // Tooltip — reads live class to decide locked vs unlocked
      this._attachTooltip(g, () => {
        const locked = g.classList.contains('locked');
        return {
          type:  locked ? 'locked' : 'world',
          title: `Мир ${w.id}: ${w.name}`,
          desc:  locked
            ? (w.lockedDesc || 'Введи код разблокировки, чтобы открыть этот мир.')
            : (w.desc || '')
        };
      });

      layer.appendChild(g);
    }
  },

  // ─── State update helpers (run on every render) ─────────────────────────────

  _updateWorldStates(appState) {
    for (const w of this._config.worlds) {
      const g  = this._svg.querySelector(`#world-${w.id}`);
      if (!g) continue;
      const ws = appState.worldsState.find(s => s.worldId === w.id);
      const unlocked = ws?.unlocked ?? false;

      g.classList.toggle('locked',   !unlocked);
      g.classList.toggle('unlocked',  unlocked);
    }
  },

  _updateProjectStates(appState) {
    for (const proj of (this._config.projects || [])) {
      const ws = appState.worldsState.find(s => s.worldId === proj.worldId);
      const projUnlocked = ws?.elements?.project?.unlocked ?? false;

      const broken = this._svg.querySelector(`#proj-broken-${proj.worldId}`);
      const fixed  = this._svg.querySelector(`#proj-fixed-${proj.worldId}`);
      if (!broken || !fixed) continue;

      if (projUnlocked) {
        broken.classList.add('hidden-element');
        fixed.classList.remove('hidden-element');
      } else {
        broken.classList.remove('hidden-element');
        fixed.classList.add('hidden-element');
      }
    }
  },

  _updateChallengeStates(appState) {
    for (const chal of (this._config.challenges || [])) {
      const ws = appState.worldsState.find(s => s.worldId === chal.worldId);
      const chalUnlocked = ws?.elements?.challenge?.unlocked ?? false;

      const img = this._svg.querySelector(`#chal-img-${chal.worldId}`);
      if (!img) continue;

      if (chalUnlocked) {
        img.classList.remove('hidden-element');
      } else {
        img.classList.add('hidden-element');
      }
    }
  },

  // ─── Utility ────────────────────────────────────────────────────────────────

  _seededRandom(seed) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }
};
