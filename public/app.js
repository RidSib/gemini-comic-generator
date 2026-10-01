const app = document.getElementById('app');
let config = { hasKey: true, maxPages: 12, quickMaxPages: 5, maxPanels: 8, imageModels: [], defaultModel: 'lite', testAll: 'all', videoModels: [], defaultVideoModel: 'lite' };
let pollTimer = null;

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Replace the view; accepts nested arrays and skips falsy entries like h() does.
const mount = (...nodes) => app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));

const STATUS_LABEL = { outline: 'Outline', generating: 'Drawing', done: 'Done', error: 'Incomplete' };
const badge = (status) => h('span', { class: `badge ${status}` }, STATUS_LABEL[status] || status);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const CLIP_SPEED = 3; // 8 s clip -> a loop of under 3 s

// A page has one "render" (image + status) per image model; test comics have all models.
const pageSrc = (comic, render) => `/comics/${comic.id}/${render.image}?v=${render.version || ''}`;
const isTest = (comic) => comic.models.length > 1;
const modelLabel = (key) => config.imageModels.find((m) => m.key === key)?.label || key;
const testBadge = () => h('span', { class: 'badge test' }, 'Test feature');

const videoLabel = (key) => config.videoModels.find((m) => m.key === key)?.label || key;
// The finished clip for a render, unless animation is off or the clip belongs to an older drawing.
const clipOf = (comic, r) => (comic.animate && r.video?.status === 'done' && r.video.sourceVersion === r.version ? r.video : null);

// A page image, or its looping clip when it has one. Clips are 8 s, played sped up and muted.
function media(comic, r, attrs) {
  const clip = clipOf(comic, r);
  if (!clip) return h('img', { src: pageSrc(comic, r), ...attrs });
  const video = h('video', {
    src: `/comics/${comic.id}/${clip.file}?v=${clip.version}`, poster: pageSrc(comic, r),
    autoplay: true, loop: true, playsinline: true, 'aria-label': attrs.alt, title: attrs.title, onclick: attrs.onclick,
  });
  video.muted = true;
  video.defaultPlaybackRate = video.playbackRate = CLIP_SPEED;
  return h('div', { class: `clip ${attrs.class || ''}` }, video);
}

// "Animate" checkbox plus video model choice. value() is the model key, or null when off.
function animateControl(initial, onchange) {
  const select = h('select', { 'aria-label': 'Video model', onchange: () => onchange?.() },
    config.videoModels.map((m) => h('option', { value: m.key }, m.label + (m.key === config.defaultVideoModel ? ' (default)' : ''))));
  select.value = initial || config.defaultVideoModel;
  select.disabled = !initial;
  const box = h('input', { type: 'checkbox', onchange: () => { select.disabled = !box.checked; onchange?.(); } });
  box.checked = Boolean(initial);
  return {
    value: () => (box.checked ? select.value : null),
    el: h('div', { class: 'animate' },
      h('label', { class: 'check' }, box, ' Animate pages'),
      select,
      h('p', { class: 'muted small' }, 'Each finished page becomes a short looping clip with subtle motion inside the panels. Slower and considerably more expensive than still pages.')),
  };
}

function modelSelect(value, onchange) {
  const select = h('select', { id: 'model', onchange: (e) => onchange?.(e.target.value) },
    config.imageModels.map((m) => h('option', { value: m.key }, m.label + (m.key === config.defaultModel ? ' (default)' : ''))),
    h('option', { value: config.testAll }, `Test all ${config.imageModels.length} models side by side (test feature)`));
  select.value = value;
  return select;
}
const errorBox = (msg) => h('div', { class: 'notice error' }, msg);

// ---------- landing ----------

