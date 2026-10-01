// Comic generator server. Zero dependencies: Node's http + fetch against the Gemini Interactions API.
// Every comic is saved as a project folder: comics/<id>/comic.json + page-NN.png
// comic.json keeps the original prompt, the editable breakdown, the image model(s), and per page one
// "render" per model: the image file plus the exact prompt it was drawn from.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const PORT = Number(process.env.PORT) || 5177;
const API_KEY = process.env.GEMINI_API_KEY || '';
const API_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const REASONING_MODEL = process.env.REASONING_MODEL || 'gemini-3.8-flash';
const IMAGE_MODELS = {
  lite: { label: 'Nano Banana 2 Lite', model: 'gemini-3.1-flash-lite-image' },
  standard: { label: 'Nano Banana 2', model: 'gemini-3.1-flash-image' },
  pro: { label: 'Nano Banana Pro', model: 'gemini-3-pro-image' },
};
const DEFAULT_MODEL = 'lite';
const TEST_ALL = 'all'; // test feature: draw every page with all models for comparison

// Optional animation: each page image becomes a short looping clip.
const VIDEO_MODELS = {
  lite: { label: 'Veo 3.1 Lite', model: 'veo-3.1-lite-generate-preview' },
  fast: { label: 'Veo 3.1 Fast', model: 'veo-3.1-fast-generate-preview' },
  full: { label: 'Veo 3.1', model: 'veo-3.1-generate-preview' },
};
const DEFAULT_VIDEO_MODEL = 'lite';
const VIDEO_SECONDS = 8;     // Veo only accepts a last frame (needed for the loop) on 8 s clips; the player speeds it up
const VIDEO_CONCURRENCY = 2;
const IMAGE_SIZE = process.env.IMAGE_SIZE || ''; // e.g. 2K; empty = model default

const MAX_PAGES = 12;       // ceiling when the user reviews the outline first
const QUICK_MAX_PAGES = 5;  // guardrail for the instant "best guess" mode
const MAX_PANELS = 8;

const COMICS_DIR = process.env.COMICS_DIR || path.join(__dirname, 'comics');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(COMICS_DIR, { recursive: true });

// ---------- storage ----------

const validId = (id) => /^[a-z0-9-]{1,120}$/.test(id);
const comicDir = (id) => path.join(COMICS_DIR, id);
const comicFile = (id) => path.join(comicDir(id), 'comic.json');

function loadComic(id) {
  if (!validId(id) || !fs.existsSync(comicFile(id))) return null;
  return migrate(JSON.parse(fs.readFileSync(comicFile(id), 'utf8')));
}

const pageId = (n) => String(n).padStart(2, '0');

const blankRender = () => ({ image: null, drawnPrompt: null, status: 'pending', error: null });
const allRenders = (comic) => comic.pages.flatMap((p) => Object.values(p.renders));

// Comics saved in older formats: one image stored directly on the page, drawn with the default model.
function migrate(comic) {
  comic.models ??= [DEFAULT_MODEL];
  comic.animate ??= null;
  comic.pages.forEach((p, i) => {
    p.id ??= pageId(i + 1);
    if (p.renders) return;
    const drawnPrompt = p.image && p.drawnPrompt === undefined ? pagePrompt(comic, p) : p.drawnPrompt ?? null;
    p.renders = { [comic.models[0]]: { image: p.image ?? null, drawnPrompt, version: p.version, status: p.status ?? 'pending', error: p.error ?? null } };
    for (const key of ['image', 'drawnPrompt', 'version', 'status', 'error']) delete p[key];
  });
  comic.nextPageId ??= comic.pages.length + 1;
  return comic;
}

function saveComic(comic) {
  fs.mkdirSync(comicDir(comic.id), { recursive: true });
  fs.writeFileSync(comicFile(comic.id), JSON.stringify(comic, null, 2));
}

