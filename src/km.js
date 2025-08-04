/* *********************************************************************
   SECTION 0 • MICRO‑NAMESPACE SETUP
   All library shims, DOM helpers and constants live inside one global
   object KM so we never collide with other scripts/extensions.
************************************************************************ */

/**
 * Global namespace: everything attaches here so dev‑tools autocompletion
 * can reveal the entire public API in one go. Feel free to browse it via
 * console.dir(window.KM).
 *
 * @namespace KM
 * @property {Object}  d3              Selected D3 sub‑modules re‑exported
 * @property {Function}ensureHighlight Lazy loader for highlight.js subset
 * @property {Function}ensureMarkdown  Lazy loader for marked + DOMPurify
 * @property {Function}ensureKatex     Lazy loader for KaTeX auto‑render
 */
window.KM = {};

/* Single‑letter DOM shorthands ------------------------------------------------
   querySelector / querySelectorAll without the hand‑cramp. These survive the
   refactor unchanged because they’re ubiquitous later on.                     */
const $  = (s, c = document) => (c).querySelector(s);
const $$ = (s, c = document) => [...(c).querySelectorAll(s)];
Object.assign(KM, { $, $$ });

/* *********************************************************************
   SECTION 1 • D3 MICRO‑BUNDLE + HIGHLIGHT.JS LOADER
************************************************************************ */
// --- 1‑A  D3: cherry‑picked to 6 KB instead of 200 KB full build -------
import {
  select, selectAll                    // DOM selections
} from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import {
  forceSimulation, forceLink,
  forceManyBody, forceCenter           // force‑directed graph engine
} from 'https://cdn.jsdelivr.net/npm/d3-force@3/+esm';
import { drag }                        from 'https://cdn.jsdelivr.net/npm/d3-drag@3/+esm';
KM.d3 = { select, selectAll, forceSimulation, forceLink, forceManyBody, forceCenter, drag };

// --- 1‑B  highlight.js on‑demand --------------------------------------
/**
 * Loads highlight.js once and registers only the languages requested in
 * `CONFIG.LANGS` (see config.js).
 *
 * @returns {Promise<void>} Resolves when `window.hljs` is ready
 */
KM.ensureHighlight = (() => {
  let ready; // memoised singleton Promise
  return function ensureHighlight () {
    if (ready) return ready;           // already inflight or done ✔

    ready = (async () => {
      const { LANGS = [] } = window.CONFIG;
      const core = await import('https://cdn.jsdelivr.net/npm/highlight.js@11/es/core/+esm');
      const hljs = core.default;
      await Promise.all(
        LANGS.map(async lang => {
          const mod = await import(`https://cdn.jsdelivr.net/npm/highlight.js@11/es/languages/${lang}/+esm`);
          hljs.registerLanguage(lang, mod.default);
        })
      );
      window.hljs = hljs; // expose globally for devtools convenience
    })();

    return ready;
  };
})();

/* *********************************************************************
   SECTION 2 • CONFIG EXTRACTION
************************************************************************ */
const { TITLE, FAVICON, MD, GRAPH_COLORS } = window.CONFIG;

/* *********************************************************************
   SECTION 3 • MARKDOWN / KaTeX LAZY‑LOADERS
************************************************************************ */
let mdReady = null; // will hold the Promise so we don’t import twice

/**
 * Ensures marked and DOMPurify are available, combined into a tiny API.
 * @returns {Promise<{parse:Function,sanitize:Function}>}
 */
KM.ensureMarkdown = () => {
  if (mdReady) return mdReady;

  mdReady = Promise.all([
    import('https://cdn.jsdelivr.net/npm/marked@5/lib/marked.esm.js'),
    import('https://cdn.jsdelivr.net/npm/dompurify@3/+esm')
  ]).then(([marked, DOMPurify]) => ({
    parse: (src, opt) => marked.marked.parse(src, { ...opt, mangle: false }),
    sanitize: html => DOMPurify.default.sanitize(html, {
      ADD_TAGS: ['iframe', 'input', 'td', 'th'],
      ADD_ATTR: [
        'allow', 'allowfullscreen', 'frameborder', 'scrolling',
        'width', 'height', 'src', 'title', 'style', 'type',
        'input', 'checked', 'disabled'
      ],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#).*$/i
    })
  }));

  return mdReady;
};

/**
 * Loads KaTeX auto‑render bundle if needed (detected per page).
 * @returns {Promise<void>}
 */
KM.ensureKatex = (() => {
  let ready;
  return function ensureKatex () {
    if (ready) return ready;
    ready = import('https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.mjs')
      .then(mod => { window.renderMathInElement = mod.default; });
    return ready;
  };
})();