async function renderHome() {
  const prompt = h('textarea', {
    rows: 4, id: 'prompt',
    placeholder: 'A lighthouse keeper discovers the fog is alive and lonely…',
  });
  const status = h('div');
  const testNote = h('div', { class: 'notice test', hidden: true }, testBadge(),
    ` Every page is drawn ${config.imageModels.length} times, once per model, and shown side by side for comparison. Takes longer and uses ${config.imageModels.length}× the image credits.`);
  const model = modelSelect(config.defaultModel, (v) => { testNote.hidden = v !== config.testAll; });
  const animate = animateControl(null);
  const outlineBtn = h('button', { class: 'primary' }, 'Plan outline first');
  const quickBtn = h('button', { class: 'hot' }, 'Generate instantly');

  async function start(endpoint, message) {
    if (!prompt.value.trim()) { status.replaceChildren(errorBox('Please describe your comic first.')); return; }
    outlineBtn.disabled = quickBtn.disabled = true;
    status.replaceChildren(h('div', { class: 'notice' }, h('span', { class: 'spinner' }), message));
    try {
      const comic = await api('POST', endpoint, { prompt: prompt.value, model: model.value, animate: animate.value() });
      location.hash = `#/c/${comic.id}`;
    } catch (err) {
      status.replaceChildren(errorBox(err.message));
      outlineBtn.disabled = quickBtn.disabled = false;
    }
  }
  outlineBtn.onclick = () => start('/api/outline', 'Planning the story and page count…');
  quickBtn.onclick = () => start('/api/quick', 'Planning the story, then straight to drawing…');

  const gallery = h('div', { class: 'gallery' });
  mount(
    h('h1', {}, 'Turn an idea into a comic'),
    h('p', { class: 'lede' }, 'Describe a story. Gemini plans the pages and panels, then draws each page as one multi-panel image.'),
    !config.hasKey && h('div', { class: 'notice error' },
      'No API key found. Copy ', h('code', {}, '.env.example'), ' to ', h('code', {}, '.env'),
      ', add your ', h('code', {}, 'GEMINI_API_KEY'), ' and restart the server.'),
    h('div', { class: 'panel' },
      h('label', { for: 'prompt', style: 'margin-top:0' }, 'Your comic idea'),
      prompt,
      h('label', { for: 'model' }, 'Image model'),
      model,
      testNote,
      animate.el,
      h('div', { class: 'actions' },
        outlineBtn, quickBtn,
        h('span', { class: 'muted small' },
          `Outline first lets you edit the story and page count. Instant goes with the best guess, max ${config.quickMaxPages} pages.`)),
      status),
    h('h2', {}, 'Your comics'),
    gallery,
  );

  try {
    const comics = await api('GET', '/api/comics');
    if (!comics.length) { gallery.replaceWith(h('p', { class: 'muted' }, 'Nothing here yet. Your comics will show up here once you make one.')); return; }
    gallery.replaceChildren(...comics.map((c) =>
      h('a', { class: 'comic-card', href: `#/c/${c.id}` },
        h('div', { class: 'cover' },
          c.cover ? h('img', { src: `/comics/${c.id}/${c.cover}`, alt: '', loading: 'lazy' }) : h('div', { class: 'placeholder' }, '?')),
        h('div', { class: 'meta' },
          h('div', { class: 'title' }, c.title),
          h('div', { class: 'muted small', style: 'margin:4px 0 8px' },
            `${plural(c.pageCount, 'page')} · ${new Date(c.createdAt).toLocaleDateString()}`),
          badge(c.status), ' ', c.animated && h('span', { class: 'badge' }, 'Animated'), ' ', c.test && testBadge()))));
  } catch (err) {
    gallery.replaceWith(errorBox(err.message));
  }
}

// ---------- breakdown editor (outline before drawing, and edits afterwards) ----------

