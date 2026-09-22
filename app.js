// visualizer — live audio-reactive webcam, WebGL effects, DOM overlays
//
// architecture:
//   webcam -> feedback FBO (trails, composition) -> effect chain -> tape pass -> screen
//
// the look is driven by three independent axes, so the same camera feed never
// resolves to the same image twice:
//   RIG     — which passes run and how hard (see RIGS)
//   PALETTE — the 3-stop gradient the luma is mapped through (see PALETTES)
//   SCENE   — the composition transform on the camera sample (see SCENE_NAMES)
// all three are scheduled off the beat tracker, so changes land on bar lines
// instead of arbitrary wall-clock intervals.

const canvas = document.getElementById('gl');
const ui = document.getElementById('ui');
const err = document.getElementById('err');
const camListEl = document.getElementById('cam-list');
const audSelect = document.getElementById('aud');
const startBtn = document.getElementById('start');

const barEls = {
  bass: document.getElementById('b-bass'),
  mids: document.getElementById('b-mids'),
  highs: document.getElementById('b-highs'),
};
const tag = (id) => document.getElementById(id);

const gl = canvas.getContext('webgl', {
  alpha: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});

if (!gl) {
  err.textContent = 'WebGL unavailable';
  throw new Error('no webgl');
}

// ---------- program helpers ----------

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader: ' + log);
  }
  return s;
}

// returns { p, u } where u maps every active uniform name to its location —
// saves hand-maintaining a location table per program.
function program(fsSrc) {
  const vs = compile(gl.VERTEX_SHADER, SHADERS.VS);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

const PROG = {
  feedback: program(SHADERS.FS_FEEDBACK),
  silhouette: program(SHADERS.FS_SILHOUETTE),
  rgb: program(SHADERS.FS_RGB),
  sort: program(SHADERS.FS_SORT),
  displace: program(SHADERS.FS_DISPLACE),
  aberr: program(SHADERS.FS_ABERR),
  edge: program(SHADERS.FS_EDGE),
  bright: program(SHADERS.FS_BRIGHT),
  blur: program(SHADERS.FS_BLUR),
  combine: program(SHADERS.FS_COMBINE),
  palette: program(SHADERS.FS_PALETTE),
  film: program(SHADERS.FS_FILM),
  cell: program(SHADERS.FS_CELL),
  analyze: program(SHADERS.FS_ANALYZE),
  world: program(SHADERS.FS_WORLD),
  ascii: program(SHADERS.FS_ASCII),
  rain: program(SHADERS.FS_RAIN),
  wcopy: program(SHADERS.FS_WEBCAM_COPY),
  motion: program(SHADERS.FS_MOTION),
  blit: program(SHADERS.FS_BLIT),
};

// fullscreen triangle
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

function bindQuad() {
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

function setTex(prog, name, unit, tex) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(prog.u[name], unit);
}

// ---------- camera pool ----------
//
// every video input the browser reports is a candidate, and the set is live:
// plugging in a capture card or waking an iPhone over Continuity adds a slot,
// unplugging removes it. the pool holds one <video> per open camera so
// switching is instant, and only the active one is uploaded to the GPU.
//
// the rule that matters on stage: losing a camera must never stop the render.
// a dropped device is removed from rotation and the active index moves on.

/** @type {{deviceId:string, label:string, video:HTMLVideoElement, stream:MediaStream}[]} */
const cams = [];
let activeCam = 0;

/** deviceIds the user has ticked for rotation */
const camEnabled = new Set();
/** deviceIds we've already offered, so a reconnect doesn't re-enable a device
 *  the user deliberately unticked */
const camSeen = new Set();
/** latest enumerateDevices() snapshot of video inputs */
let videoInputs = [];

function makeVideoEl() {
  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = true;
  v.autoplay = true;
  return v;
}

function activeVideo() {
  if (cams.length === 0) return null;
  if (activeCam >= cams.length) activeCam = 0;
  return cams[activeCam].video;
}

function camShortLabel(label, i) {
  if (!label) return 'CAM ' + (i + 1);
  // device labels are verbose ("FaceTime HD Camera (05ac:8514)") — strip the
  // trailing hardware id and cap the length so the HUD stays one line
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').slice(0, 22);
}

function updateCamTag() {
  const t = tag('cam-tag');
  if (!t) return;
  if (cams.length === 0) {
    t.textContent = 'NO CAM';
    return;
  }
  if (activeCam >= cams.length) activeCam = 0;
  const c = cams[activeCam];
  t.textContent = `CAM ${activeCam + 1}/${cams.length} ${camShortLabel(c.label, activeCam)}`;
}

function setActiveCam(i) {
  if (cams.length === 0) return;
  activeCam = ((i % cams.length) + cams.length) % cams.length;
  updateCamTag();
  if (running) scheduleCamCycle();
}

// auto-cycle through the whole pool every random 5-10s (only while running)
const CAM_CYCLE_MIN_MS = 5000;
const CAM_CYCLE_MAX_MS = 10000;
let camCycleTimer = null;
let autoCamCycle = true;

function clearCamCycleTimer() {
  if (camCycleTimer != null) {
    clearTimeout(camCycleTimer);
    camCycleTimer = null;
  }
}

function scheduleCamCycle() {
  clearCamCycleTimer();
  if (!running || !autoCamCycle) return;
  const delay = CAM_CYCLE_MIN_MS + Math.random() * (CAM_CYCLE_MAX_MS - CAM_CYCLE_MIN_MS);
  camCycleTimer = setTimeout(() => {
    camCycleTimer = null;
    if (!running || !autoCamCycle) return;
    if (cams.length > 1) {
      activeCam = (activeCam + 1) % cams.length;
      updateCamTag();
    }
    scheduleCamCycle();
  }, delay);
}

const videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };

function closeCam(entry) {
  try { entry.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* already gone */ }
  entry.video.srcObject = null;
  if (entry.tex) gl.deleteTexture(entry.tex);
}

function dropCam(deviceId) {
  const i = cams.findIndex(c => c.deviceId === deviceId);
  if (i < 0) return;
  closeCam(cams[i]);
  cams.splice(i, 1);
  // keep pointing at the same physical camera where possible
  if (activeCam > i) activeCam--;
  if (activeCam >= cams.length) activeCam = 0;
  reconcileLayout();
  updateCamTag();
  renderCamList();
}

async function openCam(dev) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: dev.deviceId }, ...videoConstraints },
    audio: false,
  });
  const video = makeVideoEl();
  video.srcObject = stream;
  await video.play();
  const entry = {
    deviceId: dev.deviceId, label: dev.label, video, stream,
    tex: createVideoTex(),
  };
  cams.push(entry);
  // a yanked USB cable or a sleeping iPhone ends the track rather than firing
  // devicechange first, so react to both
  stream.getVideoTracks().forEach(t => {
    t.addEventListener('ended', () => dropCam(dev.deviceId));
  });
  return entry;
}

// bring the open pool in line with what's enabled and actually present
async function syncCamStreams() {
  const present = new Set(videoInputs.map(d => d.deviceId));

  // close anything unticked or physically gone
  for (const c of cams.slice()) {
    if (!camEnabled.has(c.deviceId) || !present.has(c.deviceId)) dropCam(c.deviceId);
  }

  // open anything newly ticked or newly arrived
  for (const dev of videoInputs) {
    if (!camEnabled.has(dev.deviceId)) continue;
    if (cams.some(c => c.deviceId === dev.deviceId)) continue;
    try {
      await openCam(dev);
    } catch (e) {
      // in use by another app, or permission revoked for that device — skip it
      // rather than aborting the whole sync
      err.textContent = `camera "${camShortLabel(dev.label, 0)}": ${e.message}`;
    }
  }

  reconcileLayout();
  updateCamTag();
  renderCamList();
}

gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

// ---------- glyph atlas ----------
//
// one strip of glyphs, drawn once at load into a canvas and uploaded as a
// texture. shared by the ASCII pass and the letter rain.
//
// layout: a density ladder first (dark to light, for ASCII-art tone mapping),
// then the letters of the word. keeping both in one atlas means one texture
// bind and one set of indices.

const ASCII_RAMP = ' .:-=+*#%@';
const RAIN_WORD = 'NOMU';
const ATLAS_GLYPHS = (ASCII_RAMP + RAIN_WORD).split('');
const ATLAS_CELL = 48;
const RAMP_LO = 0;
const RAMP_N = ASCII_RAMP.length;
const WORD_LO = ASCII_RAMP.length;
const WORD_N = RAIN_WORD.length;