/* *********************************************************************
   SECTION 4 • IN‑MEMORY WIKI DATABASE
************************************************************************ */
const pages = [];          // flat list of every article
const byId  = new Map();   // quick lookup: id → page object
let   root  = null;        // defined after Markdown fetch resolves

// Fetch the bundled Markdown (compiled via build‑script or manual c&p) -----
fetch(MD, { cache: 'reload' })
  .then(res => res.text())
  .then(parseMarkdownBundle)
  .then(initUI);

/**
 * Parses the special comment‑delimited Markdown bundle produced by the build
 * script. Each article is fenced by an HTML comment containing its metadata,
 * e.g. `<!--id:"home" tags:"foo" parent:"home"-->`.
 *
 * @param {string} txt Raw Markdown bundle
 */
function parseMarkdownBundle (txt) {
  for (const [, hdr, body] of txt.matchAll(/<!--([\s\S]*?)-->\s*([\s\S]*?)(?=<!--|$)/g)) {
    const meta = {};
    hdr.replace(/(\w+):"([^"]+)"/g, (_, k, v) => (meta[k] = v.trim()));
    pages.push({ ...meta, content: body.trim(), children: [] });
  }

  // Build parent → children relationships -----------------------------------
  pages.forEach(p => byId.set(p.id, p));
  root = byId.get('home') || pages[0];
  pages.forEach(p => {
    if (p !== root) {
      const par = byId.get(p.parent) || root;
      p.parent  = par;
      par.children.push(p);
    }
  });

  // Pre‑compute helper sets for search (case‑insensitive, accent‑aware) ------
  const wordRE = /\p{L}+/gu; // Unicode letter class
  pages.forEach(p => {
    p.tagsSet   = new Set((p.tags || '').split(',').filter(Boolean));
    const combo = `${p.title} ${[...p.tagsSet].join(' ')} ${p.content}`;
    p.wordSet   = new Set(combo.toLowerCase().match(wordRE) || []);
    p.searchStr = combo.toLowerCase();
  });
}

/* *********************************************************************
   SECTION 5 • URL HELPERS & ROUTING UTILITIES
************************************************************************ */
/**
 * Transforms a page object into its URL hash, e.g. `a#b#c`.
 * @param   {Object} page
 * @returns {string}
 */
const hashOf = page => {
  const segs = [];
  for (let n = page; n && n.parent; n = n.parent) segs.unshift(n.id);
  return segs.join('#');
};

/**
 * Resolves an array of id segments back to a page object.
 * The lookup is tolerant: it will stop at the deepest existing page.
 * @param   {string[]} segs
 * @returns {Object}
 */
const find = segs => {
  let n = root;
  for (const id of segs) {
    const c = n.children.find(k => k.id === id);
    if (!c) break;
    n = c;
  }
  return n;
};

/** Navigates to a page by mutating `location.hash`. */
const nav = page => (location.hash = '#' + hashOf(page));
KM.nav = nav; // expose for dev‑tools

/* *********************************************************************
   SECTION 6 • UI BOOTSTRAP (called once Markdown is ready)
************************************************************************ */
function closePanels () {
  $('#sidebar').classList.remove('open');
  $('#util'   ).classList.remove('open');
};

function initUI () {
  // --- 6‑A  Static header tweaks -------------------------------------------
  $('#wiki-title').textContent = TITLE;
  document.title               = TITLE;
  $('#favicon-el').href        = FAVICON;

  // --- 6‑B  Sidebar tree ---------------------------------------------------
  buildTree();

  // --- 6‑C  Initial route --------------------------------------------------
  route(); // handles #hash & renders page

  // --- 6‑D  Mini‑graph – lazy‑initialised when scrolled into view ----------
  new IntersectionObserver((entries, obs) => {
    if (entries[0].isIntersecting) {
      buildGraph();
      obs.disconnect();
    }
  }).observe($('#mini'));

  // --- 6‑E  Full‑screen graph modal ----------------------------------------
  $('#expand').onclick       = () => { $('#modal').classList.add('open'); buildGraph(); };
  $('#modal .close').onclick = () => $('#modal').classList.remove('open');

  // --- 6‑F  Search box -----------------------------------------------------
  const searchInput = $('#search');
  const searchClear = $('#search-clear');
  let debounce = 0;
  searchInput.oninput = e => {
    clearTimeout(debounce);
    const val = e.target.value;
    searchClear.style.display = val ? '' : 'none';
    debounce = setTimeout(() => search(val.toLowerCase()), 150);
  };
  searchClear.onclick = () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    search('');
    searchInput.focus();
  };

  // --- 6‑G  Burger toggles (mobile / portrait UI) -------------------------------------
  const togglePanel = sel => {
    const el      = $(sel);
    const wasOpen = el.classList.contains('open');

    closePanels();                       // always start closed

    if (!wasOpen) {                      // reopen only if it wasn’t open
      el.classList.add('open');

      // add the ✕ button once per panel
      if (!el.querySelector('.panel-close')) {
        const btn = document.createElement('button');
        btn.className = 'panel-close';
        btn.textContent = '✕';
        btn.onclick = closePanels;
        el.appendChild(btn);
      }
    }
  };

  $('#burger-sidebar').onclick = () => togglePanel('#sidebar');
  $('#burger-util').onclick    = () => togglePanel('#util');

  // Auto‑close panels when resizing back to desktop -------------------------
  addEventListener('resize', () => {
    if (matchMedia('(min-width:1001px)').matches) {
      $('#sidebar').classList.remove('open');
      $('#util').classList.remove('open');
    }
  });

  // In‑app routing ----------------------------------------------------------
  addEventListener('hashchange', route);
}