function renderOutline(comic) {
  const editing = comic.status !== 'outline'; // comic already drawn: only changed pages get redrawn
  // Work on a plain copy; inputs write straight into it.
  const draft = {
    title: comic.title, style: comic.style,
    characters: comic.characters.map((c) => ({ ...c })),
    pages: comic.pages.map((p) => ({ id: p.id, summary: p.summary, layout: p.layout, panels: p.panels.map((pn) => ({ ...pn })) })),
  };
  let model = isTest(comic) ? config.testAll : comic.models[0];
  // Switching to a model (or to the test) that has not drawn this comic yet means drawing every page.
  const addsModel = () => (model === config.testAll ? config.imageModels.map((m) => m.key) : [model]).some((k) => !comic.models.includes(k));

  // Mirrors what goes into a page's image prompt on the server (title and page order do not).
  const t = (v) => String(v ?? '').trim();
  const pageSig = (p) => JSON.stringify([t(p.summary), t(p.layout),
    p.panels.map((pn) => [t(pn.description), t(pn.dialogue)]).filter(([d, l]) => d || l)]);
  const sharedSig = (o) => JSON.stringify([t(o.style),
    o.characters.map((c) => [t(c.name), t(c.description)]).filter(([n, d]) => n || d)]);
  const upToDate = (p) => Object.values(p.renders).every((r) => r.image && r.status === 'done');
  const drawn = new Map(comic.pages.filter(upToDate).map((p) => [p.id, pageSig(p)]));
  const drawnShared = sharedSig(comic);
  const willRedraw = (p) => addsModel() || sharedSig(draft) !== drawnShared || drawn.get(p.id) !== pageSig(p);

  const status = h('div');
  let refresh = () => {};
  const animate = animateControl(comic.animate, () => refresh());
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; refresh(); };
  const rerender = () => { const y = scrollY; draw(); scrollTo(0, y); };

  function draw() {
    const full = draft.pages.length >= config.maxPages;
    const generateBtn = h('button', { class: 'primary' });
    const saveBtn = !editing && h('button', {}, 'Save draft');
    const flags = draft.pages.map(() => h('span', { class: 'badge generating' }, 'Will be redrawn'));

    refresh = () => {
      if (!editing) { generateBtn.textContent = `Draw comic (${plural(draft.pages.length, 'page')})`; return; }
      const n = draft.pages.filter((p, i) => !(flags[i].hidden = !willRedraw(p))).length;
      const newClips = animate.value() && animate.value() !== comic.animate;
      generateBtn.textContent = n ? `Save & redraw ${plural(n, 'page')}` : newClips ? 'Save & animate' : 'Save';
    };

    async function submit(generate) {
      generateBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      try {
        if (generate) await api('POST', `/api/comics/${comic.id}/generate`, { outline: draft, model, animate: animate.value() });
        else await api('PUT', `/api/comics/${comic.id}`, { outline: draft, model, animate: animate.value() });
        if (generate) { location.hash = `#/c/${comic.id}`; return route(); }
        status.replaceChildren(h('span', { class: 'muted small' }, 'Draft saved.'));
      } catch (err) {
        status.replaceChildren(errorBox(err.message));
      }
      generateBtn.disabled = false;
      if (saveBtn) saveBtn.disabled = false;
    }
    generateBtn.onclick = () => submit(true);
    if (saveBtn) saveBtn.onclick = () => submit(false);

    // Current drawing of an existing page, for the thumbnail.
    const original = (p) => Object.values(comic.pages.find((o) => o.id === p.id)?.renders || {}).find((r) => r.image);

    mount(
      h('p', { class: 'small' }, editing ? h('a', { href: `#/c/${comic.id}` }, '← Back to comic') : h('a', { href: '#/' }, '← All comics')),
      h('h1', {}, editing ? 'Edit breakdown' : 'Review the outline'),
      h('p', { class: 'lede' }, editing
        ? 'Change the story, panels or dialogue. When you save, only the pages whose breakdown changed are redrawn. Changing the art style, a character or the image model redraws every page.'
        : `Suggested length: ${plural(comic.pages.length, 'page')}. Edit anything, add or remove pages and panels, then draw. Each page becomes one image with all its panels.`),
      h('p', { class: 'muted small' }, 'Prompt: ', comic.prompt),

      h('div', { class: 'panel' },
        h('label', { style: 'margin-top:0' }, 'Title'),
        h('input', { type: 'text', value: draft.title, oninput: bind(draft, 'title') }),
        h('label', {}, 'Art style'),
        h('textarea', { rows: 2, value: draft.style, oninput: bind(draft, 'style') }),
        h('label', { for: 'model' }, 'Image model'),
        modelSelect(model, (v) => { model = v; refresh(); }),
        animate.el,
        h('label', {}, 'Characters'),
        draft.characters.map((c, i) => h('div', { class: 'row' },
          h('input', { type: 'text', placeholder: 'Name', value: c.name, oninput: bind(c, 'name') }),
          h('textarea', { rows: 2, placeholder: 'What they look like', value: c.description, oninput: bind(c, 'description') }),
          h('button', { class: 'ghost', onclick: () => { draft.characters.splice(i, 1); rerender(); } }, 'Remove'))),
        h('button', { class: 'ghost', onclick: () => { draft.characters.push({ name: '', description: '' }); rerender(); } }, '+ Add character')),

      draft.pages.map((p, i) => h('div', { class: 'panel page-block' },
        h('div', { class: 'page-head' },
          h('h3', {}, `Page ${i + 1} `, editing && flags[i]),
          h('div', {},
            h('button', { class: 'ghost', disabled: i === 0, onclick: () => { draft.pages.splice(i - 1, 0, draft.pages.splice(i, 1)[0]); rerender(); } }, '↑ Move up'), ' ',
            h('button', { class: 'ghost', disabled: draft.pages.length === 1, onclick: () => { draft.pages.splice(i, 1); rerender(); } }, 'Remove page'))),
        h('div', { class: original(p) ? 'with-thumb' : '' },
          original(p) && h('img', { class: 'thumb', src: pageSrc(comic, original(p)), alt: 'Current drawing of this page' }),
          h('div', {},
            h('label', {}, 'What happens'),
            h('textarea', { rows: 2, value: p.summary, oninput: bind(p, 'summary') }),
            h('label', {}, 'Panel layout'),
            h('input', { type: 'text', value: p.layout, oninput: bind(p, 'layout') }))),
        h('label', {}, `Panels (${p.panels.length})`),
        p.panels.map((pn, j) => h('div', { class: 'panel-row' },
          h('div', { class: 'panel-num' }, j + 1),
          h('textarea', { rows: 3, placeholder: 'What the panel shows', value: pn.description, oninput: bind(pn, 'description') }),
          h('textarea', { rows: 3, placeholder: 'Dialogue / caption (optional)', value: pn.dialogue, oninput: bind(pn, 'dialogue') }),
          h('button', { class: 'ghost', disabled: p.panels.length === 1, onclick: () => { p.panels.splice(j, 1); rerender(); } }, 'Remove'))),
        h('button', { class: 'ghost', disabled: p.panels.length >= config.maxPanels,
          onclick: () => { p.panels.push({ description: '', dialogue: '' }); rerender(); } }, '+ Add panel'))),

      h('div', { class: 'actions' },
        h('button', { disabled: full, onclick: () => {
          draft.pages.push({ summary: '', layout: '', panels: [{ description: '', dialogue: '' }] }); rerender();
        } }, '+ Add page'),
        full && h('span', { class: 'muted small' }, `Maximum of ${config.maxPages} pages.`)),

      h('div', { class: 'sticky-actions' }, status, h('div', { class: 'actions', style: 'margin:0' }, saveBtn, generateBtn)),
    );
    refresh();
  }
  draw();
}