function buildGlyphAtlas() {
  const n = ATLAS_GLYPHS.length;
  const c = document.createElement('canvas');
  c.width = ATLAS_CELL * n;
  c.height = ATLAS_CELL;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  // a heavy mono face so glyphs carry enough ink to read at small cell sizes
  ctx.font = `700 ${Math.round(ATLAS_CELL * 0.78)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ATLAS_GLYPHS.forEach((g, i) => {
    ctx.fillText(g, i * ATLAS_CELL + ATLAS_CELL / 2, ATLAS_CELL / 2 + 1);
  });

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // the atlas is authored top-down, unlike the video textures, so upload it
  // unflipped and put the global flag straight back
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return tex;
}
const glyphAtlas = buildGlyphAtlas();

// one texture per open camera — they are all composited every frame, so each
// one needs its own upload rather than sharing a single slot
function createVideoTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // seed with 1x1 black so sampling is valid before the first frame arrives
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 0]));
  return t;
}

// ---------- camera layouts ----------
//
// every open camera is on screen at all times — the composite is the
// background layer, and clips/GIFs sit on top of it as overlays.
//
// cells are [x, y, w, h] in 0..1 with y measured from the TOP. laid out on a
// strict split with a hairline gutter between them, which is what makes a
// multi-camera frame read as a broadcast multiviewer rather than a collage.

// ---------- scattered panels ----------
//
// no grid. panels are irregular, overlapping rectangles that drift, jump on
// the beat and trail — a symmetric 2x2 or 3x3 reads as a security-desk
// multiviewer, which is the opposite of the intent.
//
// two things keep it from becoming mush:
//  - every source is guaranteed at least one panel, so nothing is ever hidden
//  - positions and sizes snap to a fine 48x27 subdivision. that is far too
//    fine to read as a grid, but it keeps every edge on a whole pixel, so the
//    hairline borders stay crisp instead of shimmering as panels drift.
//
// trails come for free: the composite is rebuilt each frame and the feedback
// pass keeps max(current, previous * decay), so anything that moves smears.

const MAX_PANELS = 4;

// each preset is a different density and temperament, not a different grid
// every panel set gets a deliberate size hierarchy rather than a row of
// similar rectangles: one HERO carrying the composition, then MIDs and small
// ACCENTs against it. equal-sized panes read as a contact sheet no matter how
// they are placed — the dominant/subordinate relationship is what makes it a
// composition.
const ROLES = {
  HERO:   { min: 0.46, max: 0.60 },
  MID:    { min: 0.27, max: 0.40 },
  ACCENT: { min: 0.15, max: 0.25 },
};

// `scale` shifts the whole set bigger or smaller while keeping the hierarchy
const SCATTER = [
  { name: 'DRIFT', count: 3, scale: 1.00, speed: 0.012, jump: 0.10 },
  { name: 'SWARM', count: 4, scale: 0.88, speed: 0.024, jump: 0.28 },
  { name: 'SLAB',  count: 2, scale: 1.15, speed: 0.007, jump: 0.06 },
  { name: 'SHARD', count: 4, scale: 0.78, speed: 0.032, jump: 0.40 },
];

// exactly one hero, then alternate mids and accents so there is always
// something small playing against something large
function roleForIndex(i, n) {
  if (i === 0) return 'HERO';
  if (n <= 2) return 'MID';
  return (i % 2 === 1) ? 'ACCENT' : 'MID';
}
let scatterIdx = 0;
const scatter = () => SCATTER[scatterIdx];

let layoutName = SCATTER[0].name;
let autoLayout = true;

// the raymarched world takes a panel alongside the cameras, so a camera is
// always on screen next to it rather than being replaced by it
const WORLD_MODES = ['ROOMS', 'TUNNEL', 'ORBIT', 'COASTER', 'OCEAN', 'MOUNTAIN', 'RAIN'];
// weighted, because uniform random over seven modes lets a specific one sit
// out for whole songs. the falling letters and the scenic pair are the ones
// worth seeing often; the corridors are texture between them.
const WORLD_WEIGHTS = [2, 2, 2, 2, 4, 4, 6];

function pickWorldMode() {
  const total = WORLD_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WORLD_MODES.length; i++) {
    r -= WORLD_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}
// on by default — these were invisible until you happened to press a key,
// which is a bad default for something you want in the set
let worldEnabled = true;
let worldMode = 0;

function sourceCount() {
  return cams.length + (worldEnabled ? 1 : 0);
}

/** @type {{src:number,x:number,y:number,w:number,h:number,vx:number,vy:number}[]} */
const panels = [];

const SNAP_X = 48;
const SNAP_Y = 27;
const snapTo = (v, n) => Math.round(v * n) / n;

function makePanel(src, role, minWidth) {
  const m = scatter();
  // hard ceiling: no single panel may take more than 60% of the frame in
  // either axis. one big pane crowds out everything else, and the overlays and
  // the other panes need room to register.
  const MAX_SPAN = 0.60;
  const r = ROLES[role || 'MID'];
  const lo = Math.min(MAX_SPAN, Math.max(r.min * m.scale, minWidth || 0));
  const hi = Math.min(MAX_SPAN, Math.max(r.max * m.scale, minWidth || 0));
  const w = lo + Math.random() * Math.max(0.01, hi - lo);
  // height is independent of width, so panels are never uniformly square and
  // never all the same shape. accents stay compact; heroes can run tall.
  const aspect = role === 'ACCENT' ? (0.7 + Math.random() * 0.9)
                                   : (0.6 + Math.random() * 1.1);
  const h = Math.max(0.13, Math.min(MAX_SPAN, w * aspect));
  const ang = Math.random() * Math.PI * 2;
  return {
    src,
    role: role || 'MID',
    // allowed to hang off the frame edge — a panel cropped by the frame looks
    // composed, a panel politely inside it looks like a thumbnail
    x: -0.10 + Math.random() * (1.20 - w),
    y: -0.08 + Math.random() * (1.16 - h),
    w, h,
    vx: Math.cos(ang) * m.speed,
    vy: Math.sin(ang) * m.speed * 0.7,
  };
}

// respawn in place, keeping the panel's role so the hierarchy survives a jump
function reseatPanel(p) {
  Object.assign(p, makePanel(p.src, p.role));
}

// keep the panel set matching the sources: one each, then fill to the preset's
// count with duplicates of random sources
function syncPanels() {
  const n = sourceCount();
  if (n === 0) { panels.length = 0; return; }
  const target = Math.min(Math.max(scatter().count, n), Math.max(MAX_PANELS, n));

  for (const p of panels) if (p.src >= n) p.src = Math.floor(Math.random() * n);
  while (panels.length > target) panels.pop();
  // guarantee coverage first
  for (let i = 0; i < n && panels.length < target; i++) {
    if (!panels.some(p => p.src === i)) {
      panels.push(makePanel(i, roleForIndex(panels.length, target)));
    }
  }
  while (panels.length < target) {
    panels.push(makePanel(Math.floor(Math.random() * n), roleForIndex(panels.length, target)));
  }

  // re-role after any count change. the 3D world takes the hero slot when it
  // is on — it is a scene, and at thumbnail size every world looks like the
  // same patch of noise. otherwise the first panel is the hero. either way
  // there is exactly one.
  const worldIdx = panels.findIndex(p => worldEnabled && p.src >= cams.length);
  const heroIdx = worldIdx >= 0 ? worldIdx : 0;
  let sub = 0;
  panels.forEach((p, i) => {
    let want;
    if (i === heroIdx) want = 'HERO';
    else if (panels.length <= 2) want = 'MID';
    // MID first, so the largest non-hero panel is a camera whenever the world
    // has taken the hero slot. starting on ACCENT could shrink the only
    // camera to 15% of frame.
    else want = (sub++ % 2 === 0) ? 'MID' : 'ACCENT';
    if (p.role !== want) Object.assign(p, makePanel(p.src, want));
  });

  // "a camera is always in view" has to mean legible, not merely present. the
  // preset scale multiplies the role range, so a MID under SHARD (x0.78) lands
  // at 21% of frame — and when the world holds the hero slot that can be the
  // only camera on screen. promote the biggest camera panel if none clears it.
  // grown in place rather than rebuilt: syncPanels runs every frame, and
  // makePanel re-randomises position, so rebuilding here would teleport the
  // panel on every frame it failed the check. scaling height with width keeps
  // the aspect, and once it clears the bar the branch stops firing.
  const MIN_LEAD_CAM = 0.32;
  const camPanels = panels.filter(p => p.src < cams.length);
  if (camPanels.length && !camPanels.some(p => p.w >= MIN_LEAD_CAM)) {
    const lead = camPanels.reduce((a, b) => (a.w >= b.w ? a : b));
    const k = MIN_LEAD_CAM / Math.max(0.01, lead.w);
    lead.w = MIN_LEAD_CAM;
    lead.h = Math.max(0.13, Math.min(0.60, lead.h * k));
  }

  // if duplicates crowded out a source, force it back in
  for (let i = 0; i < n; i++) {
    if (!panels.some(p => p.src === i) && panels.length) {
      panels[Math.floor(Math.random() * panels.length)].src = i;
    }
  }
}

function updatePanels(dt) {
  syncPanels();
  const m = scatter();
  const step = dt / 1000;
  for (const p of panels) {
    p.x += p.vx * step;
    p.y += p.vy * step;
    // turn around at a generous boundary rather than wrapping, so a panel
    // never pops from one edge to the other mid-drift
    if (p.x < -0.16) { p.x = -0.16; p.vx = Math.abs(p.vx); }
    if (p.x + p.w > 1.16) { p.x = 1.16 - p.w; p.vx = -Math.abs(p.vx); }
    if (p.y < -0.14) { p.y = -0.14; p.vy = Math.abs(p.vy); }
    if (p.y + p.h > 1.14) { p.y = 1.14 - p.h; p.vy = -Math.abs(p.vy); }
  }
  // glitch jumps land on the beat. the trail from the old position is still
  // decaying in the feedback buffer when the panel reappears elsewhere, which
  // is what makes a jump read as a cut rather than a teleport.
  if (beat.onBeat && panels.length && Math.random() < m.jump) {
    reseatPanel(panels[Math.floor(Math.random() * panels.length)]);
  }
}

function currentCells() {
  if (panels.length === 0) return [[0, 0, 1, 1]];
  return panels.map(p => [
    snapTo(p.x, SNAP_X), snapTo(p.y, SNAP_Y),
    snapTo(p.w, SNAP_X), snapTo(p.h, SNAP_Y),
  ]);
}

function setLayout(name) {
  const i = SCATTER.findIndex(s => s.name === name);
  const changed = i >= 0 && i !== scatterIdx;
  if (i >= 0) scatterIdx = i;
  layoutName = SCATTER[scatterIdx].name;
  syncPanels();
  // the role re-assignment only resizes panels whose ROLE changed, so a preset
  // switch would otherwise leave same-role panels carrying the old preset's
  // scale — a hero sized under SHARD ended up the same width as a mid under
  // SLAB. resize the whole set on a preset change.
  if (changed) panels.forEach(p => reseatPanel(p));
  const t = tag('layout-tag');
  if (t) t.textContent = layoutName;
}

const layoutsFor = () => SCATTER.map(s => s.name);

function pickLayout() {
  setLayout(SCATTER[Math.floor(Math.random() * SCATTER.length)].name);
}

// keep the layout legal when cameras come and go mid-set
function reconcileLayout() {
  setLayout(layoutName);
}

// ---------- FBOs ----------

// full-res internal buffers now go to 1080p (was 720p) — on a 1080p projector
// the old cap meant every frame was upscaled from 720p before it ever hit the
// tape pass. the perf governor below scales this down if the GPU can't keep up.
const MAX_W = 1920;
const MAX_H = 1080;

function createFBO(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('FBO incomplete');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

function clearFBO(f) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
  gl.viewport(0, 0, f.w, f.h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function destroyFBO(f) {
  if (!f) return;
  gl.deleteTexture(f.tex);
  gl.deleteFramebuffer(f.fbo);
}

// feedback ping-pong — only the feedback pass touches these, so effects can
// never contaminate the trail buffer
let feedA = null;
let feedB = null;
// effects ping-pong (each pass: read fxA, write fxB, swap)
let fxA = null;
let fxB = null;
// bloom ping-pong at quarter res
let bloomA = null;
let bloomB = null;
// the multi-camera composite. everything downstream treats this as "the
// camera", so the effect chain is unchanged whether there is one camera or six.
let srcFBO = null;
// the control mask (detail / motion / trail) plus the buffers it needs to
// compare against. half res — the mask drives coarse chunks, so full res would
// cost bandwidth for detail nothing downstream can use.
let maskA = null;
let maskB = null;
let srcPrev = null;
let needsMaskPrime = false;
// the raymarched world, rendered at half res into its own buffer and then
// placed as one cell of the composite like any camera
let worldFBO = null;
// motion detection — tiny buffers holding the downsampled camera; the
// frame-diff between them drives the grid overlay
const MOTION_W = 48;
const MOTION_H = 27;
let motionCurr = null;
let motionPrev = null;
let fboW = 0;
let fboH = 0;

function ensureFBOs() {
  let w = Math.floor(canvas.width * renderScale);
  let h = Math.floor(canvas.height * renderScale);
  if (w > MAX_W || h > MAX_H) {
    const s = Math.min(MAX_W / w, MAX_H / h);
    w = Math.floor(w * s);
    h = Math.floor(h * s);
  }
  w = Math.max(2, w);
  h = Math.max(2, h);
  if (feedA && fboW === w && fboH === h) return;

  destroyFBO(feedA); destroyFBO(feedB);
  destroyFBO(fxA);   destroyFBO(fxB);
  destroyFBO(bloomA); destroyFBO(bloomB);
  destroyFBO(srcFBO);
  destroyFBO(maskA); destroyFBO(maskB); destroyFBO(srcPrev); destroyFBO(worldFBO);
  feedA = createFBO(w, h);
  feedB = createFBO(w, h);
  fxA = createFBO(w, h);
  fxB = createFBO(w, h);
  srcFBO = createFBO(w, h);
  const bw = Math.max(2, w >> 2);
  const bh = Math.max(2, h >> 2);
  bloomA = createFBO(bw, bh);
  bloomB = createFBO(bw, bh);
  const mw = Math.max(2, w >> 1);
  const mh = Math.max(2, h >> 1);
  maskA = createFBO(mw, mh);
  maskB = createFBO(mw, mh);
  srcPrev = createFBO(mw, mh);
  // the world used to share the mask's half resolution, so it was upscaled
  // into its panel and arrived soft. it is scene geometry — it needs the
  // pixels.
  worldFBO = createFBO(w, h);
  [feedA, feedB, fxA, fxB, srcFBO, bloomA, bloomB,
   maskA, maskB, srcPrev, worldFBO].forEach(clearFBO);

  if (!motionCurr) {
    motionCurr = createFBO(MOTION_W, MOTION_H);
    motionPrev = createFBO(MOTION_W, MOTION_H);
    clearFBO(motionCurr);
    clearFBO(motionPrev);
  }
  fboW = w;
  fboH = h;
  // the mask buffers were just recreated black, so the next frame would read
  // as 100% motion and slam every effect to maximum. prime them instead.
  needsMaskPrime = true;
}

// ---------- camera composite ----------
//
// uploads every open camera and draws each into its cell of srcFBO. cells are
// inset by a hairline so the cleared background shows through as a gutter —
// cheaper and cleaner than drawing divider lines afterwards.

const GUTTER_PX = 2;
/** cell rects in pixels from this frame, for the overlay to label */
let lastCellRects = [];
/** where the world panel landed this frame, in 0..1 — null when it is off */
let worldRect = null;

// upload every open camera. done before the world renders, because the world
// textures its surfaces from a camera and must not sample the composite it is
// about to become part of — that would be a feedback loop.
function uploadCameras() {
  for (const cam of cams) {
    const v = cam.video;
    if (v.readyState >= v.HAVE_CURRENT_DATA) {
      gl.bindTexture(gl.TEXTURE_2D, cam.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
    }
  }
}

function renderWorld(now) {
  if (!worldEnabled) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, worldFBO.fbo);
  gl.viewport(0, 0, worldFBO.w, worldFBO.h);

  // the letter rain is not a raymarched scene, so it runs its own program
  if (WORLD_MODES[worldMode] === 'RAIN') {
    gl.useProgram(PROG.rain.p);
    const ru = PROG.rain.u;
    setTex(PROG.rain, 'u_atlas', 0, glyphAtlas);
    setTex(PROG.rain, 'u_cam', 1, cams.length ? cams[activeCam % cams.length].tex : worldFBO.tex);
    gl.uniform2f(ru.u_res, worldFBO.w, worldFBO.h);
    gl.uniform1f(ru.u_time, now / 1000);
    gl.uniform1f(ru.u_count, ATLAS_GLYPHS.length);
    gl.uniform1f(ru.u_wordLo, WORD_LO);
    gl.uniform1f(ru.u_wordN, WORD_N);
    gl.uniform1f(ru.u_energy, crushSmooth);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return;
  }

  gl.useProgram(PROG.world.p);
  const u = PROG.world.u;
  setTex(PROG.world, 'u_cam', 0, cams.length ? cams[activeCam % cams.length].tex : worldFBO.tex);
  gl.uniform2f(u.u_res, worldFBO.w, worldFBO.h);
  gl.uniform1f(u.u_time, now / 1000);
  gl.uniform1f(u.u_energy, crushSmooth);
  // the ray grid is quantised, so this is a genuine low-res render with hard
  // edges rather than a blurred one. it tightens as the track gets loud.
  gl.uniform1f(u.u_px, Math.max(1, Math.round(4 - 2.5 * crushSmooth)));
  gl.uniform1i(u.u_mode, worldMode);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// every visible source, in cell order: the cameras, then the world if it is on
function sourceList() {
  const out = cams.map((c, i) => ({ tex: c.tex, label: camShortLabel(c.label, i), tag: 'CAM' }));
  if (worldEnabled) {
    out.push({ tex: worldFBO.tex, label: WORLD_MODES[worldMode], tag: 'GEN', world: true });
  }
  return out;
}

function compositeCameras() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, srcFBO.fbo);
  gl.viewport(0, 0, srcFBO.w, srcFBO.h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  lastCellRects = [];
  worldRect = null;
  const sources = sourceList();
  if (sources.length === 0) return;

  const cells = currentCells();
  gl.useProgram(PROG.cell.p);

  // painter's order — later panels sit on top of earlier ones
  for (let i = 0; i < cells.length; i++) {
    const srcIdx = panels.length ? panels[i].src % sources.length : 0;
    const src = sources[srcIdx];
    const [cx, cy, cw, ch] = cells[i];
    const px = Math.round(cx * srcFBO.w);
    const pw = Math.round(cw * srcFBO.w);
    const ph = Math.round(ch * srcFBO.h);
    // GL viewport origin is bottom-left; panels are specified from the top
    const py = Math.round(srcFBO.h - (cy + ch) * srcFBO.h);

    // every panel is inset by the gutter on all sides. panels overlap now, so
    // the cleared background showing through the inset is what separates one
    // from the one underneath it — a border for free, no extra pass.
    const vw = Math.max(1, pw - GUTTER_PX * 2);
    const vh = Math.max(1, ph - GUTTER_PX * 2);

    // a viewport may sit partly outside the framebuffer; GL clips it, which is
    // exactly what lets a panel bleed off the frame edge
    gl.viewport(px + GUTTER_PX, py + GUTTER_PX, vw, vh);
    setTex(PROG.cell, 'u_tex', 0, src.tex);
    gl.uniform2f(PROG.cell.u.u_cell, vw, vh);
    // the world already renders at its own aspect, so it needs no fitting and
    // must not be mirrored — only camera sources get the selfie flip
    if (src.world) {
      gl.uniform2f(PROG.cell.u.u_video, vw, vh);
      gl.uniform1f(PROG.cell.u.u_mirror, 0);
      worldRect = { x: cx, y: cy, w: cw, h: ch };
    } else {
      const v = cams[srcIdx % cams.length].video;
      gl.uniform2f(PROG.cell.u.u_video, v.videoWidth || 16, v.videoHeight || 9);
      gl.uniform1f(PROG.cell.u.u_mirror, 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // record in CSS pixels, top-left origin, for the marks overlay
    lastCellRects.push({
      i,
      cam: srcIdx,
      tagName: src.tag,
      label: src.label,
      x: cx * window.innerWidth,
      y: cy * window.innerHeight,
      w: cw * window.innerWidth,
      h: ch * window.innerHeight,
    });
  }
}

function blitInto(dst, srcTex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, dst.w, dst.h);
  gl.useProgram(PROG.blit.p);
  setTex(PROG.blit, 'u_tex', 0, srcTex);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// build this frame's control mask from the composite, the previous composite
// and the previous mask, then stash the composite for next frame's diff
function analyzeFrame() {
  if (needsMaskPrime) {
    // seed prev with the current frame so this frame's diff is zero, and wipe
    // any stale wake out of both mask buffers
    blitInto(srcPrev, srcFBO.tex);
    clearFBO(maskA);
    clearFBO(maskB);
    needsMaskPrime = false;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, maskB.fbo);
  gl.viewport(0, 0, maskB.w, maskB.h);
  gl.useProgram(PROG.analyze.p);
  setTex(PROG.analyze, 'u_curr', 0, srcFBO.tex);
  setTex(PROG.analyze, 'u_prev', 1, srcPrev.tex);
  setTex(PROG.analyze, 'u_mask', 2, maskA.tex);
  gl.uniform2f(PROG.analyze.u.u_res, maskB.w, maskB.h);
  // decay by half-life in real time, not per frame. a per-frame constant makes
  // the wake length depend on framerate — short on a fast GPU, long on a slow
  // one, and different again when the perf governor drops the resolution.
  gl.uniform1f(PROG.analyze.u.u_decay, Math.pow(0.5, frameDt / trailHalfLifeMs));
  gl.uniform1f(PROG.analyze.u.u_detailGain, 6.0);
  gl.uniform1f(PROG.analyze.u.u_motionGain, 5.0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const t = maskA; maskA = maskB; maskB = t;
  blitInto(srcPrev, srcFBO.tex);
}

// read fxA, write fxB, swap. `src` overrides the source texture.
function fxStep(prog, setup, src) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(prog.p);
  setTex(prog, 'u_tex', 0, src !== undefined ? src : fxA.tex);
  if (setup) setup(prog.u);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const t = fxA; fxA = fxB; fxB = t;
}

// ---------- sizing ----------

let renderScale = 1.0;
let sizeDirty = true;

function resize() {
  // DPR capped at 2 — on a 1080p projector this is 1, so the canvas is a
  // native 1920x1080 and the final blit is 1:1.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ensureFBOs();
  sizeDirty = false;
}
window.addEventListener('resize', () => {
  sizeDirty = true;
  updateLetterbox();
});
resize();

// ---------- camera enumeration ----------

// checkbox per detected camera. rendered both before start (pick your inputs)
// and live while running (a row appears the moment a device is plugged in).
function renderCamList() {
  if (!camListEl) return;
  if (videoInputs.length === 0) {
    camListEl.innerHTML = '<div class="cam-none">no cameras detected</div>';
    return;
  }
  camListEl.innerHTML = '';
  videoInputs.forEach((d, i) => {
    const open = cams.findIndex(c => c.deviceId === d.deviceId);
    const row = document.createElement('label');
    row.className = 'cam-row' + (open >= 0 ? ' cam-open' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = camEnabled.has(d.deviceId);
    cb.addEventListener('change', () => {
      if (cb.checked) camEnabled.add(d.deviceId);
      else camEnabled.delete(d.deviceId);
      saveSettings();
      if (running) syncCamStreams();
      else renderCamList();
    });

    const name = document.createElement('span');
    name.className = 'cam-name';
    name.textContent = d.label || `camera ${i + 1}`;

    const slot = document.createElement('span');
    slot.className = 'cam-slot';
    slot.textContent = open >= 0 ? String(open + 1) : '';

    row.append(cb, name, slot);
    camListEl.appendChild(row);
  });
}

async function refreshDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  videoInputs = devs.filter(d => d.kind === 'videoinput');

  // this line is the diagnostic that matters when a camera is "missing": it
  // separates "the browser never reported it" from "it is listed but
  // unticked". only the first is an OS/browser problem.
  const count = tag('cam-count');
  if (count) {
    const unlabeled = videoInputs.filter(d => !d.label).length;
    count.textContent = `${videoInputs.length} video input${videoInputs.length === 1 ? '' : 's'}`
      + (unlabeled ? ` (${unlabeled} unlabeled — permission not granted)` : '');
  }

  // enable anything we're seeing for the first time, but never re-enable a
  // device the user unticked and then reconnected
  for (const d of videoInputs) {
    if (!camSeen.has(d.deviceId)) {
      camSeen.add(d.deviceId);
      if (!camDisabledPersisted.has(d.deviceId)) camEnabled.add(d.deviceId);
    }
  }

  // audio list — preserve the current selection across re-enumeration
  const prevAud = audSelect.value;
  audSelect.innerHTML = '';
  devs.filter(d => d.kind === 'audioinput').forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `audio ${i + 1}`;
    audSelect.appendChild(opt);
  });
  if (prevAud && [...audSelect.options].some(o => o.value === prevAud)) {
    audSelect.value = prevAud;
  }

  if (running) await syncCamStreams();
  else renderCamList();
}

async function listDevices() {
  // prompt once for both kinds so device labels are populated at all
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {
    err.textContent = 'permission denied for camera/mic';
    // still enumerate — without permission the labels come back blank, but the
    // rows appear, so the panel shows something other than dead space
  }
  await refreshDevices();
}

// fires when a camera is plugged in, unplugged, or an iPhone joins/leaves
// over Continuity Camera
if (navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshDevices().catch(() => { /* transient enumeration failure */ });
  });
}

// manual rescan. Continuity Camera in particular can join without firing
// devicechange reliably, so there has to be a way to ask again without
// reloading and losing the running set.
const rescanBtn = tag('rescan');
if (rescanBtn) {
  rescanBtn.addEventListener('click', async () => {
    err.textContent = '';
    rescanBtn.textContent = '...';
    try {
      // re-requesting permission is what usually makes a late-joining
      // Continuity Camera show up in enumerateDevices
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) { /* already denied — enumerate anyway */ }
    await refreshDevices();
    rescanBtn.textContent = 'rescan';
  });
}

// ---------- audio ----------

let audioCtx = null;
let analyser = null;
let freqData = null;
let waveData = null;
let bandRanges = null;
const bands = { bass: 0, mids: 0, highs: 0 };
// transient = positive delta above the expected decay curve — fires on hits
const transients = { bass: 0, mids: 0, highs: 0 };
const BAND_DECAY = 0.90;      // band peak-follower release
const TRANSIENT_DECAY = 0.80; // faster release — transients are short pulses

// audio input gain — tuned via [ / ] during soundcheck so the band bars peak
// around 0.7-0.9 on the loud moments
let audioGain = 1.0;

async function setupAudio(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // line-in must bypass Chrome's processing or the dynamics get crushed
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0; // we run our own peak-follower
  src.connect(analyser);
  // deliberately not connected to destination — avoids speaker feedback
  freqData = new Uint8Array(analyser.frequencyBinCount);
  waveData = new Uint8Array(analyser.fftSize);
  prevSpec = new Uint8Array(analyser.frequencyBinCount);

  const nyquist = audioCtx.sampleRate / 2;
  const bin = (hz) => {
    const n = analyser.frequencyBinCount;
    return Math.max(0, Math.min(n - 1, Math.round((hz / nyquist) * n)));
  };
  bandRanges = {
    bass: [bin(20), bin(200)],
    mids: [bin(200), bin(2000)],
    highs: [bin(2000), analyser.frequencyBinCount - 1],
  };
}

function updateBands() {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  for (const k of ['bass', 'mids', 'highs']) {
    const [lo, hi] = bandRanges[k];
    let sum = 0;
    const n = hi - lo + 1;
    for (let i = lo; i <= hi; i++) sum += freqData[i];
    const raw = ((sum / n) / 255) * audioGain;
    // transient computed before the smoothed value updates, so it only
    // captures upward spikes
    const expected = bands[k] * BAND_DECAY;
    transients[k] = Math.max(Math.max(0, raw - expected), transients[k] * TRANSIENT_DECAY);
    // clamped to 1.0 so a hot input can't push feedback decay past 1 and diverge
    bands[k] = Math.min(1.0, Math.max(raw, expected));
  }
  barEls.bass.style.width = (bands.bass * 100).toFixed(1) + '%';
  barEls.mids.style.width = (bands.mids * 100).toFixed(1) + '%';
  barEls.highs.style.width = (bands.highs * 100).toFixed(1) + '%';
}

const peakTransient = () =>
  Math.max(transients.bass, transients.mids, transients.highs);
const peakBand = () => Math.max(bands.bass, bands.mids, bands.highs);

// ---------- beat tracking ----------
//
// onsets come from spectral flux against an adaptive threshold. tempo is the
// magnitude-peak of a complex sum over candidate periods: for each candidate,
// sum exp(i*2*pi*t/T) over recent onsets — the period where onsets pile up in
// phase wins, and the sum's angle hands us the beat phase for free.
//
// this exists so composition changes land on bar lines. an effect switch on the
// downbeat reads as intentional; the same switch 300ms late reads as a bug.

const beat = {
  bpm: 150,
  period: 60000 / 150,
  anchor: 0,
  conf: 0,
  phase: 0,
  beatIndex: 0,
  barIndex: 0,
  lastIdx: NaN,
  onBeat: false,
  onBar: false,
};

let prevSpec = null;
const fluxHist = [];
const onsetTimes = [];
const onsetWeights = [];
let lastOnsetAt = 0;
let nextTempoEst = 0;
let tapLocked = false;

const TEMPO_MIN = 70;
const TEMPO_MAX = 190;
const TEMPO_PRIOR = 150; // hyperpop sits high; biases away from half-time locks

function detectOnset(now) {
  if (!analyser || !prevSpec) return 0;
  let flux = 0;
  for (let i = 0; i < freqData.length; i++) {
    const d = freqData[i] - prevSpec[i];
    if (d > 0) flux += d;
  }
  flux /= freqData.length * 255;
  prevSpec.set(freqData);

  fluxHist.push(flux);
  if (fluxHist.length > 90) fluxHist.shift();

  let m = 0;
  for (const f of fluxHist) m += f;
  m /= fluxHist.length;
  let v = 0;
  for (const f of fluxHist) v += (f - m) * (f - m);
  v = Math.sqrt(v / fluxHist.length);

  // adaptive threshold + a floor so room noise doesn't generate onsets
  if (flux > m + 1.4 * v + 0.004 && now - lastOnsetAt > 90) {
    lastOnsetAt = now;
    onsetTimes.push(now);
    onsetWeights.push(Math.min(1, flux * 12));
    while (onsetTimes.length && now - onsetTimes[0] > 8000) {
      onsetTimes.shift();
      onsetWeights.shift();
    }
  }
  return flux;
}

// how well onsets pile up in phase at this candidate tempo. magnitude is the
// score; the angle is the common phase, which hands us the beat grid for free.
function tempoScore(bpm, now) {
  const T = 60000 / bpm;
  let re = 0, im = 0, wsum = 0;
  for (let i = 0; i < onsetTimes.length; i++) {
    // recency weighting — the last couple of seconds dominate, so a tempo
    // change mid-set is picked up instead of averaged away
    const w = onsetWeights[i] * Math.exp(-(now - onsetTimes[i]) / 6000);
    const a = 2 * Math.PI * (onsetTimes[i] / T);
    re += Math.cos(a) * w;
    im += Math.sin(a) * w;
    wsum += w;
  }
  if (wsum <= 0) return { mag: 0, angle: 0, T };
  return { mag: Math.hypot(re, im) / wsum, angle: Math.atan2(im, re), T };
}

function estimateTempo(now) {
  if (onsetTimes.length < 8) {
    beat.conf = 0;
    return;
  }
  let best = null;
  for (let bpm = TEMPO_MIN; bpm <= TEMPO_MAX; bpm += 0.25) {
    const s = tempoScore(bpm, now);
    // octave prior — biases the search away from half/double-time locks
    const oct = Math.log2(bpm / TEMPO_PRIOR);
    const ranked = s.mag * Math.exp(-(oct * oct) / (2 * 0.55 * 0.55));
    if (!best || ranked > best.ranked) {
      best = { bpm, T: s.T, mag: s.mag, angle: s.angle, ranked };
    }
  }
  if (!best) return;

  // octave correction. a tempo and its double score almost identically — every
  // onset of the slower grid is also an onset of the faster one — so the prior
  // alone will happily pick 180 for a 90bpm track. if an exact submultiple
  // scores nearly as well, it is the real tempo, so take the slowest one.
  // (the converse is safe: at the true tempo, halving makes alternate onsets
  // land in antiphase and cancel, so a false half-time never scores highly.)
  for (const div of [3, 2]) {
    const bpm = best.bpm / div;
    if (bpm < TEMPO_MIN) continue;
    const s = tempoScore(bpm, now);
    if (s.mag >= best.mag * 0.90) {
      best = { bpm, T: s.T, mag: s.mag, angle: s.angle, ranked: best.ranked };
      break;
    }
  }

  beat.conf = best.mag;
  // only re-lock when the estimate is actually convincing; otherwise keep the
  // previous period so the grid doesn't wander during a breakdown
  if (best.mag > 0.10) {
    beat.bpm = best.bpm;
    beat.period = best.T;
    beat.anchor = (best.angle / (2 * Math.PI)) * best.T;
  }
}

// tap tempo — the reliable override when the estimator fights a sparse intro
const taps = [];
function tapTempo(now) {
  if (taps.length && now - taps[taps.length - 1] > 2500) taps.length = 0;
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length < 2) return;
  let sum = 0;
  for (let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
  beat.period = sum / (taps.length - 1);
  beat.bpm = 60000 / beat.period;
  beat.anchor = now % beat.period;
  tapLocked = true;
}

function updateBeat(now) {
  beat.onBeat = false;
  beat.onBar = false;
  if (!tapLocked && now >= nextTempoEst) {
    estimateTempo(now);
    nextTempoEst = now + 1200;
  }
  const pos = (now - beat.anchor) / beat.period;
  const idx = Math.floor(pos);
  beat.phase = pos - idx;
  if (idx !== beat.lastIdx) {
    // a re-lock can jump idx arbitrarily; any change counts as exactly one beat
    beat.lastIdx = idx;
    beat.beatIndex++;
    beat.onBeat = true;
    if (beat.beatIndex % 4 === 0) {
      beat.barIndex++;
      beat.onBar = true;
    }
  }
}

// ---------- palettes ----------
//
// every palette is a 3-stop luma ramp: shadow, midtone, highlight.
//
// these are all one colour. the set is deliberately narrow — variation comes
// from the rigs and scenes, not from the hue. ICE is the house look and the
// others are depth/contrast variations on it, so a palette change reads as the
// room getting darker or colder rather than as a different piece.
// `weight` biases the auto-picker; ICE is meant to be where it mostly sits.

const PALETTES = [
  // the original — navy to pure blue to pale blue
  { name: 'ICE',   weight: 4, dark: [0.02, 0.03, 0.10], mid: [0.08, 0.15, 0.78], bright: [0.55, 0.65, 0.88] },
  // same hue, pulled down — holds detail in the highlights instead of blowing out
  { name: 'DEEP',  weight: 2, dark: [0.01, 0.02, 0.08], mid: [0.05, 0.09, 0.55], bright: [0.38, 0.52, 0.86] },
  // desaturated toward silver — reads as cold metal, still blue
  { name: 'STEEL', weight: 2, dark: [0.02, 0.03, 0.05], mid: [0.20, 0.28, 0.42], bright: [0.72, 0.82, 0.95] },
  // near-black; almost all shadow, for the quiet parts
  { name: 'TAR',   weight: 1, dark: [0.01, 0.01, 0.02], mid: [0.07, 0.09, 0.16], bright: [0.34, 0.40, 0.58] },
];

let palIdx = 0;
// live values, lerped toward the target so palette changes crossfade over
// roughly a second instead of cutting
const palCur = {
  dark: PALETTES[0].dark.slice(),
  mid: PALETTES[0].mid.slice(),
  bright: PALETTES[0].bright.slice(),
};

function setPalette(i) {
  palIdx = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
  const t = tag('pal-tag');
  if (t) t.textContent = PALETTES[palIdx].name;
}

function updatePaletteLerp() {
  const target = PALETTES[palIdx];
  let drift = 0;
  for (const k of ['dark', 'mid', 'bright']) {
    for (let i = 0; i < 3; i++) {
      const d = target[k][i] - palCur[k][i];
      drift += Math.abs(d);
      palCur[k][i] += d * 0.04;
    }
  }
  // the overlay filter is an SVG attribute write, which is far too expensive
  // to do every frame — only rewrite it while the palette is actually moving
  if (drift > 0.004) updateOverlayPalette();
}

// sample the live palette ramp into the SVG transfer tables used by the GIF
// and clip tiles, so overlay footage is graded by the same curve as the camera
const gifR = tag('gifR');
const gifG = tag('gifG');
const gifB = tag('gifB');

function rampAt(t) {
  const { dark, mid, bright } = palCur;
  return t < 0.5
    ? [0, 1, 2].map(i => dark[i] + (mid[i] - dark[i]) * (t * 2))
    : [0, 1, 2].map(i => mid[i] + (bright[i] - mid[i]) * ((t - 0.5) * 2));
}

function updateOverlayPalette() {
  if (!gifR) return;
  // straight ramp, no lift. multiplying the stops up was pushing the top of
  // the curve past white, which clips the highlights to flat blocks of colour
  // — overlays are separated from the camera by tile opacity and the border,
  // not by being brighter than it.
  const stops = [0, 0.25, 0.5, 0.75, 1].map(rampAt);
  const fmt = (i) => stops.map(s => Math.min(1, Math.max(0, s[i])).toFixed(3)).join(' ');
  gifR.setAttribute('tableValues', fmt(0));
  gifG.setAttribute('tableValues', fmt(1));
  gifB.setAttribute('tableValues', fmt(2));
}

// ---------- scenes ----------

// the mirror-fold compositions (kaleidoscopes, quad) and the polar tunnel are
// gone — radial symmetry reads as a screensaver, not as a set.
const SCENE_NAMES = ['DIRECT', 'FLIP', 'SLICE', 'PUSH'];
let scene = 0;
function setScene(i) {
  scene = ((i % SCENE_NAMES.length) + SCENE_NAMES.length) % SCENE_NAMES.length;
  const t = tag('scene-tag');
  if (t) t.textContent = SCENE_NAMES[scene];
}

// ---------- rigs ----------
//
// a rig is a weighting over the effect chain. 0 means the pass is skipped
// entirely, which is also how the lighter rigs buy back GPU headroom.
//   sil/rgb/sort/disp/edge/aberr/motion — pass intensity multipliers
//   bloom    — additive bloom amount
//   crush    — multiplier on the tape-pass crush intensity
//   decay    — multiplier on trail *persistence* (>1 = longer trails)
//   swirl    — radians/frame of rotation on the trail buffer
//   zoom     — <1 trails converge inward, >1 they fly outward
//   scenes   — compositions this rig looks good in

// intensities are deliberately conservative. the job is a live show — the
// crowd and the performer have to read, and an effect that erases them is a
// failed effect no matter how good it looks on a still frame. `decay` is a
// multiplier on trail persistence, so >1 means longer trails.
const RIGS = [
  {
    name: 'FULL', stretch: 1.48,
    sil: 0.8, rgb: 0.8, sort: 0.7, disp: 0.35, edge: 0, aberr: 0.8,
    bloom: 1.25, motion: 0.8, crush: 0.8, decay: 1.0,
    swirl: 0.0008, zoom: 0.995, wobble: 0.0004, vignette: 0.35,
    scenes: [0, 1, 2, 3],
  },
  {
    // the readable one — intros, vocals, crowd shots. weighted to come up often.
    name: 'CLEAN', stretch: 1.18,
    sil: 0, rgb: 0.25, sort: 0, disp: 0, edge: 0, aberr: 0.35,
    bloom: 0.80, motion: 0, crush: 0.30, decay: 0.45,
    swirl: 0, zoom: 0.998, wobble: 0.0001, vignette: 0.45,
    scenes: [0, 1, 3],
  },
  {
    name: 'SHRED', stretch: 1.52,
    sil: 0, rgb: 1.1, sort: 1.0, disp: 0.8, edge: 0, aberr: 1.0,
    bloom: 0.60, motion: 0, crush: 1.0, decay: 0.7,
    swirl: 0, zoom: 1.003, wobble: 0.0010, vignette: 0.25,
    scenes: [0, 1, 2],
  },
  {
    // long trails, but the live frame still has to win over its own history
    name: 'GHOST', stretch: 1.42,
    sil: 0.7, rgb: 0.3, sort: 0, disp: 0, edge: 0, aberr: 0.6,
    bloom: 0.85, motion: 0, crush: 0.35, decay: 1.6,
    swirl: 0.0030, zoom: 0.990, wobble: 0.0001, vignette: 0.5,
    scenes: [0, 1, 3],
  },
  {
    // CCTV read — edges plus the motion grid. very legible by design.
    name: 'SCAN', stretch: 1.14,
    sil: 0, rgb: 0.18, sort: 0, disp: 0, edge: 0.7, aberr: 0.25,
    bloom: 0.55, motion: 0.9, crush: 0.5, decay: 0.35,
    swirl: 0, zoom: 0.999, wobble: 0, vignette: 0.55,
    scenes: [0, 1],
  },
  {
    name: 'MELT', stretch: 1.58,
    sil: 0.4, rgb: 0.6, sort: 0.5, disp: 1.1, edge: 0, aberr: 0.8,
    bloom: 1.05, motion: 0, crush: 0.85, decay: 1.5,
    swirl: 0.0022, zoom: 1.004, wobble: 0.0014, vignette: 0.3,
    scenes: [0, 2, 3],
  },
  {
    name: 'STAMP', stretch: 1.38,
    sil: 1.0, rgb: 0.45, sort: 0.3, disp: 0.2, edge: 0.3, aberr: 0.4,
    bloom: 0.60, crush: 1.0, motion: 0, decay: 0.55,
    swirl: 0, zoom: 0.996, wobble: 0.0005, vignette: 0.4,
    scenes: [0, 1, 3],
  },
];

// how often each rig comes up. CLEAN is weighted high on purpose — the set
// needs to keep returning to something you can actually see.
const RIG_WEIGHTS = [3, 5, 2, 3, 3, 2, 2];

let rigIdx = 0;
const rig = () => RIGS[rigIdx];
function setRig(i) {
  rigIdx = ((i % RIGS.length) + RIGS.length) % RIGS.length;
  const t = tag('rig-tag');
  if (t) t.textContent = RIGS[rigIdx].name;
}

// ---------- scheduler ----------
//
// composition/rig/palette changes fire on bar boundaries at musical intervals
// rather than on fixed timers, so the set has phrasing.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let autoScene = true;
let autoRig = true;
let autoPal = true;

const sched = {
  nextScene: 0, nextRig: 0, nextPal: 0, nextLayer: 0, nextCamLayout: 0,
  nextAscii: 2, nextWorld: 4,
};
// whether the scheduler may bring the ascii pass and the 3D worlds in and out
// on its own. `a` toggles it along with the other auto axes.
//
// a manual press does NOT switch this off for good — it parks the scheduler
// for a stretch of bars and then hands control back. permanently disabling it
// on one keypress meant a single exploratory tap silently stopped ascii and
// the worlds from ever appearing again.
let autoFx = true;
let fxHoldUntilBar = -1;
const FX_HOLD_BARS = 16;

function holdFx() {
  fxHoldUntilBar = beat.barIndex + FX_HOLD_BARS;
}
const fxHeld = () => beat.barIndex < fxHoldUntilBar;

// DIRECT and FLIP show the room as it is; everything else fractures it. the
// straight ones need to dominate or you never actually see the performance.
function pickScene() {
  const allowed = rig().scenes;
  let next = scene;
  for (let i = 0; i < 8 && next === scene; i++) {
    next = (Math.random() < 0.6 && allowed.indexOf(0) >= 0)
      ? (Math.random() < 0.5 ? 0 : 1)
      : pick(allowed);
  }
  if (allowed.indexOf(next) < 0) next = allowed[0];
  setScene(next);
}

function pickRig() {
  const total = RIG_WEIGHTS.reduce((a, b) => a + b, 0);
  let next = rigIdx;
  for (let attempt = 0; attempt < 8 && next === rigIdx; attempt++) {
    let r = Math.random() * total;
    for (let i = 0; i < RIGS.length; i++) {
      r -= RIG_WEIGHTS[i];
      if (r <= 0) { next = i; break; }
    }
  }
  setRig(next);
  // a new rig may not support the current scene
  if (rig().scenes.indexOf(scene) < 0) pickScene();
}

// weighted so the set keeps gravitating back to ICE rather than spending equal
// time in each variation
function pickPalette() {
  const total = PALETTES.reduce((a, p) => a + p.weight, 0);
  for (let attempt = 0; attempt < 8; attempt++) {
    let r = Math.random() * total;
    let next = 0;
    for (let i = 0; i < PALETTES.length; i++) {
      r -= PALETTES[i].weight;
      if (r <= 0) { next = i; break; }
    }
    if (next !== palIdx) {
      setPalette(next);
      return;
    }
  }
}

function updateScheduler() {
  if (!beat.onBar) return;
  const bar = beat.barIndex;
  if (bar >= sched.nextScene) {
    if (autoScene) pickScene();
    sched.nextScene = bar + pick([2, 2, 4, 4, 4, 8]);
  }
  if (bar >= sched.nextRig) {
    if (autoRig) pickRig();
    sched.nextRig = bar + pick([4, 4, 8, 8, 16]);
  }
  if (bar >= sched.nextPal) {
    if (autoPal) pickPalette();
    // song-section pacing — roughly 50-100s at 150bpm. the palette is the
    // slowest-moving axis on purpose; rigs and scenes carry the variation.
    sched.nextPal = bar + pick([32, 32, 64, 64]);
  }
  if (bar >= sched.nextLayer) {
    pickLayerPhase();
    sched.nextLayer = bar + pick([2, 4, 4, 8]);
  }
  if (bar >= sched.nextCamLayout) {
    if (autoLayout && sourceCount() > 1) pickLayout();
    // slower than the scene axis — re-cutting the camera grid every couple of
    // bars is disorienting rather than dynamic
    sched.nextCamLayout = bar + pick([4, 8, 8, 16]);
  }
  // ASCII comes in for a few bars at a time, then clears out. it is a strong
  // look, so it works as punctuation rather than as a constant.
  if (bar >= sched.nextAscii) {
    if (autoFx && !fxHeld()) {
      if (asciiAmount > 0.01) {
        asciiAmount = 0;
        sched.nextAscii = bar + pick([4, 5, 6, 8]);
      } else {
        asciiAmount = 0.92;
        asciiMode = Math.random() < 0.5 ? 0 : 1;
        sched.nextAscii = bar + pick([2, 3, 4, 6]);
      }
      updateFxTags();
    } else {
      sched.nextAscii = bar + 8;
    }
  }

  // rotate the 3D world panel in and out, and through its modes
  if (bar >= sched.nextWorld) {
    if (autoFx && !fxHeld()) {
      worldEnabled = Math.random() < 0.7;
      if (worldEnabled) worldMode = pickWorldMode();
      reconcileLayout();
      updateCamTag();
      updateFxTags();
    }
    sched.nextWorld = bar + pick([4, 6, 8, 12]);
  }

  // occasional single-bar negative flash on a downbeat
  if (strobeEnabled && Math.random() < 0.06) invertUntil = performance.now() + 90;
}

// ---------- perf governor ----------
//
// a dropped frame during a show is worse than a soft frame, so measured frame
// time walks the internal resolution down (and back up) on its own.

const SCALE_STEPS = [0.5, 0.6, 0.7, 0.85, 1.0];
let scaleIdx = SCALE_STEPS.length - 1;
let autoScale = true;
let frameMsEMA = 16.7;
let govCount = 0;

function applyScale() {
  renderScale = SCALE_STEPS[scaleIdx];
  ensureFBOs();
  const t = tag('scale-tag');
  if (t) t.textContent = Math.round(renderScale * 100) + '%';
}

function updateGovernor(dt) {
  // a backgrounded tab has requestAnimationFrame throttled to about 1fps, which
  // is not a GPU problem. without this the measured frame time balloons, the
  // governor concludes the machine cannot keep up and walks the resolution
  // down — so alt-tabbing away and back would quietly cost you render scale.
  if (document.hidden) return;
  frameMsEMA += (dt - frameMsEMA) * 0.05;
  const t = tag('fps-tag');
  if (t && (govCount % 15) === 0) t.textContent = (1000 / frameMsEMA).toFixed(0);
  if (!autoScale) return;
  if (++govCount < 90) return;
  govCount = 0;
  if (frameMsEMA > 22 && scaleIdx > 0) {
    scaleIdx--;
    applyScale();
  } else if (frameMsEMA < 13 && scaleIdx < SCALE_STEPS.length - 1) {
    scaleIdx++;
    applyScale();
  }
}

// ---------- start ----------

let running = false;

async function start() {
  err.textContent = '';
  if (camEnabled.size === 0) {
    err.textContent = 'tick at least one camera';
    return;
  }

  running = true;   // set first so syncCamStreams actually opens the pool
  await syncCamStreams();
  if (cams.length === 0) {
    running = false;
    if (!err.textContent) err.textContent = 'no camera could be opened';
    return;
  }

  try {
    await setupAudio(audSelect.value);
  } catch (e) {
    err.textContent = 'audio error: ' + e.message;
    // keep going — the cameras still render, just without reactivity
  }

  activeCam = 0;
  updateCamTag();
  setScene(0);
  setRig(0);
  setPalette(0);
  applyScale();
  ui.classList.add('hidden');
  lastFrameAt = performance.now();
  scheduleCamCycle();
  startOverlayTimers();
  requestAnimationFrame(loop);
}

startBtn.addEventListener('click', start);

// ---------- render loop ----------

let frozen = false;
let blackout = false;
let frameCount = 0;
let lastFrameAt = 0;
let invertUntil = 0;
let strobeEnabled = true;
let exposure = 1.0;
let marksEnabled = true;

// how strongly the effects follow the control mask rather than applying a flat
// global strength. 0 reproduces the old uniform behaviour.
let reactivity = 1.0;
// how long the motion wake survives, as a half-life in ms. ~220ms reads as a
// trail behind a moving hand without smearing the frame into fog.
let trailHalfLifeMs = 220;
// set each frame from the real delta so the wake is framerate-independent
let frameDt = 16.7;
// brightness of the pixel dust trailing movement
let trailGain = 0.55;
// debug view of the control mask. deliberately NOT bound to a key — it is a
// tuning aid, not a look. set it from the console if the mask needs checking.
let showMask = false;
// ASCII: 0 = off. mode 0 rebuilds the image from a density ladder, mode 1
// fills the shape with repeating NOMU.
let asciiAmount = 0;
let asciiMode = 0;

// letterbox. a cinema crop is the fastest way to stop a full-bleed 16:9
// webcam reading as phone video.
//
// the bar height is derived from the LIVE viewport aspect, not a baked
// constant: showing aspect A in a frame of aspect F leaves (F / A) of the
// height visible, so each bar is (1 - F/A) / 2. this was previously written as
// (1 - (9/16) / (1/A)) / 2, which inverts 9/16 and produces a NEGATIVE bar —
// the bars never drew, and everything that positions against the safe area
// (the name, the tiles) was handed a negative top edge and allowed to run off
// the top of the screen.
const LETTERBOX_MODES = [
  { name: '16:9', aspect: null },
  { name: '2.00', aspect: 2.00 },
  { name: '2.39', aspect: 2.39 },
];
// defaults to full frame. the bars were mathematically negative until the
// aspect fix, so they never actually drew — turning them on by default was an
// unintended change in look, not a decision. `o` still cycles the crops.
let letterboxIdx = 0;
let letterbox = 0;

function updateLetterbox() {
  const mode = LETTERBOX_MODES[letterboxIdx];
  if (!mode.aspect) { letterbox = 0; return; }
  const frame = window.innerWidth / Math.max(1, window.innerHeight);
  // clamped at 0: a frame already narrower than the target needs no bars
  letterbox = Math.max(0, Math.min(0.45, (1 - frame / mode.aspect) / 2));
}

function resetFeedback() {
  if (!feedA) return;
  clearFBO(feedA);
  clearFBO(feedB);
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min(100, now - lastFrameAt);
  lastFrameAt = now;
  frameDt = dt;

  if (sizeDirty) resize();
  updateGovernor(dt);
  updateBands();
  detectOnset(now);
  updateBeat(now);
  updateScheduler();
  updatePaletteLerp();
  updateCrushIntensity();
  updateTextGlitch();
  updateCodeLines();
  drawWaveform();

  // blackout — panic key. still pumps the audio/beat state so the trackers
  // stay locked, just draws nothing.
  if (blackout) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    frameCount++;
    return;
  }

  const R = rig();
  const trans = peakTransient();
  const level = peakBand();

  bindQuad();

  // composite every open camera into srcFBO. when the pool is empty this just
  // clears to black and the trails decay out — a far better failure mode on
  // stage than a stopped loop.
  updatePanels(dt);
  uploadCameras();
  renderWorld(now);
  compositeCameras();
  analyzeFrame();
  drawCellMarks();

  // the composite already matches the render aspect, so the feedback pass has
  // no further fitting to do
  const vidW = srcFBO.w;
  const vidH = srcFBO.h;

  // --- feedback: webcam + feedA (prev) -> feedB. loops on itself.
  if (!frozen) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, feedB.fbo);
    gl.viewport(0, 0, fboW, fboH);
    gl.useProgram(PROG.feedback.p);
    const u = PROG.feedback.u;
    setTex(PROG.feedback, 'u_webcam', 0, srcFBO.tex);
    setTex(PROG.feedback, 'u_prev', 1, feedA.tex);
    gl.uniform2f(u.u_canvas, fboW, fboH);
    gl.uniform2f(u.u_video, vidW, vidH);
    // parameterised on trail *loss* so a rig multiplier scales persistence
    // predictably; clamped below 1 because decay >= 1 never converges
    // shorter by default: 0.94 left a ~16-frame smear that buried the live
    // image under its own history. 0.86 is about 7 frames — enough to read as
    // a trail, not enough to bury the performer.
    const loss = (1 - (0.86 + 0.045 * bands.mids)) / R.decay;
    gl.uniform1f(u.u_decay, Math.max(0.80, Math.min(0.995, 1 - loss)));
    // per-rig. even the readable rigs carry some stretch now — it is part of
    // the look, not a distortion to be minimised. bass pushes it further.
    gl.uniform1f(u.u_stretch, R.stretch + 0.30 * bands.bass);
    gl.uniform1f(u.u_zoom, R.zoom);
    gl.uniform1f(u.u_swirl, R.swirl * (1 + 2 * bands.bass));
    // slow drift on the live sample — only in the polar/fold scenes, where a
    // rotating source reads as motion rather than as a wonky camera
    const rotScenes = false;
    gl.uniform1f(u.u_rot, rotScenes ? Math.sin(now / 9000) * 0.25 : 0);
    gl.uniform1f(u.u_time, now / 1000);
    gl.uniform1i(u.u_scene, scene);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const t = feedA; feedA = feedB; feedB = t;
  }

  // === effect chain. first pass reads feedA, the rest ping-pong through fx*.
  let seeded = false;
  const seed = (prog, setup) => {
    fxStep(prog, setup, seeded ? undefined : feedA.tex);
    seeded = true;
  };

  if (R.sil > 0) {
    seed(PROG.silhouette, (u) => {
      // higher threshold and less bass swing, so this clips stage lights and
      // highlights rather than whole faces
      gl.uniform1f(u.u_thresh, 0.84 - 0.16 * bands.bass);
      gl.uniform1f(u.u_lumaGain, 0.60);
      gl.uniform1f(u.u_amount, Math.min(1, R.sil) * 0.55);
    });
  }

  if (R.rgb > 0) {
    seed(PROG.rgb, (u) => {
      gl.uniform1f(u.u_offset, (0.002 + 0.025 * bands.bass) * R.rgb);
      // split direction drifts so it is not permanently a horizontal tear
      gl.uniform1f(u.u_angle, Math.sin(now / 7000) * 0.6);
    });
  }

  if (R.sort > 0) {
    const strength = Math.min(0.7, trans * 2.0 * R.sort);
    if (strength > 0.01) {
      // sort direction follows the scene so grid modes smear along the tiles
      const a = 0;
      seed(PROG.sort, (u) => {
        setTex(PROG.sort, 'u_mask', 1, maskA.tex);
        gl.uniform2f(u.u_res, fboW, fboH);
        gl.uniform2f(u.u_dir, Math.cos(a), Math.sin(a));
        gl.uniform1f(u.u_strength, strength);
        gl.uniform1f(u.u_react, reactivity);
      });
    }
  }

  if (R.disp > 0) {
    const amount = Math.min(0.7, R.disp * (0.08 + trans * 1.4));
    if (amount > 0.02) {
      seed(PROG.displace, (u) => {
        setTex(PROG.displace, 'u_mask', 1, maskA.tex);
        gl.uniform1f(u.u_react, reactivity);
        gl.uniform1f(u.u_amount, amount);
        gl.uniform1f(u.u_bands, 44);
        gl.uniform1f(u.u_blocks, 56);
        gl.uniform1f(u.u_time, now / 1000);
        // gestures run on the beat grid — one cycle per bar — so the damage
        // moves in time with the track instead of on its own clock
        gl.uniform1f(u.u_period, Math.max(0.35, (beat.period * 4) / 1000));
        // the seed only changes every couple of bars, so the SAME bands keep
        // gesturing for a while. re-rolling it constantly was what made this
        // look like static instead of something moving.
        gl.uniform1f(u.u_seed, (beat.barIndex >> 1) % 997);
      });
    }
  }

  if (R.edge > 0) {
    seed(PROG.edge, (u) => {
      gl.uniform2f(u.u_res, fboW, fboH);
      gl.uniform1f(u.u_amount, R.edge * (0.45 + 0.4 * bands.mids));
    });
  }

  if (R.aberr > 0) {
    seed(PROG.aberr, (u) => {
      gl.uniform1f(u.u_strength, (0.008 + 0.007 * bands.mids) * R.aberr);
    });
  }

  // --- ascii: rebuild the frame out of type. sits before the palette so the
  // glyphs come through the same blue ramp as everything else.
  if (asciiAmount > 0.01) {
    seed(PROG.ascii, (u) => {
      setTex(PROG.ascii, 'u_atlas', 1, glyphAtlas);
      gl.uniform2f(u.u_res, fboW, fboH);
      // cell tightens as the track gets loud, so the type resolves on peaks
      gl.uniform1f(u.u_cell, Math.max(6, Math.round(16 - 7 * crushSmooth)));
      gl.uniform1f(u.u_count, ATLAS_GLYPHS.length);
      gl.uniform1f(u.u_rampLo, RAMP_LO);
      gl.uniform1f(u.u_rampN, RAMP_N);
      gl.uniform1f(u.u_wordLo, WORD_LO);
      gl.uniform1f(u.u_wordN, WORD_N);
      gl.uniform1f(u.u_mode, asciiMode);
      gl.uniform1f(u.u_amount, asciiAmount);
    });
  }

  // --- palette: luma -> gradient, plus strobe and negative flashes
  seed(PROG.palette, (u) => {
    gl.uniform3fv(u.u_dark, palCur.dark);
    gl.uniform3fv(u.u_mid, palCur.mid);
    gl.uniform3fv(u.u_bright, palCur.bright);
    const strobe = (strobeEnabled && level > 0.80 && (frameCount & 1) === 0) ? 1 : 0;
    gl.uniform1f(u.u_strobe, strobe);
    gl.uniform1f(u.u_invert, now < invertUntil ? 1 : 0);
    gl.uniform1f(u.u_contrast, 1.0 + 0.35 * bands.highs);
    gl.uniform1f(u.u_lift, 0.0);
  });

  // --- bloom: bright-pass and blur at quarter res, then add back
  if (R.bloom > 0.01) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
    gl.viewport(0, 0, bloomA.w, bloomA.h);
    gl.useProgram(PROG.bright.p);
    setTex(PROG.bright, 'u_tex', 0, fxA.tex);
    setTex(PROG.bright, 'u_mask', 1, maskA.tex);
    gl.uniform1f(PROG.bright.u.u_thresh, 0.55);
    gl.uniform1f(PROG.bright.u.u_trailGlow, trailGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // anamorphic: two wide horizontal passes to one narrow vertical, so
    // highlights streak sideways like a spherical-adapter flare instead of
    // haloing evenly. symmetric glow is the giveaway of a stock bloom filter.
    for (const [dx, dy] of [[3.2, 0], [3.2, 0], [0, 0.85]]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fbo);
      gl.viewport(0, 0, bloomB.w, bloomB.h);
      gl.useProgram(PROG.blur.p);
      setTex(PROG.blur, 'u_tex', 0, bloomA.tex);
      gl.uniform2f(PROG.blur.u.u_dir, dx / bloomA.w, dy / bloomA.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const t = bloomA; bloomA = bloomB; bloomB = t;
    }

    fxStep(PROG.combine, (u) => {
      setTex(PROG.combine, 'u_bloom', 1, bloomA.tex);
      gl.uniform1f(u.u_amount, R.bloom * (0.7 + 0.6 * bands.highs));
    });
  }

  // --- motion grid overlay
  if (R.motion > 0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, motionCurr.fbo);
    gl.viewport(0, 0, motionCurr.w, motionCurr.h);
    gl.useProgram(PROG.wcopy.p);
    setTex(PROG.wcopy, 'u_webcam', 0, srcFBO.tex);
    gl.uniform2f(PROG.wcopy.u.u_canvas, motionCurr.w, motionCurr.h);
    gl.uniform2f(PROG.wcopy.u.u_video, vidW, vidH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    fxStep(PROG.motion, (u) => {
      setTex(PROG.motion, 'u_curr', 1, motionCurr.tex);
      setTex(PROG.motion, 'u_prev', 2, motionPrev.tex);
      gl.uniform2f(u.u_grid, MOTION_W, MOTION_H);
      gl.uniform1f(u.u_thresh, 0.06);
      gl.uniform1f(u.u_amount, R.motion);
    });

    // swap so this frame's curr is next frame's prev
    const t = motionCurr; motionCurr = motionPrev; motionPrev = t;
  }

  // --- tape pass: wobble, crush, dither, scanlines, brightness, vignette, grain
  fxStep(PROG.film, (u) => {
    const i = Math.min(1, crushIntensity * R.crush);
    gl.uniform2f(u.u_res, fboW, fboH);
    // this is the CEILING, not the block size — the shader picks a size per
    // region between 1 and this. squared so quiet passages sit at fine detail
    // and only real energy opens up the big blocks, giving the drastic size
    // range rather than a mid-sized mush everywhere.
    gl.uniform1f(u.u_pixelSize, Math.max(1, Math.round(1 + 3 * i * i)));
    // floor raised from 8 to 30. at 8 levels the dither amplitude is 1/8,
    // which is enough to flip neighbouring pixels between black and white and
    // turn flat areas into a checkerboard — the other half of the QR look.
    gl.uniform1f(u.u_crushLevels, Math.max(30, Math.round(110 - 80 * i * i)));
    gl.uniform1f(u.u_grain, 0.018 + 0.042 * i);
    gl.uniform1f(u.u_scanline, 0.02 + 0.07 * i);
    gl.uniform1f(u.u_wobble, R.wobble * (0.4 + trans * 3.0));
    gl.uniform1f(u.u_vignette, R.vignette);
    gl.uniform1f(u.u_dither, 0.45);
    gl.uniform1f(u.u_contrast, 1.06);
    gl.uniform1f(u.u_bar, letterbox);
    setTex(PROG.film, 'u_mask', 1, maskA.tex);
    gl.uniform1f(u.u_react, reactivity);
    gl.uniform1f(u.u_trailGain, 0.0);
    // exposure feeds a filmic curve now, so it can be pushed past 1 without
    // clipping — highlights roll off instead of flattening to white
    gl.uniform1f(u.u_brightness, exposure * (
      0.85
      + 0.04 * Math.sin(now / 1800)
      + transients.bass * 3.0
    ));
    gl.uniform1f(u.u_time, now / 1000);
  });

  frameCount++;

  // --- final blit to screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(PROG.blit.p);
  setTex(PROG.blit, 'u_tex', 0, showMask ? maskA.tex : fxA.tex);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------- hotkeys ----------

// every key the handler implements. HELP_KEYS below is checked against the
// handler by the smoke test — this list drifted out of date once already
// because a find-and-replace silently missed, and an undocumented hotkey may
// as well not exist.
const HELP = [
  ['f', 'fullscreen'],
  ['h', 'hide / show ALL overlays'],
  ['i', 'hide / show HUD only'],
  ['\\', 'BLACKOUT (panic)'],
  ['space', 'freeze feedback buffer'],
  ['r', 'reset trails'],
  ['', ''],
  ['c / C', 'next / prev scene'],
  ['x / X', 'next / prev rig'],
  ['p / P', 'next / prev palette'],
  ['l / L', 'panel preset / auto-layout'],
  ['a', 'toggle all auto-scheduling'],
  ['', ''],
  ['w / W', '3D world on / next world'],
  ['y', 'ascii  off / ramp / nomu'],
  ['o', 'aspect  16:9 / 2.00 / 2.39'],
  ['u', 'registration marks'],
  ['g', 'text font mode'],
  ['', ''],
  ['1\u20139 / v', 'pick camera / next camera'],
  ['n', 'hold camera (stop auto-cycle)'],
  ['t / T', 'tap tempo / release to auto'],
  ['k', 'toggle strobe + invert flashes'],
  ['', ''],
  ['[ / ]', 'audio gain'],
  ['\u2190 / \u2192', 'exposure'],
  ['\u2191 / \u2193', 'waveform gain'],
  ['- / =', 'render scale (disables auto)'],
  ['', ''],
  ['j', 'glitch reactivity  0 / .5 / 1'],
  ['?', 'this help'],
];

// flat list of the single keys HELP claims to document, for the drift check
const HELP_KEYS = ['f','h','i','\\','r','c','C','x','X','p','P','l','L','a','w','W','y','o','u','g',
                   'v','n','t','T','k','j','?'];

function buildHelp() {
  const el = tag('help');
  if (!el) return;
  el.innerHTML = '<div class="hk-title">hotkeys</div>' + HELP.map(([k, d]) =>
    k ? `<div class="hk"><span class="hk-k">${k}</span><span class="hk-d">${d}</span></div>`
      : '<div class="hk-sp"></div>'
  ).join('');
}
buildHelp();

// cameras the user explicitly unticked. persisted so reconnecting a device
// doesn't silently put it back in rotation mid-set.
const camDisabledPersisted = new Set();

function saveSettings() {
  try {
    const disabled = [...camSeen].filter(id => !camEnabled.has(id));
    localStorage.setItem('nomu-vis', JSON.stringify({
      audioGain, waveGain, exposure, scaleIdx, autoScale, strobeEnabled, fontMode,
      settingsVersion: 2,
      autoCamCycle, camDisabled: disabled, letterboxIdx, marksEnabled, autoLayout,
    }));
  } catch (e) { /* private window / blocked storage — settings just don't persist */ }
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('nomu-vis') || '{}');
    if (typeof s.audioGain === 'number') audioGain = s.audioGain;
    if (typeof s.waveGain === 'number') waveGain = s.waveGain;
    if (typeof s.exposure === 'number') exposure = s.exposure;
    if (typeof s.scaleIdx === 'number') scaleIdx = Math.max(0, Math.min(SCALE_STEPS.length - 1, s.scaleIdx));
    if (typeof s.autoScale === 'boolean') autoScale = s.autoScale;
    if (typeof s.strobeEnabled === 'boolean') strobeEnabled = s.strobeEnabled;
    if (typeof s.fontMode === 'string') fontMode = s.fontMode;
    if (typeof s.autoCamCycle === 'boolean') autoCamCycle = s.autoCamCycle;
    if (Array.isArray(s.camDisabled)) s.camDisabled.forEach(id => camDisabledPersisted.add(id));
    // only honour a letterbox preference saved AFTER the aspect fix; anything
    // older was chosen against bars that never rendered
    if (s.settingsVersion === 2 && typeof s.letterboxIdx === 'number') {
      letterboxIdx = Math.max(0, Math.min(LETTERBOX_MODES.length - 1, s.letterboxIdx));
    }
    if (typeof s.marksEnabled === 'boolean') marksEnabled = s.marksEnabled;
    if (typeof s.autoLayout === 'boolean') autoLayout = s.autoLayout;
  } catch (e) { /* ignore */ }
}

function updateFxTags() {
  const t = tag('ascii-tag');
  if (t) t.textContent = asciiAmount > 0.01 ? (asciiMode === 0 ? 'ASCII' : 'NOMU') : '';
  const l = tag('layout-tag');
  if (l) l.textContent = layoutName + (worldEnabled ? ' +' + WORLD_MODES[worldMode] : '');
}

function refreshTags() {
  const set = (id, val) => { const t = tag(id); if (t) t.textContent = val; };
  set('gain-tag', audioGain.toFixed(2) + '×');
  set('wave-tag', waveGain.toFixed(2) + '×');
  set('exp-tag', exposure.toFixed(2) + '×');
  set('scale-tag', Math.round(SCALE_STEPS[scaleIdx] * 100) + '%');
  set('bpm-tag', beat.bpm.toFixed(0) + (tapLocked ? ' TAP' : ''));
  set('auto-tag', (autoScene && autoRig && autoPal && autoFx) ? 'AUTO' : 'MANUAL');
  set('layout-tag', layoutName + (worldEnabled ? ' +' + WORLD_MODES[worldMode] : ''));
  set('aspect-tag', LETTERBOX_MODES[letterboxIdx].name);
  set('strobe-tag', strobeEnabled ? '' : 'NO-STROBE');
}

window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'f') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  } else if (k === 'h') {
    // null-safe: a layer that has been removed from the markup must not throw
    // and kill the loop
    ['hud', 'text-overlay', 'code-lines', 'gif-layer', 'wave-canvas']
      .forEach(id => { const el = tag(id); if (el) el.classList.toggle('hidden'); });
  } else if (k === 'i') {
    // HUD only — the technical readouts go, the artwork stays. `h` strips
    // everything; this is the one you want on stage, where the band meters and
    // the corner dump are for you and nobody else.
    ['hud', 'code-readout'].forEach(id => {
      const el = tag(id);
      if (el) el.classList.toggle('hidden');
    });
  } else if (k === '\\') {
    blackout = !blackout;
    const t = tag('blackout-tag');
    if (t) t.textContent = blackout ? 'BLACKOUT' : '';
  } else if (k === 'r') {
    resetFeedback();
  } else if (k === 'c') {
    setScene(scene + 1);
  } else if (k === 'C') {
    setScene(scene - 1);
  } else if (k === 'x') {
    setRig(rigIdx + 1);
  } else if (k === 'X') {
    setRig(rigIdx - 1);
  } else if (k === 'p') {
    setPalette(palIdx + 1);
  } else if (k === 'P') {
    setPalette(palIdx - 1);
  } else if (k === 'a') {
    const on = !(autoScene && autoRig && autoPal && autoFx);
    autoScene = autoRig = autoPal = autoFx = on;
    fxHoldUntilBar = -1;   // `a` always hands control straight back
  } else if (k === 't') {
    tapTempo(performance.now());
  } else if (k === 'T') {
    tapLocked = false;
    taps.length = 0;
  } else if (k === 'k') {
    strobeEnabled = !strobeEnabled;
    if (!strobeEnabled) invertUntil = 0;
  } else if (k === 'g') {
    fontMode = FONT_MODES[(FONT_MODES.indexOf(fontMode) + 1) % FONT_MODES.length];
  } else if (k === '?' || k === '/') {
    tag('help').classList.toggle('hidden');
  } else if (k >= '1' && k <= '9') {
    setActiveCam(Number(k) - 1);
  } else if (k === 'v' || k === 'V') {
    setActiveCam(activeCam + 1);
  } else if (k === 'n') {
    autoCamCycle = !autoCamCycle;
    const t = tag('camauto-tag');
    if (t) t.textContent = autoCamCycle ? '' : 'CAM-HOLD';
    scheduleCamCycle();
  } else if (k === 'l') {
    setLayout(SCATTER[(scatterIdx + 1) % SCATTER.length].name);
  } else if (k === 'L') {
    autoLayout = !autoLayout;
  } else if (k === 'o') {
    letterboxIdx = (letterboxIdx + 1) % LETTERBOX_MODES.length;
    updateLetterbox();
    renderBigText(WORDS[wordIdx], FONTS[fontIdx]);   // safe box just changed
  } else if (k === 'w') {
    worldEnabled = !worldEnabled;
    holdFx();
    reconcileLayout();
    updateCamTag();
    updateFxTags();
  } else if (k === 'W') {
    worldMode = (worldMode + 1) % WORLD_MODES.length;
    if (!worldEnabled) { worldEnabled = true; reconcileLayout(); }
    holdFx();
    updateFxTags();
  } else if (k === 'y') {
    // off -> ascii ramp -> nomu text -> off
    if (asciiAmount < 0.01) { asciiAmount = 0.92; asciiMode = 0; }
    else if (asciiMode === 0) { asciiMode = 1; }
    else { asciiAmount = 0; asciiMode = 0; }
    holdFx();   // you drove it — the scheduler backs off for a while
    updateFxTags();
  } else if (k === 'j') {
    // A/B the whole idea: 0 is the old uniform glitch, 1 is fully content-driven
    reactivity = reactivity > 0.75 ? 0 : (reactivity > 0.25 ? 1.0 : 0.5);
    const t = tag('react-tag');
    if (t) t.textContent = 'RCT ' + reactivity.toFixed(1);
  } else if (k === 'u') {
    marksEnabled = !marksEnabled;
    if (!marksEnabled && marksCtx) {
      marksCtx.setTransform(marksDpr, 0, 0, marksDpr, 0, 0);
      marksCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  } else if (e.code === 'Space') {
    e.preventDefault();
    frozen = !frozen;
    const t = tag('freeze-tag');
    if (t) t.textContent = frozen ? 'FROZEN' : '';
  } else if (k === '[' || k === ']') {
    const step = e.shiftKey ? 0.5 : 0.1; // shift for coarse steps
    audioGain = Math.max(0.2, Math.min(5.0, audioGain + (k === ']' ? step : -step)));
  } else if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault(); // block page scroll
    const step = e.shiftKey ? 0.5 : 0.1;
    waveGain = Math.max(0.1, Math.min(8.0, waveGain + (k === 'ArrowUp' ? step : -step)));
  } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 0.3 : 0.08;
    exposure = Math.max(0.2, Math.min(2.5, exposure + (k === 'ArrowRight' ? step : -step)));
  } else if (k === '-' || k === '=' || k === '+') {
    autoScale = false;
    scaleIdx = Math.max(0, Math.min(SCALE_STEPS.length - 1, scaleIdx + (k === '-' ? -1 : 1)));
    applyScale();
  } else {
    return;
  }
  refreshTags();
  saveSettings();
});

// ---------- DOM layer phases ----------
// which overlay layers are live. re-picked on bar boundaries, and some phases
// are deliberately empty so the overlays aren't running all set.

// at most two layers at once, and a third of the phases are empty. the old
// set had an all-three phase and only one empty one, so the camera was buried
// under overlays most of the time.
const PHASES = [
  { gif: false, blot: false, nomu: false },
  { gif: false, blot: false, nomu: false },
  { gif: false, blot: false, nomu: false },
  { gif: true,  blot: false, nomu: false },
  { gif: true,  blot: false, nomu: false },
  { gif: false, blot: true,  nomu: false },
  { gif: false, blot: false, nomu: true  },
  { gif: false, blot: false, nomu: true  },
  { gif: true,  blot: false, nomu: true  },
  { gif: false, blot: true,  nomu: true  },
];
let gifsEnabled = true;
let blotchesEnabled = true;
let currentPhaseIdx = -1;

function pickLayerPhase() {
  let next;
  do { next = Math.floor(Math.random() * PHASES.length); }
  while (next === currentPhaseIdx && PHASES.length > 1);
  currentPhaseIdx = next;
  const p = PHASES[next];
  gifsEnabled = p.gif;
  blotchesEnabled = p.blot;
  // hidden via visibility so the DVD/glitch timers keep ticking underneath
  const bt = tag('big-text');
  if (bt) bt.style.visibility = p.nomu ? '' : 'hidden';
}

// ---------- cell marks + registration layer ----------
//
// the difference between "designed" and "a pile of effects" is mostly that
// everything sits on a grid and the marks look like they came off a print
// production sheet: hairlines, corner brackets, tick rules, small tracked
// labels. drawn on one canvas rather than as DOM so the hairlines land on
// exact device pixels and stay 1px at any DPR.

const marksCanvas = tag('marks-canvas');
const marksCtx = marksCanvas ? marksCanvas.getContext('2d') : null;
let marksDpr = 1;

function resizeMarks() {
  if (!marksCanvas) return;
  marksDpr = window.devicePixelRatio || 1;
  marksCanvas.width = Math.floor(window.innerWidth * marksDpr);
  marksCanvas.height = Math.floor(window.innerHeight * marksDpr);
}
resizeMarks();
window.addEventListener('resize', resizeMarks);

// snap to whole device pixels so a 1px rule is actually 1px, not a grey blur
const snap = (v) => Math.round(v * marksDpr) / marksDpr + 0.5 / marksDpr;

function bracket(ctx, x, y, w, h, len) {
  const c = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
  for (const [bx, by, sx, sy] of c) {
    ctx.beginPath();
    ctx.moveTo(snap(bx + sx * len), snap(by));
    ctx.lineTo(snap(bx), snap(by));
    ctx.lineTo(snap(bx), snap(by + sy * len));
    ctx.stroke();
  }
}

function drawCellMarks() {
  if (!marksCtx || !marksEnabled) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const ctx = marksCtx;
  ctx.setTransform(marksDpr, 0, 0, marksDpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const bar = letterbox * H;
  const top = bar;
  const bot = H - bar;

  ctx.lineWidth = 1 / marksDpr;
  ctx.strokeStyle = 'rgba(232, 238, 255, 0.30)';
  ctx.fillStyle = 'rgba(232, 238, 255, 0.55)';
  ctx.font = `500 9px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'top';

  // per-camera cell: corner brackets and a tracked index label
  for (const r of lastCellRects) {
    const y = Math.max(top, r.y);
    const h = Math.min(bot, r.y + r.h) - y;
    if (h <= 4) continue;
    const inset = 8;
    bracket(ctx, r.x + inset, y + inset, r.w - inset * 2, h - inset * 2,
            Math.min(18, r.w * 0.06));

    const id = String(r.cam + 1).padStart(2, '0');
    const kind = r.tagName || 'CAM';
    ctx.save();
    ctx.fillStyle = 'rgba(232, 238, 255, 0.70)';
    // letter-spacing isn't available on canvas everywhere, so track manually
    let tx = r.x + inset + 6;
    for (const ch of `${kind} ${id}`) {
      ctx.fillText(ch, tx, y + inset + 6);
      tx += ctx.measureText(ch).width + 1.4;
    }
    ctx.restore();
  }

  // outer safe-area brackets — the frame that makes the whole thing read as
  // a composed shot rather than a full-bleed webcam
  ctx.strokeStyle = 'rgba(232, 238, 255, 0.22)';
  bracket(ctx, 22, top + 22, W - 44, (bot - top) - 44, 26);

  // tick rule along the bottom safe line, marked every 8th
  ctx.strokeStyle = 'rgba(232, 238, 255, 0.18)';
  const ticks = 48;
  for (let i = 0; i <= ticks; i++) {
    const x = 22 + (i / ticks) * (W - 44);
    const len = (i % 8 === 0) ? 7 : 3;
    ctx.beginPath();
    ctx.moveTo(snap(x), snap(bot - 22));
    ctx.lineTo(snap(x), snap(bot - 22 - len));
    ctx.stroke();
  }

  // centre crosshair, only while the beat grid is actually locked
  if (beat.conf > 0.25) {
    const cx = W / 2;
    const cy = (top + bot) / 2;
    const s = 9;
    ctx.strokeStyle = `rgba(232, 238, 255, ${(0.10 + 0.22 * (1 - beat.phase)).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(snap(cx - s), snap(cy)); ctx.lineTo(snap(cx + s), snap(cy));
    ctx.moveTo(snap(cx), snap(cy - s)); ctx.lineTo(snap(cx), snap(cy + s));
    ctx.stroke();
  }
}

// ---------- floating gif tiles ----------

const GIF_FILES = [
  'gif_01_bridge_tunnel.gif',
  'gif_02.gif',
  'gif_03.gif',
  'gif_04_beach_aerial_1.gif',
  'gif_05_beach_aerial_2.gif',
  'gif_06_DSCF0106.gif',
  'gif_07_DSCF0113_1.gif',
  'gif_08_DSCF0113_2.gif',
  'gif_09_DSCF0133.gif',
  'gif_10_DSCF0136.gif',
];
// the middle of the frame is where the performer is. overlays pick a grid
// slot but reject any that sits mostly inside this rect, so the centre stays
// clear and the crowd and performer are always visible through the layers.
const SAFE = { x0: 0.26, x1: 0.74, y0: 0.18, y1: 0.86 };

// fraction of a 0..1 rect that falls inside the safe zone
function safeOverlap(x, y, w, h) {
  const ox = Math.max(0, Math.min(x + w, SAFE.x1) - Math.max(x, SAFE.x0));
  const oy = Math.max(0, Math.min(y + h, SAFE.y1) - Math.max(y, SAFE.y0));
  return (ox * oy) / Math.max(1e-6, w * h);
}

// pick a grid slot that mostly misses the centre. falls back to the least-bad
// option rather than looping forever on a crowded frame.
function pickEdgeSlot(cols, rows, spanX, spanY, maxOverlap) {
  let best = null;
  for (let i = 0; i < 12; i++) {
    const col = Math.floor(Math.random() * (cols - spanX + 1));
    const row = Math.floor(Math.random() * (rows - spanY + 1));
    const ov = safeOverlap(col / cols, row / rows, spanX / cols, spanY / rows);
    if (ov <= maxOverlap) return { col, row };
    if (!best || ov < best.ov) best = { col, row, ov };
  }
  return best;
}

const gifLayer = tag('gif-layer');
const activeGifs = [];
const MAX_GIFS = 2;

// warm the cache up front — these are multi-megabyte GIFs and decoding one
// mid-set for the first time drops frames
const gifPreload = GIF_FILES.map(f => {
  const im = new Image();
  im.src = 'nomu_gifs/' + f;
  return im;
});

function spawnGifTile(opts) {
  opts = opts || {};
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bar = letterbox * H;
  // snapped to the same 12x8 grid as everything else. free placement is what
  // made these read as scattered stickers rather than part of a composition.
  const cols = 12;
  const rows = 8;
  const cw = W / cols;
  const rh = (H - bar * 2) / rows;
  const spanX = 2 + Math.floor(Math.random() * 3);
  const spanY = 1 + Math.floor(Math.random() * 2);
  const slot = pickEdgeSlot(cols, rows, spanX, spanY, 0.25);
  const col = slot.col;
  const row = slot.row;

  const targetOp = 0.26 + Math.random() * 0.20;
  const lifespan = opts.lifespan ?? (1000 + Math.random() * 3000);
  const flicker = opts.flicker ?? true;

  const el = document.createElement('div');
  el.className = 'gif-tile';
  el.style.left = Math.round(col * cw) + 'px';
  el.style.top = Math.round(bar + row * rh) + 'px';
  el.style.width = Math.round(spanX * cw) + 'px';
  el.style.height = Math.round(spanY * rh) + 'px';
  el.style.opacity = targetOp.toFixed(2);

  const img = document.createElement('img');
  img.src = gifPreload[Math.floor(Math.random() * gifPreload.length)].src;
  img.decoding = 'async';
  el.appendChild(img);
  gifLayer.appendChild(el);

  const entry = { el, dead: false, targetOp, isFlash: !!opts.flash };
  activeGifs.push(entry);

  let flickerId = null;
  if (flicker) {
    flickerId = setInterval(() => {
      if (entry.dead) return;
      if (Math.random() < 0.12) {
        el.style.opacity = '0';
        setTimeout(() => {
          if (!entry.dead) el.style.opacity = entry.targetOp.toFixed(2);
        }, 40 + Math.random() * 80);
      }
    }, 180);
  }

  setTimeout(() => {
    entry.dead = true;
    if (flickerId) clearInterval(flickerId);
    el.remove();
    const idx = activeGifs.indexOf(entry);
    if (idx >= 0) activeGifs.splice(idx, 1);
  }, lifespan);
}

// burst = one held tile plus a couple of rapid flashes
function spawnGifBurst() {
  spawnGifTile();
  for (let i = 0; i < 1; i++) {
    setTimeout(() => {
      spawnGifTile({ lifespan: 60 + Math.random() * 140, flicker: false, flash: true });
    }, i * (25 + Math.random() * 60));
  }
}

function gifSpawnerTick() {
  if (!running) return;
  if (gifsEnabled) {
    const livingMain = activeGifs.filter(g => !g.dead && !g.isFlash).length;
    if (livingMain < 1 && Math.random() < 0.5) spawnGifBurst();
    else if (livingMain < MAX_GIFS && Math.random() < 0.15) spawnGifBurst();
  }
  setTimeout(gifSpawnerTick, 300 + Math.random() * 900);
}

// ---------- waveform — scrolling recording-style ----------

const waveCanvas = tag('wave-canvas');
const waveCtx = waveCanvas.getContext('2d');

// ring buffer of peak amplitudes — scrolls across the canvas over time
const WAVE_HISTORY_LEN = 500;
const waveHistory = new Float32Array(WAVE_HISTORY_LEN);
let waveHistoryIdx = 0;
let waveGain = 1.0;

function resizeWave() {
  // DPR uncapped here so the canvas stays sharp under browser zoom
  const dpr = window.devicePixelRatio || 1;
  const r = waveCanvas.getBoundingClientRect();
  waveCanvas.width = Math.max(1, Math.floor(r.width * dpr));
  waveCanvas.height = Math.max(1, Math.floor(r.height * dpr));
}
resizeWave();
window.addEventListener('resize', resizeWave);

// the waveform tracks the active palette instead of being permanently blue
function waveColors() {
  const c = palCur.bright;
  const to255 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  const rgb = `${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])}`;
  const m = palCur.mid;
  return {
    fill: `rgba(${to255(m[0] * 1.4)}, ${to255(m[1] * 1.4)}, ${to255(m[2] * 1.4)}, 0.38)`,
    line: `rgba(${rgb}, 0.95)`,
    glow: `rgba(${rgb}, 0.55)`,
  };
}

function drawWaveform() {
  if (!analyser || !waveData) return;
  analyser.getByteTimeDomainData(waveData);

  let peak = 0;
  for (let i = 0; i < waveData.length; i++) {
    const v = Math.abs(waveData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  waveHistory[waveHistoryIdx] = peak;
  waveHistoryIdx = (waveHistoryIdx + 1) % WAVE_HISTORY_LEN;

  const w = waveCanvas.width;
  const h = waveCanvas.height;
  waveCtx.clearRect(0, 0, w, h);

  const mid = h * 0.5;
  const amp = h * 0.45 * 1.2 * waveGain;
  const col = waveColors();

  // filled mirror body
  waveCtx.fillStyle = col.fill;
  waveCtx.beginPath();
  for (let i = 0; i < WAVE_HISTORY_LEN; i++) {
    const idx = (waveHistoryIdx + i) % WAVE_HISTORY_LEN;
    const x = (i / (WAVE_HISTORY_LEN - 1)) * w;
    const y = mid - waveHistory[idx] * amp;
    if (i === 0) waveCtx.moveTo(x, y);
    else waveCtx.lineTo(x, y);
  }
  for (let i = WAVE_HISTORY_LEN - 1; i >= 0; i--) {
    const idx = (waveHistoryIdx + i) % WAVE_HISTORY_LEN;
    const x = (i / (WAVE_HISTORY_LEN - 1)) * w;
    waveCtx.lineTo(x, mid + waveHistory[idx] * amp);
  }
  waveCtx.closePath();
  waveCtx.fill();

  // crisp outline top and bottom — reads as a shape, not fog
  waveCtx.lineWidth = 1.5;
  waveCtx.strokeStyle = col.line;
  waveCtx.shadowBlur = 8;
  waveCtx.shadowColor = col.glow;
  for (const sign of [-1, 1]) {
    waveCtx.beginPath();
    for (let i = 0; i < WAVE_HISTORY_LEN; i++) {
      const idx = (waveHistoryIdx + i) % WAVE_HISTORY_LEN;
      const x = (i / (WAVE_HISTORY_LEN - 1)) * w;
      const y = mid + sign * waveHistory[idx] * amp;
      if (i === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();
  }
  waveCtx.shadowBlur = 0;
}

// ---------- energy follower ----------
//
// this used to pick a value with Math.random() every 80-380ms, which is why
// the damage looked like slop: it was not correlated with anything, so no
// amount of tuning could make it feel like it was responding to the music.
//
// now it is a straight envelope on audio energy, quantized into tiers. the
// asymmetry matters — snap up on a hit, ease down after it, the way the ear
// reads a transient. the tiers keep it reading as deliberate steps rather than
// a continuously breathing mush.
//
// this is the GLOBAL half of the correlation. the per-region half comes from
// the control mask inside the shaders, so at any instant the frame holds a
// range of block sizes rather than one uniform size.

const CRUSH_TIERS = 6;
let crushIntensity = 0;
let crushSmooth = 0;

function updateCrushIntensity() {
  const trans = peakTransient();
  const level = Math.max(bands.bass, bands.mids * 0.85, bands.highs * 0.7);
  const energy = Math.min(1, level * 0.75 + trans * 2.2);
  const k = energy > crushSmooth ? 0.55 : 0.06;   // fast attack, slow release
  crushSmooth += (energy - crushSmooth) * k;
  crushIntensity = Math.round(crushSmooth * CRUSH_TIERS) / CRUSH_TIERS;
  updateTextFilter();
}

// the SVG posterize filter applied to the DOM overlays (text / code / HUD)
const fR = tag('fR');
const fG = tag('fG');
const fB = tag('fB');
function updateTextFilter() {
  if (!fR) return;
  // 3-8 discrete levels — higher intensity means fewer levels
  const levels = Math.max(3, Math.round(9 - 6 * crushIntensity));
  const table = Array.from({ length: levels }, (_, i) =>
    ((i + 0.5) / levels).toFixed(3)).join(' ');
  fR.setAttribute('tableValues', table);
  fG.setAttribute('tableValues', table);
  fB.setAttribute('tableValues', table);
}
updateTextFilter();

// the GIF layer's exposure boost is a live-updated SVG filter matrix
const gifBrightMatrix = tag('gif-bright-matrix');
// 1.0, not 1.1 — the ramp already lands where it should, and scaling it up
// only clips the top stop
const GIF_BRIGHT_BASE = 1.0;
function updateExposureFilters() {
  if (!gifBrightMatrix) return;
  const b = (GIF_BRIGHT_BASE * exposure).toFixed(3);
  gifBrightMatrix.setAttribute('values',
    `${b} 0 0 0 0  0 ${b} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
}