function listComics() {
  return fs.readdirSync(COMICS_DIR)
    .map((id) => { try { return loadComic(id); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({
      id: c.id, title: c.title, prompt: c.prompt, status: c.status, createdAt: c.createdAt,
      pageCount: c.pages.length,
      test: c.models.length > 1,
      animated: Boolean(c.animate),
      cover: allRenders(c).find((r) => r.image)?.image || null,
    }));
}

function newId(title) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'comic';
  const base = `${stamp.slice(0, 8)}-${stamp.slice(8)}-${slug}`;
  let id = base;
  for (let n = 2; fs.existsSync(comicDir(id)); n++) id = `${base}-${n}`;
  return id;
}

// ---------- Gemini ----------

async function interact(body) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY is not set. Add it to the .env file and restart the server.');
  const res = await fetch(`${API_BASE}/v1beta/interactions`, {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
  const blocks = (data.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || []);
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    image: blocks.filter((b) => b.type === 'image' && b.data).pop() || null, // last image is the final render
  };
}

const str = { type: 'string' };
const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: str,
    style: { type: 'string', description: 'Art style for the whole comic: line work, colouring, mood.' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: str,
          description: { type: 'string', description: 'Visual description precise enough to redraw the character consistently.' },
        },
        required: ['name', 'description'],
      },
    },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What happens on this page, one or two sentences.' },
          layout: { type: 'string', description: 'Panel arrangement, e.g. "wide establishing panel on top, three small panels below".' },
          panels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'What the panel shows: framing, action, setting.' },
                dialogue: { type: 'string', description: 'Speech bubbles / captions as "Name: text". Empty if silent.' },
              },
              required: ['description', 'dialogue'],
            },
          },
        },
        required: ['summary', 'layout', 'panels'],
      },
    },
  },
  required: ['title', 'style', 'characters', 'pages'],
};

async function createOutline(prompt, maxPages) {
  const { text } = await interact({
    model: REASONING_MODEL,
    input:
      `You are a comic book writer and storyboard artist. Plan a comic for the idea below.\n\n` +
      `- Choose the number of pages that best fits the story, between 1 and ${maxPages}. Do not pad: a short gag needs one page.\n` +
      `- Each page is drawn as ONE image containing several panels (usually 3-6, never more than ${MAX_PANELS}).\n` +
      `- Give the story a clear beginning, middle and end across the pages.\n` +
      `- Keep dialogue short so it fits in speech bubbles.\n` +
      `- Write in the language of the idea.\n\n` +
      `Comic idea:\n${prompt}`,
    response_format: { type: 'text', mime_type: 'application/json', schema: OUTLINE_SCHEMA },
  });
  let outline;
  try { outline = JSON.parse(text); } catch { throw new Error('The model returned an outline that could not be parsed.'); }
  return normalizeOutline(outline, maxPages);
}

// Applied to model output and to user edits alike, so the page/panel limits always hold.
function normalizeOutline(o, maxPages) {
  const s = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
  const pages = (Array.isArray(o?.pages) ? o.pages : []).slice(0, maxPages).map((p) => ({
    id: /^\d{1,4}$/.test(p?.id) ? p.id : null, // set on pages that already exist in a comic
    summary: s(p?.summary),
    layout: s(p?.layout),
    panels: (Array.isArray(p?.panels) ? p.panels : []).slice(0, MAX_PANELS)
      .map((pn) => ({ description: s(pn?.description), dialogue: s(pn?.dialogue) }))
      .filter((pn) => pn.description || pn.dialogue),
  })).filter((p) => p.summary || p.panels.length);
  if (!pages.length) throw new Error('The outline has no pages.');
  return {
    title: s(o?.title, 200) || 'Untitled comic',
    style: s(o?.style),
    characters: (Array.isArray(o?.characters) ? o.characters : []).slice(0, 12)
      .map((c) => ({ name: s(c?.name, 100), description: s(c?.description) }))
      .filter((c) => c.name || c.description),
    pages,
  };
}

// The image prompt for a page. It deliberately leaves out the title and page number, so renaming the
// comic or reordering pages does not count as a change; a page is redrawn when this text changes.
function pagePrompt(comic, page) {
  const panels = page.panels.map((pn, i) =>
    `Panel ${i + 1}: ${pn.description}` + (pn.dialogue ? `\n  Lettering (exact text): ${pn.dialogue}` : '\n  No text.')
  ).join('\n');
  const cast = comic.characters.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  return (
    `Draw ONE complete comic book page as a single portrait image.\n` +
    `The page contains exactly ${page.panels.length} panels with clean borders and white gutters, read left-to-right, top-to-bottom. ` +
    `Do not draw a single full-page illustration and do not split panels into separate images.\n\n` +
    `Art style: ${comic.style}\n\n` +
    (cast ? `Characters (keep their look identical in every panel):\n${cast}\n\n` : '') +
    `Page summary: ${page.summary}\n` +
    (page.layout ? `Layout: ${page.layout}\n` : '') +
    `\n${panels}\n\n` +
    `Put dialogue in legible speech bubbles and captions in caption boxes, spelled exactly as given. No page numbers, no title text unless a panel asks for it.`
  );
}