// ---------- comic overview ----------

function renderComic(comic) {
  const busy = comic.status === 'generating';
  const test = isTest(comic);
  const renders = comic.pages.flatMap((p) => Object.values(p.renders));
  const done = renders.filter((r) => r.status === 'done').length;
  const act = (url, body) => async (e) => {
    e.target.disabled = true;
    try { await api('POST', url, body); } catch (err) { alert(err.message); }
    route();
  };

  // One drawing of a page: the image, or its progress while it is (re)drawn.
  function frame(p, i, key) {
    const r = p.renders[key];
    const working = r.status === 'generating' ? h('div', {}, h('span', { class: 'spinner' }), `Drawing page ${i + 1}…`)
      : r.status === 'pending' ? `Page ${i + 1} is waiting`
      : r.status === 'error' ? h('div', {}, h('strong', {}, `Page ${i + 1} failed`), h('br'), r.error)
      : null;
    const clip = comic.animate && !working && r.video;
    return h('div', { class: 'page-frame' },
      r.image
        ? [media(comic, r, { alt: `Page ${i + 1}: ${p.summary}`, class: working ? 'stale' : 'zoomable',
            title: 'Open in reader', onclick: () => openReader(comic, i) }),
           working && h('div', { class: 'page-overlay' }, working),
           clip && clip.status !== 'done' && h('div', { class: 'clip-status' },
             clip.status === 'error' ? `Animation failed: ${clip.error}` : [h('span', { class: 'spinner' }), clip.status === 'generating' ? 'Animating…' : 'Waiting to animate'])]
        : h('div', { class: 'page-wait' }, working));
  }
  const regenerate = (i, body) => act(`/api/comics/${comic.id}/pages/${i + 1}/regenerate`, body);
  const redraw = (p, i, key) => !busy && p.renders[key].image && h('span', {},
    comic.animate && p.renders[key].status === 'done' &&
      h('button', { class: 'ghost', onclick: regenerate(i, { model: key, video: true }) }, 'Re-animate'), ' ',
    h('button', { class: 'ghost', onclick: regenerate(i, { model: key }) }, 'Redraw'));
  const clips = renders.filter((r) => clipOf(comic, r)).length;
  const caption = (p, i) => h('span', { class: 'muted small' }, `Page ${i + 1} · ${plural(p.panels.length, 'panel')} · ${p.summary}`);

  mount(
    h('p', { class: 'small' }, h('a', { href: '#/' }, '← All comics')),
    h('h1', {}, comic.title),
    h('p', { class: 'muted' }, badge(comic.status), ' ', test && testBadge(),
      ` ${plural(comic.pages.length, 'page')} · ${comic.models.map(modelLabel).join(', ')}${comic.animate ? ` · animated with ${videoLabel(comic.animate)}` : ''} · ${new Date(comic.createdAt).toLocaleString()}`),
    h('div', { class: 'actions', style: 'margin-top:0' },
      h('button', { class: 'primary', disabled: !renders.some((r) => r.image), onclick: () => openReader(comic, 0) }, test ? '▶ Compare in reader' : '▶ Read'),
      h('button', { disabled: busy, onclick: () => { location.hash = `#/c/${comic.id}/edit`; } }, 'Edit breakdown')),
    test && h('div', { class: 'notice test' },
      'Model comparison: every page is drawn by each model from the same prompt, shown side by side. This is a test feature.'),
    busy && h('div', { class: 'notice' }, h('span', { class: 'spinner' }),
      `Drawing: ${done} of ${renders.length} images ready${comic.animate ? `, ${clips} animated` : ''}. They appear as they finish; you can leave and come back.`),
    comic.status === 'error' && h('div', { class: 'notice error' },
      `${done} of ${renders.length} images are up to date${comic.animate ? `, ${clips} animated` : ''}. `,
      h('button', { class: 'ghost', onclick: act(`/api/comics/${comic.id}/generate`) }, 'Retry the rest')),

    h('div', { class: 'pages' }, comic.pages.map((p, i) => test
      ? h('div', { class: 'page compare' },
          h('div', { class: 'variants' }, comic.models.map((key) => h('div', {},
            h('div', { class: 'variant-head' }, h('strong', {}, modelLabel(key)), redraw(p, i, key)),
            frame(p, i, key)))),
          h('div', { class: 'page-foot' }, caption(p, i)))
      : h('div', { class: 'page' },
          frame(p, i, comic.models[0]),
          h('div', { class: 'page-foot' }, caption(p, i), redraw(p, i, comic.models[0]))))),

    h('details', {},
      h('summary', {}, 'Story breakdown'),
      h('p', { class: 'small' }, h('strong', {}, 'Prompt: '), comic.prompt),
      h('p', { class: 'small' }, h('strong', {}, 'Style: '), comic.style),
      comic.characters.map((c) => h('p', { class: 'small' }, h('strong', {}, `${c.name}: `), c.description)),
      comic.pages.map((p, i) => h('div', { class: 'small' },
        h('p', {}, h('strong', {}, `Page ${i + 1}: `), p.summary),
        h('ol', {}, p.panels.map((pn) => h('li', {}, pn.description, pn.dialogue && h('em', {}, ` “${pn.dialogue}”`))))))),
  );
}