// ---------- big text ----------

const bigText = tag('big-text');
const codeReadout = tag('code-readout');

// the only word baked in is the artist name — add to this list to cycle others
const WORDS = ['nomu'];

// serious faces only. the old pool cycled through Comic Sans, Brush Script and
// Bradley Hand — novelty faces are the single loudest "made in a phone app"
// signal, and no amount of grading recovers from them. this set is one
// grotesque, one geometric, one high-contrast fashion serif, one editorial
// serif and one condensed poster face.
const FONTS = [
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Futura, "Avenir Next", "Century Gothic", sans-serif',
  'Didot, "Bodoni 72", "Playfair Display", serif',
  '"Times New Roman", Times, serif',
  'Impact, "Haettenschweiler", sans-serif',
];

// BEAT locks the font swap to the beat grid (reads as designed), STROBE is the
// old 80ms churn, HOLD keeps one face.
const FONT_MODES = ['BEAT', 'STROBE', 'HOLD'];
let fontMode = 'BEAT';
let fontIdx = 0;
let wordIdx = 0;
let nextStrobeFont = 0;

const bigTextCanvas = tag('big-text-canvas');
const bigTextCtx = bigTextCanvas.getContext('2d');
const bigTextOffscreen = document.createElement('canvas');

// how the name is set. PLATE and MARK are drawn crisp with real tracking;
// PIXEL is the chunky low-res version. constant chunky pixelation reads as a
// filter preset, so it is now one treatment among several rather than the
// only one.
const TREATMENTS = {
  MARK:  { size: 0.030, weight: 500, track: 0.62, pixel: 1, upper: false },
  PLATE: { size: 0.115, weight: 800, track: -0.02, pixel: 1, upper: false },
  WIDE:  { size: 0.048, weight: 300, track: 1.10, pixel: 1, upper: true },
  PIXEL: { size: 0.080, weight: 900, track: 0.02, pixel: 6, upper: false },
};
const TREATMENT_NAMES = Object.keys(TREATMENTS);
let treatment = 'PLATE';