/* *********************************************************************
   SECTION 7 • SIDEBAR TREE
************************************************************************ */
/** Build the hierarchical tree in the sidebar (first 2 levels open). */
function buildTree () {
  const ul = $('#tree');
  ul.innerHTML = '';

  /** Recursive side‑bar builder. */
  const rec = (list, container, depth = 0) => {
    list.sort((a, b) => a.title.localeCompare(b.title));

    list.forEach(p => {
      const li = document.createElement('li');

      // Folder / parent ------------------------------------------------------
      if (p.children.length) {
        const open = depth < 2; // auto‑open first two levels
        li.className = 'folder' + (open ? ' open' : '');

        // Caret arrow --------------------------------------------------------
        const caret = document.createElement('button');
        caret.className = 'caret';
        caret.setAttribute('aria-expanded', String(open));
        caret.onclick = e => {
          e.stopPropagation();
          const isOpen = li.classList.toggle('open');
          caret.setAttribute('aria-expanded', String(isOpen));
          sub.style.display = isOpen ? 'block' : 'none';
        };

        // Folder label -------------------------------------------------------
        const lbl = document.createElement('a');
        lbl.className = 'lbl';
        lbl.href = '#' + hashOf(p);
        lbl.textContent = p.title;

        const sub = document.createElement('ul');
        sub.style.display = open ? 'block' : 'none';

        li.append(caret, lbl, sub);
        container.appendChild(li);

        rec(p.children, sub, depth + 1);
      } else {
        // Leaf / article -----------------------------------------------------
        li.className = 'article';
        const a = document.createElement('a');
        a.href = '#' + hashOf(p);
        a.textContent = p.title;
        li.appendChild(a);
        container.appendChild(li);
      }
    });
  };

  rec(root.children, ul);
}

/* *********************************************************************
   SECTION 8 • CLIENT‑SIDE SEARCH (simple substring, ≥2 chars)
************************************************************************ */
function search (q) {
  const resUL  = $('#results');
  const treeUL = $('#tree');

  if (!q.trim()) { // empty → show tree again
    resUL.style.display  = 'none';
    treeUL.style.display = '';
    return;
  }

  const tokens = q.split(/\s+/).filter(t => t.length >= 2);
  resUL.innerHTML      = '';
  resUL.style.display  = '';
  treeUL.style.display = 'none';

  pages
    .filter(p => tokens.every(tok => p.searchStr.includes(tok)))
    .forEach(p => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = p.title;
      li.onclick = () => {                // auto-collapse on mobile
        nav(p);
        closePanels();
      };
      resUL.appendChild(li);
    });

  if (!resUL.children.length) resUL.innerHTML = '<li id="no_result">No result</li>';
}