const needsDraw = (comic, page, key) => !page.renders[key].image || page.renders[key].drawnPrompt !== pagePrompt(comic, page);
// Every (page, model) render that is missing or out of date.
const pendingRenders = (comic) => comic.pages.flatMap((p) => comic.models.filter((k) => needsDraw(comic, p, k)).map((k) => p.renders[k]));

function removeImage(comic, render) {
  if (render.image) fs.rmSync(path.join(comicDir(comic.id), render.image), { force: true });
  if (render.video?.file) fs.rmSync(path.join(comicDir(comic.id), render.video.file), { force: true });
  delete render.video;
}

// Makes every page have exactly one render per selected model; renders of deselected models are deleted.
function syncRenders(comic) {
  for (const page of comic.pages) {
    for (const [key, render] of Object.entries(page.renders)) {
      if (comic.models.includes(key)) continue;
      removeImage(comic, render);
      delete page.renders[key];
    }
    for (const key of comic.models) page.renders[key] ??= blankRender();
  }
}

// A render needs a (new) clip when animation is on and its clip is missing, failed, made from an older
// version of the image, or made by a different video model.
function needsVideo(comic, render) {
  if (!comic.animate || !render.image || render.status !== 'done') return false;
  const v = render.video;
  return !v || v.status !== 'done' || v.sourceVersion !== render.version || v.model !== comic.animate;
}
const pendingVideos = (comic) => comic.pages.flatMap((p) => comic.models.map((k) => p.renders[k]).filter((r) => needsVideo(comic, r)));
const parseAnimate = (value) => (VIDEO_MODELS[value] ? value : null);

// 'all' selects the comparison test; anything unknown falls back to the default model.
const parseModels = (value) => (value === TEST_ALL ? Object.keys(IMAGE_MODELS) : [IMAGE_MODELS[value] ? value : DEFAULT_MODEL]);

async function generatePageImage(comic, index, key, prompt) {
  const page = comic.pages[index];
  const render = page.renders[key];
  // Reference the first and the previous page (as drawn by the same model) so characters and style stay consistent.
  const refs = [...new Set([0, index - 1])]
    .filter((i) => i >= 0 && i < index && comic.pages[i].renders[key].image)
    .map((i) => {
      const file = path.join(comicDir(comic.id), comic.pages[i].renders[key].image);
      return { type: 'image', mime_type: MIME[path.extname(file)], data: fs.readFileSync(file).toString('base64') };
    });
  const { image } = await interact({
    model: IMAGE_MODELS[key].model,
    input: [
      { type: 'text', text: prompt + (refs.length ? '\nThe attached images are earlier pages of this comic: match their art style, colours and character designs exactly.' : '') },
      ...refs,
    ],
    response_format: { type: 'image', aspect_ratio: '3:4', ...(IMAGE_SIZE && { image_size: IMAGE_SIZE }) },
  });
  if (!image) throw new Error('The image model returned no image for this page.');
  const ext = image.mime_type === 'image/jpeg' ? 'jpg' : 'png';
  const name = `page-${page.id}${comic.models.length > 1 ? `-${key}` : ''}.${ext}`;
  if (render.image !== name) removeImage(comic, render);
  fs.writeFileSync(path.join(comicDir(comic.id), name), Buffer.from(image.data, 'base64'));
  return name;
}