// cached so the layout loop never reads offsetWidth and forces a reflow
let textW = 0;
let textH = 0;

// draw with manual letter-spacing — canvas letterSpacing is not universally
// supported, and tracking is most of what separates set type from default type
function drawTracked(ctx, text, x, y, trackPx) {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + trackPx;
  }
}

function measureTracked(ctx, text, trackPx) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + trackPx;
  return Math.max(1, w - trackPx);
}

// the safe box the name must fit inside: the frame minus the letterbox bars
// and the layout margin
function textSafeBox() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bar = letterbox * H;
  const m = Math.max(34, W * 0.035);
  return { m, bar, maxW: Math.max(40, W - m * 2), maxH: Math.max(30, (H - bar * 2) - m * 2) };
}

function renderBigText(rawText, fontFamily) {
  const t = TREATMENTS[treatment] || TREATMENTS.PLATE;
  const text = t.upper ? rawText.toUpperCase() : rawText;
  const scale = t.pixel;
  const box = textSafeBox();

  // shrink to fit. the WIDE treatment tracks at over a full em per character,
  // so on a narrow window or a hard letterbox the word can easily measure
  // wider than the frame — at which point the anchor maths goes negative and
  // pushes it off the edge. a couple of passes converge.
  let fontSize = Math.max(22, window.innerWidth * t.size);
  const octx = bigTextOffscreen.getContext('2d');
  for (let pass = 0; pass < 6; pass++) {
    octx.font = `${t.weight} ${fontSize}px ${fontFamily}`;
    const wpx = measureTracked(octx, text, fontSize * t.track) + 12;
    const hpx = fontSize * 1.25;
    if (wpx <= box.maxW && hpx <= box.maxH) break;
    fontSize = Math.max(14, fontSize * Math.min(box.maxW / wpx, box.maxH / hpx) * 0.98);
  }

  const trackPx = fontSize * t.track;
  octx.font = `${t.weight} ${fontSize}px ${fontFamily}`;
  textW = Math.ceil(measureTracked(octx, text, trackPx)) + 12;
  textH = Math.ceil(fontSize * 1.25);

  const offW = Math.max(4, Math.ceil(textW / scale));
  const offH = Math.max(4, Math.ceil(textH / scale));
  bigTextOffscreen.width = offW;
  bigTextOffscreen.height = offH;
  const o = bigTextOffscreen.getContext('2d');
  o.imageSmoothingEnabled = false;
  o.fillStyle = '#fff';
  o.font = `${t.weight} ${fontSize / scale}px ${fontFamily}`;
  o.textBaseline = 'middle';
  drawTracked(o, text, 6 / scale, offH / 2, trackPx / scale);

  bigTextCanvas.width = textW;
  bigTextCanvas.height = textH;
  bigTextCanvas.style.width = textW + 'px';
  bigTextCanvas.style.height = textH + 'px';
  bigTextCtx.imageSmoothingEnabled = scale === 1;
  bigTextCtx.clearRect(0, 0, textW, textH);
  bigTextCtx.drawImage(bigTextOffscreen, 0, 0, textW, textH);
}

