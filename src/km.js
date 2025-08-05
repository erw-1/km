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
 * @property {Function}ensureMarkdown  Lazy loader for marked + alert & footnotes extensions
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
const { TITLE, MD } = window.CONFIG;

/* *********************************************************************
   SECTION 3 • MARKDOWN / KaTeX LAZY‑LOADERS
************************************************************************ */
let mdReady = null; // will hold the Promise so we don’t import twice

/**
 * Ensures marked and DOMPurify are available, combined into a tiny API.
 * @returns {Promise<{parse:Function}>}
 */
KM.ensureMarkdown = () => {
  if (mdReady) return mdReady;

  mdReady = Promise.all([
    import('https://cdn.jsdelivr.net/npm/marked@5/lib/marked.esm.min.js'),
    import('https://cdn.jsdelivr.net/npm/marked-footnote/dist/index.umd.min.js'),
    import('https://cdn.jsdelivr.net/npm/marked-alert/dist/index.umd.min.js'), 
  ]).then(([marked, footnote]) => {
    const md = new marked.Marked().use(markedFootnote()).use(markedAlert());
    return {
      parse: (src, opt) => md.parse(src, { ...opt, mangle: false })
    };
  });

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
    ready = import('https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.mjs')
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
  .then(initUI)
  .then(() => new Promise(resolve => setTimeout(resolve, 50)))
  .then(highlightCurrent);

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
  $('#wiki-title-text').textContent = TITLE;
  document.title  = TITLE;

  // --- 6‑B  Sidebar tree ---------------------------------------------------
  buildTree();
  route(); 
   
  // --- 6‑C  Mini‑graph – lazy‑initialised when scrolled into view ----------
  new IntersectionObserver((entries, obs) => {
    if (entries[0].isIntersecting) {
      buildGraph();
      obs.disconnect();
    }
  }).observe($('#mini'));

  // --- 6‑D  Full‑screen graph  ----------------------------------------
  const mini = $('#mini');
  $('#expand').onclick = () => { mini.classList.toggle('fullscreen'); };

  // --- 6‑E  Search box -----------------------------------------------------
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

  /* ── Light / dark theme toggle ───────────────────────── */
  (() => {
    const btn   = $('#theme-toggle');
    const root  = document.documentElement;
    const media = matchMedia('(prefers-color-scheme: dark)');
  
    // initial state: localStorage > OS setting > default light
    let dark = localStorage.getItem('km-theme') === 'dark' ||
               (!localStorage.getItem('km-theme') && media.matches);
  
    apply(dark);
  
    btn.onclick = () => {
      dark = !dark;
      apply(dark);
      localStorage.setItem('km-theme', dark ? 'dark' : 'light');
    };
   
    // helper
    function apply(isDark) {
      root.style.setProperty('--color-main', isDark ? 'rgb(29,29,29)' : 'white');
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }
  })(); 

  // --- 6‑F  Burger toggles (mobile / portrait UI) -------------------------------------
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
    const siblings = n.parent.children.filter(s => s !== n);  // exclude current page
    if (siblings.length) {                                    // only show if something left
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
 * Prefixes every in-page foot-note link (<a href="#footnote-…">, #fn-…,
 * #fnref-…) with the current page-hash so that, e.g.
 *   #footnote-1            →  #mechanics#tech#footnote-1
 *   #fn-a                  →  #stresstest#fn-a
 *
 * Only the HREF is changed; the <li id="footnote-1"> etc. stay as-is so
 * `route()` still scrolls to plain “footnote-1”.
 */
function fixFootnoteLinks (page) {
  const base = hashOf(page);              // e.g. "mechanics#tech"
  if (!base) return;                      // root page ⇒ nothing to do

  $$('#content a[href^="#"]').forEach(a => {
    const href = a.getAttribute('href');  // "#footnote-1"
    if (/^#(?:fn|footnote)/.test(href) && !href.includes(base)) {
      a.setAttribute('href', `#${base}${href}`);   // "#mechanics#tech#footnote-1"
    }
  });
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
  const { parse } = await KM.ensureMarkdown();
  $('#content').innerHTML = parse(page.content, { headerIds: false });
  // make foot-note anchors hash-aware
  fixFootnoteLinks(page);

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
   SECTION 11 • GRAPH VISUALISATION (single SVG that can go full-screen)
************************************************************************ */

/* ─── CSS hooks ─── */
const IDS = {
  current : 'node_current',
  parent  : 'node_parent',
  leaf    : 'node_leaf',
  hier : 'link_hier',
  tag1 : 'link_tag1',
  tag2 : 'link_tag2',
  tag3 : 'link_tag3',
  label: 'graph_text'
};

/* Single-SVG bookkeeping */
const graphs   = {};      // { mini:{ node,label,sim,view,w,h,adj } }
let   CURRENT  = -1;

/* ────────────────────────────────────────────────────────────────────
   Build once – mini only
   ────────────────────────────────────────────────────────────────── */
function buildGraph () {
  if (graphs.mini) return;                    

  const { nodes, links, adj } = buildGraphData();
  const svg  = KM.d3.select('#mini');
  const box  = svg.node().getBoundingClientRect();
  const W    = box.width  || 300;
  const H    = box.height || 200;

  const localN = nodes.map(n => ({ ...n }));
  const localL = links.map(l => ({ ...l }));

  const sim = KM.d3
    .forceSimulation(localN)
    .force('link',   KM.d3.forceLink(localL).id(d => d.id).distance(80))
    .force('charge', KM.d3.forceManyBody().strength(-240))
    .force('center', KM.d3.forceCenter(W / 2, H / 2));

  /* One wrapper so we can pan the whole graph in one go */
  const view = svg.append('g').attr('class', 'view');

  /* Edges */
  const link = view.append('g').selectAll('line')
    .data(localL).join('line')
    .attr('id', d => d.kind === 'hier'
        ? IDS.hier
        : d.shared === 1 ? IDS.tag1
        : d.shared === 2 ? IDS.tag2
                         : IDS.tag3);

  /* Nodes */
  const node = view.append('g').selectAll('circle')
    .data(localN).join('circle')
    .attr('r', 6)
    .attr('id', d => d.ref.children.length ? IDS.parent : IDS.leaf)
    .style('cursor','pointer')
    .on('click', (e,d) => KM.nav(d.ref))
    .on('mouseover', (e,d) => fade(d.id,0.15))
    .on('mouseout',  ()   => fade(null,1))
    .call(KM.d3.drag()
      .on('start', (e,d) => { d.fx=d.x; d.fy=d.y; })
      .on('drag',  (e,d) => { sim.alphaTarget(0.3).restart(); d.fx=e.x; d.fy=e.y; })
      .on('end',   (e,d) => { if(!e.active) sim.alphaTarget(0); d.fx=d.fy=null; }));

  /* Labels */
  const label = view.append('g').selectAll('text')
    .data(localN).join('text')
    .attr('id', IDS.label)
    .attr('font-size',10)
    .text(d => d.label);

  /* Hover helper */
  function fade (id, o) {
    node .style('opacity',d=>(id==null||adj.get(id)?.has(d.id)||d.id===id)?1:o);
    label.style('opacity',d=>(id==null||adj.get(id)?.has(d.id)||d.id===id)?1:o);
    link .style('opacity', l =>id == null || l.source.id === id || l.target.id === id ? 1 : o);
  }

  /* Tick */
  sim.on('tick', () => {
    link
      .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node .attr('cx',d=>d.x)           .attr('cy',d=>d.y);
    label.attr('x', d=>d.x+8)         .attr('y', d=>d.y+3);
  });

  /* Store handles */
  graphs.mini = { node, label, sim, view, adj, w:W, h:H };

  observeMiniResize();                // start resize watcher
}

/* ────────────────────────────────────────────────────────────────────
   Re-skin current node (called from route()) & centre the view on it
   ────────────────────────────────────────────────────────────────── */
function highlightCurrent () {
  if (!graphs.mini) return; // graph not built yet
   
  const seg  = location.hash.slice(1).split('#').filter(Boolean);
  const pg   = find(seg);
  const id   = pg?._i ?? -1;
  if (id === CURRENT) return;

  const g = graphs.mini;
  g.node
    .attr('id', d=> d.id===id ? IDS.current
            : d.ref.children.length ? IDS.parent
                                    : IDS.leaf )
    .attr('r',  d=> d.id===id ? 8 : 6);
  g.label.classed('current', d=> d.id===id);

  /* Pan the whole graph so the highlighted node is centred */
  const cx = g.w / 2, cy = g.h / 2;
  g.node.filter(d => d.id === id).each(d => {
    const dx = cx - d.x;
    const dy = cy - d.y;
    g.view.attr('transform', `translate(${dx},${dy})`);

    /* Keep the existing nudge so the node eases back to the centre */
    const k = 0.35;
    d.vx += (cx - d.x) * k;
    d.vy += (cy - d.y) * k;
  });

  g.sim.alphaTarget(0.7).restart();
  setTimeout(() => g.sim.alphaTarget(0), 400);

  CURRENT = id;
}

/* ────────────────────────────────────────────────────────────────────
   Keep sim centred when #mini resizes
   ────────────────────────────────────────────────────────────────── */
function observeMiniResize () {
  new ResizeObserver(entries=>{
    const g = graphs.mini;
    if (!g) return;
    const { width:w, height:h } = entries[0].contentRect;
    g.w=w; g.h=h;
    g.sim.force('center', KM.d3.forceCenter(w/2,h/2));
    g.sim.alpha(0.3).restart();
  }).observe(document.getElementById('mini'));
}

/* ────────────────────────────────────────────────────────────────────
   Data helpers (unchanged)
   ────────────────────────────────────────────────────────────────── */
function buildGraphData () {
  const N=[], L=[], A=new Map();
  const touch = (a,b)=>{ (A.get(a)||A.set(a,new Set()).get(a)).add(b);
                         (A.get(b)||A.set(b,new Set()).get(b)).add(a); };
  const overlap = (A,B)=>{let n=0;for(const x of A)if(B.has(x))n++;return n;};

  pages.forEach((p,i)=>{ p._i=i; p.tagsSet=p.tagsSet||new Set(p.tags); });

  pages.forEach(p=>{
    N.push({id:p._i,label:p.title,ref:p});
    if(p.parent){ L.push({source:p._i,target:p.parent._i,shared:0,kind:'hier'}); touch(p._i,p.parent._i); }
  });

  pages.forEach((a,i)=>{ for(let j=i+1;j<pages.length;j++){
    const b=pages[j], n=overlap(a.tagsSet,b.tagsSet);
    if(n){ L.push({source:a._i,target:b._i,shared:n,kind:'tag'}); touch(a._i,b._i);} } });

  return { nodes:N, links:L, adj:A };
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
  highlightCurrent(); 
}