/* *********************************************************************
   SECTION 9 • BREADCRUMB NAVIGATION
************************************************************************ */
function breadcrumb (page) {
  const dyn = $('#crumb-dyn');
  dyn.innerHTML = '';

  // Ancestors chain (excluding root because of home‑icon) -------------------
  const chain = [];
  for (let n = page; n; n = n.parent) chain.unshift(n);
  chain.shift();

  chain.forEach(n => {
    dyn.insertAdjacentHTML('beforeend', '<span class="separator">▸</span>');

    // Wrapper to host dropdown ---------------------------------------------
    const wrap = document.createElement('span');
    wrap.className = 'dropdown';

    const a = document.createElement('a');
    a.textContent = n.title;
    a.href = '#' + hashOf(n);
    if (n === page) a.className = 'crumb-current';
    wrap.appendChild(a);

    // Dropdown with siblings -----------------------------------------------
    const siblings = n.parent.children;
    if (siblings.length > 1) {
      const ul = document.createElement('ul');
      siblings.forEach(s => {
        const li = document.createElement('li');
        li.textContent = s.title;
        li.onclick = () => nav(s);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }

    dyn.appendChild(wrap);
  });

  // Child quick‑select ------------------------------------------------------
  if (page.children.length) {
    const box = document.createElement('span');
    box.className = 'childbox';
    box.innerHTML = '<span class="toggle">▾</span><ul></ul>';

    const ul = box.querySelector('ul');
    page.children
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach(ch => {
        const li = document.createElement('li');
        li.textContent = ch.title;
        li.onclick = () => nav(ch);
        ul.appendChild(li);
      });
    dyn.appendChild(box);
  }
}

/* *********************************************************************
   SECTION 10 • MARKDOWN RENDER PIPELINE
************************************************************************ */
/** Numbers headings (h1–h5) and sets predictable ids for deep‑links. */
function numberHeadings (el) {
  const counters = [0, 0, 0, 0, 0, 0];
  $$('h1,h2,h3,h4,h5', el).forEach(h => {
    const level = +h.tagName[1] - 1;
    counters[level]++;
    for (let i = level + 1; i < 6; i++) counters[i] = 0;
    h.id = counters.slice(0, level + 1).filter(Boolean).join('_');
  });
}

/** Generates the right‑side Table‑of‑Contents (h1–h3). */
function buildToc (page) {
  const nav = $('#toc');
  nav.innerHTML = '';
  const headings = $$('#content h1,#content h2,#content h3');
  if (!headings.length) return;

  const ul = document.createElement('ul');
  headings.forEach(h => {
    const li = document.createElement('li');
    li.dataset.level = h.tagName[1];
    const a = document.createElement('a');
    const base = hashOf(page);
    a.href = '#' + (base ? base + '#' : '') + h.id;
    a.textContent = h.textContent;
    li.appendChild(a);
    ul.appendChild(li);
  });
  nav.appendChild(ul);
}

/** Injects «previous / next» links between siblings for linear reading. */
function prevNext (page) {
  $('#prev-next')?.remove();
  if (!page.parent) return;

  const sib = page.parent.children;
  if (sib.length < 2) return;

  const i = sib.indexOf(page);
  const nav = document.createElement('div');
  nav.id = 'prev-next';

  if (i > 0) nav.appendChild(Object.assign(document.createElement('a'), {
    href: '#' + hashOf(sib[i - 1]),
    textContent: '← ' + sib[i - 1].title
  }));

  if (i < sib.length - 1) nav.appendChild(Object.assign(document.createElement('a'), {
    href: '#' + hashOf(sib[i + 1]),
    textContent: sib[i + 1].title + ' →'
  }));

  $('#content').appendChild(nav);
}

/**
 * High‑level page renderer orchestrating Markdown → HTML, syntax highlight,
 * math typesetting, ToC generation and deep‑link scrolling.
 *
 * @param {Object} page   Page object to render
 * @param {string} anchor Optional heading id to scroll to
 */
async function render (page, anchor) {
  // 1. Markdown → raw HTML ---------------------------------------------------
  const { parse, sanitize } = await KM.ensureMarkdown();
  $('#content').innerHTML = sanitize(parse(page.content, { headerIds: false }));

  // 2. Number headings so «h2 1.2.3» deep‑links remain stable -------------
  numberHeadings($('#content'));

  // 3. Syntax highlight -----------------------------------------------------
  await KM.ensureHighlight();
  window.hljs.highlightAll();

  // 4. Math typesetting -----------------------------------------------------
  if (/(\$[^$]+\$|\\\(|\\\[)/.test(page.content)) {
    await KM.ensureKatex();
    window.renderMathInElement($('#content'), {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });
  }

  // 5. ToC + sibling prev/next ---------------------------------------------
  buildToc(page);
  prevNext(page);

  // 6. Optional deep‑link scroll -------------------------------------------
  if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' });
}

/* *********************************************************************
   SECTION 11 • GRAPH VISUALISATION (Mini‑map & Full‑screen)
************************************************************************ */
/** Builds node/edge arrays for D3 from pages + tag overlap. */
function buildGraphData () {
  const nodes = [], links = [], adj = new Map(); // adjacency list for hover

  // Numeric index for every page (stable reference for D3) ------------------
  pages.forEach((p, i) => (p._i = i));

  // Hierarchical edges ------------------------------------------------------
  pages.forEach(p => {
    nodes.push({ id: p._i, label: p.title, ref: p });
    if (p.parent) {
      links.push({ source: p._i, target: p.parent._i, kind: 'hier' });
      addAdj(p._i, p.parent._i);
    }
  });

  // Tag‑based edges (shared tags) ------------------------------------------
  const tagMap = new Map();
  pages.forEach(p => p.tagsSet.forEach(t => {
    if (!tagMap.has(t)) tagMap.set(t, []);
    tagMap.get(t).push(p);
  }));

  tagMap.forEach(list => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (!adj.get(a._i)?.has(b._i)) {
          links.push({ source: a._i, target: b._i, kind: 'tag' });
          addAdj(a._i, b._i);
        }
      }
    }
  });

  function addAdj (a, b) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  }

  return { nodes, links, adj };
}