// Veo only makes 16:9 or 9:16 video. Pad the 3:4 page to 9:16 with white bars (macOS `sips`) so nothing
// is cut off; the player crops the bars away again. Without sips the page is sent as it is.
function videoFrame(file) {
  const tmp = path.join(os.tmpdir(), `comic-frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const width = Number(info.match(/pixelWidth: (\d+)/)[1]);
    const height = Math.max(Number(info.match(/pixelHeight: (\d+)/)[1]), Math.round((width * 16) / 9));
    execFileSync('sips', ['-s', 'format', 'jpeg', '--padToHeightWidth', String(height), String(width), '--padColor', 'FFFFFF', file, '--out', tmp], { stdio: 'ignore' });
    return { mimeType: 'image/jpeg', bytesBase64Encoded: fs.readFileSync(tmp).toString('base64') };
  } catch {
    return { mimeType: MIME[path.extname(file)], bytesBase64Encoded: fs.readFileSync(file).toString('base64') };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const VIDEO_PROMPT =
  'Bring this comic book page to life with subtle, continuous motion inside each panel: hair and clothing moving, ' +
  'breathing, blinking, drifting smoke, dust, rain or clouds, flickering light. ' +
  'The page layout, panel borders, speech bubbles, lettering and character positions stay exactly as they are. ' +
  'Locked-off camera: no zoom, no pan, no cuts, no transitions, no new elements. ' +
  'The motion is cyclical and the last frame is identical to the first, so the clip loops seamlessly. ' +
  'Audio: quiet ambient room tone only. Nobody speaks, the text in the speech bubbles is never read aloud, no voices, no music.';
const VIDEO_ATTEMPTS = 3; // Veo sometimes rejects a clip over its (unused) audio track; those attempts are free, so try again

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Animates one page image with Veo, retrying when Veo's audio check rejects the clip.
async function generateVideo(comic, render, videoKey) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestVideo(comic, render, videoKey);
    } catch (err) {
      if (attempt >= VIDEO_ATTEMPTS || !/audio/i.test(err.message)) throw err;
    }
  }
}

// One Veo request. The same image is given as first and last frame so the clip loops.
async function requestVideo(comic, render, videoKey) {
  const headers = { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' };
  const frame = videoFrame(path.join(comicDir(comic.id), render.image));
  const request = {
    method: 'POST', headers,
    body: JSON.stringify({
      instances: [{ prompt: VIDEO_PROMPT, image: frame, lastFrame: frame }],
      parameters: { aspectRatio: '9:16', durationSeconds: VIDEO_SECONDS, resolution: '720p' },
    }),
  };
  // Veo rate limits are tight (a few requests per minute), so wait and try again on 429 / 503.
  let start;
  for (let attempt = 0; ; attempt++) {
    start = await fetch(`${API_BASE}/v1beta/models/${VIDEO_MODELS[videoKey].model}:predictLongRunning`, request);
    if (![429, 503].includes(start.status) || attempt >= 5) break;
    await sleep(Number(process.env.VIDEO_RETRY_MS) || 40_000);
  }
  let op = await start.json().catch(() => ({}));
  if (!start.ok || !op.name) throw new Error(op.error?.message || `Veo API error ${start.status}`);

  const deadline = Date.now() + 10 * 60_000;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error('Veo did not finish within 10 minutes.');
    await sleep(Number(process.env.VIDEO_POLL_MS) || 8000);
    op = await (await fetch(`${API_BASE}/v1beta/${op.name}`, { headers })).json();
  }
  if (op.error) throw new Error(op.error.message || 'Veo could not generate this clip.');
  const result = op.response?.generateVideoResponse;
  const uri = result?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw new Error(result?.raiMediaFilteredReasons?.join(' ') || 'Veo returned no video.');

  const download = await fetch(uri, { headers: { 'x-goog-api-key': API_KEY } });
  if (!download.ok) throw new Error(`Could not download the clip (${download.status}).`);
  const name = `${path.parse(render.image).name}.mp4`;
  fs.writeFileSync(path.join(comicDir(comic.id), name), Buffer.from(await download.arrayBuffer()));
  return name;
}

const running = new Set();

// Draws every render that is missing or out of date with its page's breakdown, saving progress after
// each one. Models run in parallel; within a model pages are drawn in order so each can reference the
// previous one. An outdated image stays in place until its replacement arrives.
async function runGeneration(id) {
  if (running.has(id)) return;
  running.add(id);
  const comic = loadComic(id);
  try {
    comic.status = 'generating';
    pendingRenders(comic).forEach((r) => { r.status = 'pending'; r.error = null; });
    saveComic(comic);
    await Promise.all(comic.models.map(async (key) => {
      for (let i = 0; i < comic.pages.length; i++) {
        const page = comic.pages[i];
        const render = page.renders[key];
        if (!needsDraw(comic, page, key)) continue;
        render.status = 'generating';
        saveComic(comic);
        try {
          const prompt = pagePrompt(comic, page);
          render.image = await generatePageImage(comic, i, key, prompt);
          render.drawnPrompt = prompt;
          render.version = Date.now();
          render.status = 'done';
        } catch (err) {
          render.status = 'error';
          render.error = err.message;
          console.error(`[${id}] page ${i + 1} (${key}): ${err.message}`);
        }
        saveComic(comic);
      }
    }));
    // Then animate, a few clips at a time. Pages stay readable as stills while this runs.
    const queue = pendingVideos(comic);
    queue.forEach((r) => { r.video = { status: 'pending' }; });
    saveComic(comic);
    await Promise.all(Array.from({ length: VIDEO_CONCURRENCY }, async () => {
      for (let render = queue.shift(); render; render = queue.shift()) {
        render.video = { status: 'generating' };
        saveComic(comic);
        try {
          const file = await generateVideo(comic, render, comic.animate);
          render.video = { status: 'done', file, model: comic.animate, sourceVersion: render.version, version: Date.now() };
        } catch (err) {
          render.video = { status: 'error', error: err.message };
          console.error(`[${id}] animating ${render.image}: ${err.message}`);
        }
        saveComic(comic);
      }
    }));

    comic.status = pendingRenders(comic).length || pendingVideos(comic).length ? 'error' : 'done';
    saveComic(comic);
  } finally {
    running.delete(id);
  }
}

function createComic(prompt, outline, mode, { model, animate }) {
  const comic = {
    id: newId(outline.title),
    prompt, mode,
    models: parseModels(model),
    animate: parseAnimate(animate), // video model key, or null for a still comic
    status: 'outline',
    createdAt: new Date().toISOString(),
    title: outline.title,
    style: outline.style,
    characters: outline.characters,
    pages: outline.pages.map((p, i) => ({ ...p, id: pageId(i + 1), renders: {} })),
    nextPageId: outline.pages.length + 1,
  };
  syncRenders(comic);
  saveComic(comic);
  return comic;
}

// Applies an edited breakdown and, if given, a new model choice. Existing pages (matched by id) keep
// their images; whether those are still current is decided by needsDraw. Images of removed pages are deleted.
function applyOutline(comic, outline, { model, animate }) {
  const o = normalizeOutline(outline, MAX_PAGES);
  const previous = new Map(comic.pages.map((p) => [p.id, p]));
  Object.assign(comic, { title: o.title, style: o.style, characters: o.characters });
  comic.pages = o.pages.map((p) => {
    const old = previous.get(p.id);
    previous.delete(p.id); // also guards against the same id being sent twice
    return old ? { ...old, ...p } : { ...p, id: pageId(comic.nextPageId++), renders: {} };
  });
  for (const removed of previous.values()) Object.values(removed.renders).forEach((r) => removeImage(comic, r));
  if (model) comic.models = parseModels(model);
  if (animate !== undefined) comic.animate = parseAnimate(animate);
  syncRenders(comic);
}

// A server restart kills in-flight generation; mark those comics so the UI offers to resume.
for (const { id } of listComics()) {
  const comic = loadComic(id);
  if (comic.status !== 'generating') continue;
  comic.status = 'error';
  pendingRenders(comic).forEach((r) => { r.status = 'error'; r.error = 'Generation was interrupted.'; });
  pendingVideos(comic).forEach((r) => { r.video = { status: 'error', error: 'Animation was interrupted.' }; });
  saveComic(comic);
}

// ---------- http ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendFile(req, res, root, relPath) {
  const file = path.join(root, relPath);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  const { size } = fs.statSync(file);
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  // Byte ranges, which browsers (Safari in particular) need to play and loop video.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('Request too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

function readPrompt(body) {
  const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
  if (!prompt) throw Object.assign(new Error('Please enter a prompt.'), { status: 400 });
  return prompt;
}

async function api(req, res, parts) {
  const method = req.method;

  if (parts[0] === 'config' && method === 'GET') {
    return sendJson(res, 200, {
      hasKey: Boolean(API_KEY), maxPages: MAX_PAGES, quickMaxPages: QUICK_MAX_PAGES, maxPanels: MAX_PANELS,
      imageModels: Object.entries(IMAGE_MODELS).map(([key, m]) => ({ key, label: m.label })),
      defaultModel: DEFAULT_MODEL, testAll: TEST_ALL,
      videoModels: Object.entries(VIDEO_MODELS).map(([key, m]) => ({ key, label: m.label })),
      defaultVideoModel: DEFAULT_VIDEO_MODEL,
    });
  }

  // Step 1 of the reviewed flow: propose page count + outline, stop for the user to edit.
  if (parts[0] === 'outline' && method === 'POST') {
    const body = await readBody(req);
    const prompt = readPrompt(body);
    return sendJson(res, 200, createComic(prompt, await createOutline(prompt, MAX_PAGES), 'outline', body));
  }

  // Instant flow: best-guess outline capped at QUICK_MAX_PAGES, straight into drawing.
  if (parts[0] === 'quick' && method === 'POST') {
    const body = await readBody(req);
    const prompt = readPrompt(body);
    const comic = createComic(prompt, await createOutline(prompt, QUICK_MAX_PAGES), 'quick', body);
    runGeneration(comic.id);
    return sendJson(res, 200, { ...comic, status: 'generating' });
  }

  if (parts[0] !== 'comics') return sendJson(res, 404, { error: 'Not found' });
  if (parts.length === 1 && method === 'GET') return sendJson(res, 200, listComics());

  const comic = loadComic(parts[1] || '');
  if (!comic) return sendJson(res, 404, { error: 'Comic not found' });
  const busy = running.has(comic.id);

  if (parts.length === 2 && method === 'GET') return sendJson(res, 200, comic);

  if (parts.length === 2 && method === 'PUT') {
    if (comic.status !== 'outline') return sendJson(res, 409, { error: 'This comic has already been generated.' });
    const body = await readBody(req);
    applyOutline(comic, body.outline, body);
    saveComic(comic);
    return sendJson(res, 200, comic);
  }

  // Start, resume, or update. An edited breakdown and model choice may be sent along, also after the
  // comic was drawn: they are saved and only the images that are now out of date are redrawn.
  if (parts[2] === 'generate' && method === 'POST') {
    if (busy) return sendJson(res, 409, { error: 'Already generating.' });
    const body = await readBody(req);
    if (body.outline) applyOutline(comic, body.outline, body);
    const redraw = pendingRenders(comic).length + pendingVideos(comic).length;
    comic.status = redraw ? 'generating' : 'done';
    saveComic(comic);
    if (redraw) runGeneration(comic.id);
    return sendJson(res, 200, comic);
  }

  if (parts[2] === 'pages' && parts[4] === 'regenerate' && method === 'POST') {
    if (busy) return sendJson(res, 409, { error: 'Already generating.' });
    const page = comic.pages[Number(parts[3]) - 1];
    if (!page) return sendJson(res, 404, { error: 'Page not found' });
    // Redraw one model's version of the page, or all of them when no model is named.
    // With `video` set only the clip is made again; the image is kept.
    const { model, video } = await readBody(req);
    for (const key of comic.models) {
      if (model && model !== key) continue;
      if (video) delete page.renders[key].video;
      else Object.assign(page.renders[key], { drawnPrompt: null, status: 'pending', error: null });
    }
    comic.status = 'generating';
    saveComic(comic);
    runGeneration(comic.id);
    return sendJson(res, 200, comic);
  }

  sendJson(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (parts[0] === 'api') return await api(req, res, parts.slice(1));
    if (parts[0] === 'comics') return sendFile(req, res, COMICS_DIR, parts.slice(1).join('/'));
    return sendFile(req, res, PUBLIC_DIR, parts.join('/') || 'index.html');
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
}).listen(PORT, () => {
  console.log(`Comic generator running at http://localhost:${PORT}`);
  if (!API_KEY) console.log('GEMINI_API_KEY is not set: add it to .env to generate comics.');
});