function cycleFont() {
  fontIdx = (fontIdx + 1) % FONTS.length;
  renderBigText(WORDS[wordIdx], FONTS[fontIdx]);
}

renderBigText(WORDS[0], FONTS[0]);
window.addEventListener('resize', () => renderBigText(WORDS[wordIdx], FONTS[fontIdx]));

// the name is anchored to the layout grid and CUT between anchors on bar
// lines, rather than drifting around. a DVD-bounce is a meme; a hard cut to a
// new grid position on the downbeat is a design decision.
//
// anchors are [x, y] in 0..1 with the safe margin already applied.
const TEXT_ANCHORS = [
  [0.50, 0.50], // centre
  [0.00, 1.00], // lower left
  [1.00, 1.00], // lower right
  [0.00, 0.00], // upper left
  [0.50, 1.00], // bottom centre
];
let anchorIdx = 0;
let nextTextCutBar = 0;

function updateTextGlitch() {
  if (!bigText) return;
  const now = performance.now();

  if (fontMode === 'BEAT') {
    if (beat.onBeat) cycleFont();
  } else if (fontMode === 'STROBE') {
    if (now >= nextStrobeFont) {
      cycleFont();
      nextStrobeFont = now + 80;
    }
  }

  // cut to a new anchor + treatment every few bars
  if (beat.onBar && beat.barIndex >= nextTextCutBar) {
    anchorIdx = Math.floor(Math.random() * TEXT_ANCHORS.length);
    treatment = TREATMENT_NAMES[Math.floor(Math.random() * TREATMENT_NAMES.length)];
    renderBigText(WORDS[wordIdx], FONTS[fontIdx]);
    nextTextCutBar = beat.barIndex + pick([4, 4, 8, 8, 16]);
  }

  const W = window.innerWidth;
  const H = window.innerHeight;
  const { m, bar } = textSafeBox();
  const [ax, ay] = TEXT_ANCHORS[anchorIdx];
  // Math.max(0, ...) so an oversized word anchors at the margin instead of
  // being placed at a negative offset
  let x = m + ax * Math.max(0, W - 2 * m - textW);
  let y = (bar + m) + ay * Math.max(0, (H - 2 * bar) - 2 * m - textH);

  // restraint: mostly steady, with a short displacement on strong transients.
  // constant per-frame jitter reads as noise, not as an effect.
  const trans = peakTransient();
  let opacity = 0.82;
  let dx = 0, dy = 0;
  if (trans > 0.16) {
    opacity = 0.45 + Math.random() * 0.55;
    dx = (Math.random() - 0.5) * trans * 70;
  } else if (Math.random() < 0.02) {
    opacity = 0.0;   // occasional single-frame dropout
  }

  // hard clamp AFTER the transient kick — the displacement is what actually
  // pushed it off the edge, so clamping before it would not have helped
  x = Math.max(0, Math.min(Math.max(0, W - textW), x + dx));
  y = Math.max(bar, Math.min(Math.max(bar, H - bar - textH), y + dy));

  bigText.style.opacity = opacity.toFixed(2);
  bigText.style.left = '0px';
  bigText.style.top = '0px';
  bigText.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

const hex = (n, p = 4) =>
  Math.floor(Math.abs(n)).toString(16).padStart(p, '0').toUpperCase();

// ---------- code blotches (patches of rapidly mutating text) ----------

const codeLinesEl = tag('code-lines');
// mostly hex and numerals with a little punctuation. the old pool was 28 parts
// '+' to everything else, which scattered plus-signs over the frame like
// confetti — dense uniform-width data reads as a considered texture, random
// symbols read as a sticker pack.
const CODE_CHARS =
  '0123456789ABCDEF'.repeat(6) +
  '0123456789'.repeat(3) +
  '.:/\\|-_=[]<>';

// fewer, larger, grid-aligned blocks instead of many small scattered ones
const MAX_BLOTCHES = 2;
const MIN_BLOTCHES = 0;
const blotches = [];

const randCodeChar = () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
function randCodeText(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += randCodeChar();
  return s;
}

function spawnBlotch() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bar = letterbox * H;
  // one type size, snapped to the same 12x8 grid the clips use. varying the
  // size per block was what made these look like scattered junk.
  const fontSize = 12;
  const cols = 12;
  const rows = 8;
  const cw = W / cols;
  const rh = (H - bar * 2) / rows;
  const spanX = 2 + Math.floor(Math.random() * 3);
  const spanY = 1 + Math.floor(Math.random() * 2);
  const slot = pickEdgeSlot(cols, rows, spanX, spanY, 0.15);
  const col = slot.col;
  const row = slot.row;

  const width = Math.round(spanX * cw);
  const height = Math.round(spanY * rh);
  const x = Math.round(col * cw);
  const y = Math.round(bar + row * rh);
  const lineCount = Math.max(1, Math.floor(height / (fontSize * 1.15)));
  const targetOp = 0.14 + Math.random() * 0.16;
  const lineChars = Math.max(4, Math.floor(width / (fontSize * 0.62)));

  const el = document.createElement('div');
  el.className = 'blotch';
  el.style.left = x.toFixed(0) + 'px';
  el.style.top = y.toFixed(0) + 'px';
  el.style.width = width.toFixed(0) + 'px';
  el.style.fontSize = fontSize.toFixed(1) + 'px';
  el.style.opacity = '0';

  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const ln = document.createElement('div');
    ln.className = 'blotch-line';
    ln.textContent = randCodeText(lineChars);
    el.appendChild(ln);
    lines.push({ el: ln, nextUpdate: 0, baseInterval: 40 + Math.random() * 120 });
  }
  codeLinesEl.appendChild(el);

  const entry = { el, lines, lineChars, fadingOut: false, targetOp };
  blotches.push(entry);
  requestAnimationFrame(() => { el.style.opacity = targetOp.toFixed(2); });

  setTimeout(() => {
    entry.fadingOut = true;
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      const idx = blotches.indexOf(entry);
      if (idx >= 0) blotches.splice(idx, 1);
    }, 350);
  }, 800 + Math.random() * 3500);
}