/** Renders both the «mini» and «full» SVG graphs. */
function buildGraph () {
  const { nodes, links, adj } = buildGraphData();

  ['mini', 'full'].forEach(id => {
    const svg  = KM.d3.select('#' + id);
    svg.selectAll('*').remove(); // clear previous render

    const full = id === 'full';
    const w = svg.node().clientWidth  || 300;
    const h = svg.node().clientHeight || 200;

    // Clone nodes/links so each simulation is independent -------------------
    const localNodes = nodes.map(n => ({ ...n }));
    const localLinks = links.map(l => ({ source: l.source, target: l.target, kind: l.kind }));

    const sim = KM.d3.forceSimulation(localNodes)
      .force('link',   KM.d3.forceLink(localLinks).id(d => d.id).distance(80))
      .force('charge', KM.d3.forceManyBody().strength(-240))
      .force('center', KM.d3.forceCenter(w / 2, h / 2));

    // Edges ---------------------------------------------------------------
    const link = svg.append('g').selectAll('line')
      .data(localLinks).join('line')
      .attr('stroke', d => d.kind === 'tag' ? GRAPH_COLORS.tag : GRAPH_COLORS.hier)
      .attr('stroke-width', 1);

    // Nodes ---------------------------------------------------------------
    const node = svg.append('g').selectAll('circle')
      .data(localNodes).join('circle')
      .attr('r', 6)
      .attr('fill', d => d.ref.children.length ? GRAPH_COLORS.parent : GRAPH_COLORS.leaf)
      .style('cursor', 'pointer')
      .on('click', (e, d) => { nav(d.ref); if (full) $('#modal').classList.remove('open'); })
      .on('mouseover', (e, d) => highlight(d.id, 0.15))
      .on('mouseout',  ()    => highlight(null, 1))
      .call(KM.d3.drag()
        .on('start', (e, d) => { d.fx = d.x; d.fy = d.y; })
        .on('drag',  (e, d) => {
          if (e.dx || e.dy) sim.alphaTarget(0.3).restart();
          d.fx = e.x; d.fy = e.y;
        })
        .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = d.fy = null; })
      );

    // Labels --------------------------------------------------------------
    const label = svg.append('g').selectAll('text')
      .data(localNodes).join('text')
      .attr('fill', GRAPH_COLORS.label)
      .attr('font-size', 10)
      .text(d => d.label);

    // Hover helper --------------------------------------------------------
    function highlight (id, fade) {
      node.style('opacity', o => (id == null || adj.get(id)?.has(o.id) || o.id === id) ? 1 : fade);
      link.style('opacity', l => (id == null || l.source.id === id || l.target.id === id) ? 1 : fade);
      label.style('opacity', o => (id == null || adj.get(id)?.has(o.id) || o.id === id) ? 1 : fade);
    }

    // Simulation loop -----------------------------------------------------
    sim.on('tick', () => {
      link .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
           .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

      node .attr('cx', d => d.x)        .attr('cy', d => d.y);
      label.attr('x',  d => d.x + 8)    .attr('y', d => d.y + 3);
    });
  });
}

/* *********************************************************************
   SECTION 12 • CLIENT‑SIDE ROUTER
************************************************************************ */
function route () {
  closePanels();
  const seg     = location.hash.slice(1).split('#').filter(Boolean);
  const page    = find(seg);
  const anchor  = seg.slice(hashOf(page).split('#').length).join('#');

  // Reset scroll (iOS Safari needs both roots) -----------------------------
  document.documentElement.scrollTop = 0;
  document.body.scrollTop            = 0;

  breadcrumb(page);
  render(page, anchor);
}

// Kick‑off if user lands on '/' (no Markdown yet → wait) ------------------
if (pages.length) route();