// ---------- cinematic reader ----------

let closeReader = () => {};

function openReader(comic, startPage) {
  closeReader();
  const pages = comic.pages;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const test = isTest(comic); // test comics show one page at a time, drawn by each model, side by side
  let mode = innerWidth < 760 ? 'single' : 'spread';
  try { mode = localStorage.getItem('readerMode') || mode; } catch { /* storage unavailable */ }
  if (test) mode = 'compare';
  let pos = startPage;   // index of the first visible page; always even in spread mode
  let flipping = false;

  const stage = h('div', { class: 'reader-stage' });
  const counter = h('span', { class: 'reader-counter' });
  const prevBtn = h('button', { 'aria-label': 'Previous', onclick: () => go(-1) }, '←');
  const nextBtn = h('button', { 'aria-label': 'Next', onclick: () => go(1) }, '→');
  const modeBtns = { single: h('button', { onclick: () => setMode('single') }, 'Single page'),
                     spread: h('button', { onclick: () => setMode('spread') }, 'Side by side') };
  const overlay = h('div', { class: 'reader', role: 'dialog', 'aria-label': `Reading ${comic.title}` },
    h('div', { class: 'reader-bar' },
      h('strong', { class: 'reader-title' }, comic.title),
      test ? testBadge() : h('div', { class: 'seg' }, modeBtns.single, modeBtns.spread),
      h('div', {},
        h('button', { onclick: () => (document.fullscreenElement ? document.exitFullscreen() : overlay.requestFullscreen?.()) }, 'Fullscreen'), ' ',
        h('button', { 'aria-label': 'Close reader', onclick: () => closeReader() }, '✕'))),
    stage,
    h('div', { class: 'reader-bar bottom' }, prevBtn, counter, nextBtn));

  const step = () => (mode === 'spread' ? 2 : 1);

  // One page side. `side` adds the shading toward the spine in spread mode.
  function face(i, side = '', key = comic.models[0]) {
    const p = pages[i];
    const r = p?.renders[key];
    return h('div', { class: `face ${side} ${p ? '' : 'blank'}` },
      p && (r.image
        ? media(comic, r, { alt: `Page ${i + 1}: ${p.summary}`, draggable: 'false' })
        : h('div', { class: 'face-empty' }, `Page ${i + 1} is not drawn yet`)));
  }

  function render(enter = '') {
    if (mode === 'spread') {
      stage.replaceChildren(h('div', { class: 'book' },
        h('div', { class: 'slot' }, face(pos, 'is-left')),
        h('div', { class: 'slot' }, face(pos + 1, 'is-right'))));
    } else if (mode === 'compare') {
      stage.replaceChildren(h('div', { class: `trio ${enter}` }, comic.models.map((key) =>
        h('figure', {}, h('div', { class: 'tile' }, face(pos, '', key)), h('figcaption', {}, modelLabel(key))))));
    } else {
      stage.replaceChildren(h('div', { class: `sheet ${enter}` }, face(pos)));
    }
    const last = Math.min(pos + step(), pages.length);
    counter.textContent = last - pos > 1 ? `Pages ${pos + 1}–${last} of ${pages.length}` : `Page ${pos + 1} of ${pages.length}`;
    prevBtn.disabled = pos <= 0;
    nextBtn.disabled = pos + step() >= pages.length;
    for (const [m, b] of Object.entries(modeBtns)) b.classList.toggle('on', m === mode);
  }

  // Turn one leaf around the spine. Its front is the page leaving view, its back the page arriving
  // on the other side; the page underneath is swapped first so it is revealed as the leaf lifts.
  async function flip(dir, target) {
    flipping = true;
    const [left, right] = stage.querySelectorAll('.slot');
    let front, back;
    if (dir > 0) {
      front = face(pos + 1, 'is-right'); back = face(target, 'is-left');
      right.replaceChildren(face(target + 1, 'is-right'));
    } else {
      front = face(pos, 'is-left'); back = face(target + 1, 'is-right');
      left.replaceChildren(face(target, 'is-left'));
    }
    front.classList.add('front'); back.classList.add('back');
    const leaf = h('div', { class: `leaf ${dir > 0 ? 'fwd' : 'rev'}` }, front, back);
    stage.firstChild.append(leaf);
    const turn = `rotateY(${dir > 0 ? -180 : 180}deg)`;
    try {
      await leaf.animate([{ transform: 'rotateY(0deg)' }, { transform: turn }],
        { duration: 750, easing: 'cubic-bezier(0.45, 0.05, 0.3, 1)', fill: 'forwards' }).finished;
    } catch { /* animation cancelled */ }
    pos = target;
    flipping = false;
    render();
  }

  function go(dir) {
    const target = pos + dir * step();
    if (flipping || target < 0 || target >= pages.length) return;
    if (mode === 'spread' && !reduceMotion) return flip(dir, target);
    pos = target;
    render(reduceMotion ? '' : dir > 0 ? 'enter-next' : 'enter-prev');
  }

  function setMode(next) {
    if (flipping) return;
    mode = next;
    if (!test) try { localStorage.setItem('readerMode', mode); } catch { /* storage unavailable */ }
    if (mode === 'spread') pos -= pos % 2;
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape') closeReader();
    else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
  }
  // Clicking the left or right half of the stage turns the page.
  stage.addEventListener('click', (e) => go(e.clientX > innerWidth / 2 ? 1 : -1));
  document.addEventListener('keydown', onKey);

  closeReader = () => {
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen();
    overlay.remove();
    document.body.classList.remove('reading');
    closeReader = () => {};
  };

  document.body.classList.add('reading');
  document.body.append(overlay);
  setMode(mode);
}

// ---------- routing ----------

async function showComic(id, edit, isPoll) {
  const hash = location.hash;
  const back = h('p', { class: 'small' }, h('a', { href: '#/' }, '← All comics'));
  let comic;
  try { comic = await api('GET', `/api/comics/${id}`); }
  catch (err) { return mount(back, errorBox(err.message)); }
  if (location.hash !== hash) return;
  if (comic.status === 'outline') return renderOutline(comic);
  if (edit && comic.status !== 'generating') return renderOutline(comic);

  // Keep the reader's scroll position while pages fill in.
  const y = scrollY;
  renderComic(comic);
  if (isPoll) scrollTo(0, y);
  if (comic.status === 'generating') pollTimer = setTimeout(() => showComic(id, false, true), 2500);
}

function route() {
  clearTimeout(pollTimer);
  const match = location.hash.match(/^#\/c\/([a-z0-9-]+)(\/edit)?$/);
  if (match) showComic(match[1], Boolean(match[2]));
  else renderHome();
}

window.addEventListener('hashchange', () => { closeReader(); scrollTo(0, 0); route(); });
api('GET', '/api/config').then((c) => { config = { ...config, ...c }; }).catch(() => {}).finally(route);