function blotchSpawnerTick() {
  if (!running) return;
  if (blotchesEnabled) {
    const activeCount = blotches.filter(b => !b.fadingOut).length;
    if (activeCount < MAX_BLOTCHES && Math.random() < 0.18) spawnBlotch();
  }
  setTimeout(blotchSpawnerTick, 120 + Math.random() * 300);
}

function updateCodeLines() {
  if (blotches.length === 0) return;
  const now = performance.now();
  const mult = 1 / (1 + peakTransient() * 4);
  for (const b of blotches) {
    if (b.fadingOut) continue;
    for (const l of b.lines) {
      if (now >= l.nextUpdate) {
        l.el.textContent = randCodeText(b.lineChars);
        l.nextUpdate = now + l.baseInterval * mult;
      }
    }
  }
}

// ---------- corner readout ----------

let readoutTimer = null;
function startOverlayTimers() {
  gifSpawnerTick();
  blotchSpawnerTick();
  pickLayerPhase();
  if (readoutTimer) clearInterval(readoutTimer);
  readoutTimer = setInterval(() => {
    if (!running) return;
    const time = new Date().toISOString().slice(11, 19);
    const sig = (-50 + bands.bass * 40 + Math.random() * 6).toFixed(1);
    codeReadout.textContent = [
      `CAM_0${activeCam + 1}  ::  REC  ${time}`,
      `LUM  ${bands.bass.toFixed(3)}  ${bands.mids.toFixed(3)}  ${bands.highs.toFixed(3)}`,
      `BPM ${beat.bpm.toFixed(1)}  CONF ${beat.conf.toFixed(2)}  BAR ${beat.barIndex}`,
      `${RIGS[rigIdx].name} / ${PALETTES[palIdx].name} / ${SCENE_NAMES[scene]}`,
      `GAIN ${audioGain.toFixed(2)}x  FRM ${frameCount}`,
      `0x${hex(Math.random() * 0xFFFFFF, 6)}   0x${hex(frameCount * 7919, 6)}`,
      `SIG ${sig} dB`,
    ].join('\n');
  }, 100);
}

// ---------- boot ----------

loadSettings();
updateLetterbox();
renderScale = SCALE_STEPS[scaleIdx];
updateExposureFilters();
updateOverlayPalette();
refreshTags();
setScene(0);
setRig(0);
setPalette(0);
listDevices();
