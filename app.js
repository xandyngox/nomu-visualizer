// visualizer — live audio-reactive webcam, WebGL effects, DOM overlays

const canvas = document.getElementById('gl');
const ui = document.getElementById('ui');
const err = document.getElementById('err');
const camSelect = document.getElementById('cam');
const audSelect = document.getElementById('aud');
const startBtn = document.getElementById('start');

const barEls = {
  bass: document.getElementById('b-bass'),
  mids: document.getElementById('b-mids'),
  highs: document.getElementById('b-highs'),
};

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

// ---------- shaders ----------

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// feedback pass: webcam (aspect-corrected + mirrored) combined with decaying
// previous frame. Everything downstream reads from this FBO in canonical UVs.
const FS_FEEDBACK = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_webcam;
uniform sampler2D u_prev;
uniform vec2 u_canvas;
uniform vec2 u_video;
uniform float u_decay;
uniform float u_stretch;
uniform float u_zoom;
uniform int u_scene;        // 0 mirror, 1 flip, 2 kaleido-h, 3 kaleido-v,
                            // 4 quad, 5 grid-4, 6 grid-9

// apply composition transform after aspect-fit; stretch is applied after this
vec2 applyScene(vec2 uv, int s) {
  if (s == 0) return vec2(1.0 - uv.x, uv.y);                              // mirror
  if (s == 1) return uv;                                                  // flip (no mirror)
  if (s == 2) return vec2(abs(uv.x - 0.5) * 2.0, uv.y);                   // kaleido-h
  if (s == 3) return vec2(1.0 - uv.x, abs(uv.y - 0.5) * 2.0);             // kaleido-v
  if (s == 4) return vec2(abs(uv.x - 0.5) * 2.0, abs(uv.y - 0.5) * 2.0);  // quad
  if (s == 5) return fract(vec2(1.0 - uv.x, uv.y) * 2.0);                 // grid-4
  if (s == 6) return fract(vec2(1.0 - uv.x, uv.y) * 3.0);                 // grid-9
  return vec2(1.0 - uv.x, uv.y);
}

void main() {
  float ca = u_canvas.x / u_canvas.y;
  float va = u_video.x  / u_video.y;
  vec2 wuv = v_uv;
  // cover-fit so the webcam fills the canvas
  if (ca > va) {
    float s = va / ca; wuv.y = (wuv.y - 0.5) * s + 0.5;
  } else {
    float s = ca / va; wuv.x = (wuv.x - 0.5) * s + 0.5;
  }
  // composition (mirror / kaleido / tile / etc)
  wuv = applyScene(wuv, u_scene);
  // vertical stretch applied after — each tile stretches in grid modes
  wuv.y = (wuv.y - 0.5) / u_stretch + 0.5;

  // slow outward zoom on prev — trails drift away from center each frame
  vec2 puv = (v_uv - 0.5) * u_zoom + 0.5;

  vec3 webcam = texture2D(u_webcam, wuv).rgb;
  vec3 prev   = texture2D(u_prev,   puv).rgb;

  vec3 color = max(webcam, prev * u_decay);
  gl_FragColor = vec4(color, 1.0);
}
`;

// luminance silhouette — hard threshold, blow-out white flash where lum>threshold.
// because this pass happens inside the feedback loop, flashes leave burning trails.
const FS_SILHOUETTE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_thresh;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float sil = step(u_thresh, lum);
  // flash color slightly warm-white — reads better through trail decay than pure #fff
  vec3 flash = vec3(1.0, 0.98, 0.94);
  gl_FragColor = vec4(mix(c, flash, sil), 1.0);
}
`;

// RGB channel offset. classic CCTV misalignment — R left, B right, G fixed.
// subtle at rest, massive on bass drops.
const FS_RGB = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_offset;
void main() {
  float o = u_offset;
  float r = texture2D(u_tex, v_uv + vec2(-o, 0.0)).r;
  float g = texture2D(u_tex, v_uv).g;
  float b = texture2D(u_tex, v_uv + vec2( o, 0.0)).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

// horizontal pixel sort — for each pixel, walk left up to MAX_N pixels and
// carry forward the brightest pixel seen. approximates the glitch-art sort
// look without actual sorting. strength == 0 means no-op (early returns via
// the dynamic loop bound), so cost is low on quiet frames.
const FS_SORT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_strength;   // 0..1
uniform vec2 u_res;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float bright = dot(c, vec3(0.333));
  vec3 acc = c;

  const int MAX_N = 64;
  int N = int(u_strength * float(MAX_N));
  for (int i = 1; i <= MAX_N; i++) {
    if (i > N) break;
    vec2 uv = v_uv - vec2(float(i) / u_res.x, 0.0);
    vec3 s = texture2D(u_tex, uv).rgb;
    float sl = dot(s, vec3(0.333));
    if (sl > bright) {
      acc = s;
      bright = sl;
    }
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;

// chromatic aberration with radial falloff. R samples outward from center,
// B inward, G stays. quadratic falloff so center is clean and corners tear.
// fed through palette afterwards → reads as blue luma smear at edges, not
// colored fringes (we killed color on purpose earlier).
const FS_ABERR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_strength;
void main() {
  vec2 dir = v_uv - vec2(0.5);
  float dist = length(dir);
  // dist is 0 at center, ~0.707 at corners. square it for strong corner bias.
  float amount = u_strength * dist * dist * 2.0;
  vec2 off = dir * amount;

  float r = texture2D(u_tex, v_uv + off).r;
  float g = texture2D(u_tex, v_uv      ).g;
  float b = texture2D(u_tex, v_uv - off).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

// palette: collapse to luma (max of channels preserves RGB-offset ghost as a
// smear), map through a blue gradient, and handle strobe. draingang palette.
const FS_PALETTE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_strobe;  // 0 normal, 1 flash-white
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  // max-of-channels so the RGB-offset displaced samples show up as a luma ghost
  float lum = max(c.r, max(c.g, c.b));

  // 3-stop blue gradient: deep navy → pure blue → pale icy blue
  // green components kept low so midtones don't drift toward teal
  vec3 dark   = vec3(0.02, 0.03, 0.10);
  vec3 mid    = vec3(0.08, 0.15, 0.88);
  vec3 bright = vec3(0.88, 0.90, 1.00);
  vec3 color = (lum < 0.5)
    ? mix(dark, mid, lum * 2.0)
    : mix(mid,  bright, (lum - 0.5) * 2.0);

  // strobe: full white flash this frame (driver alternates on/off per frame)
  color = mix(color, vec3(1.0), u_strobe);

  gl_FragColor = vec4(color, 1.0);
}
`;

// final VHS/tape pass: pixel-crush, bit-depth quantize, scanlines, per-pixel
// grain, and a brightness multiplier driven from JS so we can oscillate it.
const FS_VHS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_pixelSize;
uniform float u_crushLevels;
uniform float u_grain;
uniform float u_scanline;
uniform float u_brightness;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // pixel crush — snap to block grid
  vec2 pUV = floor(v_uv * u_res / u_pixelSize) * u_pixelSize / u_res;
  vec3 c = texture2D(u_tex, pUV).rgb;

  // bit-depth crush
  c = floor(c * u_crushLevels + 0.5) / u_crushLevels;

  // scanlines — every other pixel row slightly darker
  float line = mod(floor(v_uv.y * u_res.y), 2.0);
  c *= 1.0 - u_scanline * line;

  // brightness (oscillated in JS)
  c *= u_brightness;

  // grain
  float n = hash(v_uv * u_res + u_time * 7.0);
  c += (n - 0.5) * u_grain;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// copy webcam (aspect-corrected + mirrored) to a small FBO for motion detection
const FS_WEBCAM_COPY = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_webcam;
uniform vec2 u_canvas;
uniform vec2 u_video;
void main() {
  float ca = u_canvas.x / u_canvas.y;
  float va = u_video.x  / u_video.y;
  vec2 uv = v_uv;
  if (ca > va) { float s = va/ca; uv.y = (uv.y-0.5)*s+0.5; }
  else         { float s = ca/va; uv.x = (uv.x-0.5)*s+0.5; }
  uv.x = 1.0 - uv.x;
  gl_FragColor = vec4(texture2D(u_webcam, uv).rgb, 1.0);
}
`;

// motion overlay: frame-diff between curr/prev small-buffer webcam frames.
// cells with motion above threshold get a bright square outline drawn on top
// of the blue output. grid == motion buffer resolution for 1:1 sampling.
const FS_MOTION = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_curr;
uniform sampler2D u_prev;
uniform vec2 u_grid;
uniform float u_thresh;
void main() {
  vec3 base = texture2D(u_tex, v_uv).rgb;
  vec2 cellUV = (floor(v_uv * u_grid) + 0.5) / u_grid;
  float a = dot(texture2D(u_curr, cellUV).rgb, vec3(0.3333));
  float b = dot(texture2D(u_prev, cellUV).rgb, vec3(0.3333));
  float active = step(u_thresh, abs(a - b));

  vec2 local = fract(v_uv * u_grid);
  float d = min(min(local.x, local.y), min(1.0 - local.x, 1.0 - local.y));
  float isBorder = 1.0 - step(0.06, d); // ~6% of cell is border

  vec3 line = vec3(0.95, 0.98, 1.0);
  gl_FragColor = vec4(mix(base, line, active * isBorder), 1.0);
}
`;

// final blit: FBO -> screen, identity sample
const FS_BLIT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

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

function program(vsSrc, fsSrc) {
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const progFeedback = program(VS, FS_FEEDBACK);
const uFb = {
  webcam:  gl.getUniformLocation(progFeedback, 'u_webcam'),
  prev:    gl.getUniformLocation(progFeedback, 'u_prev'),
  canvas:  gl.getUniformLocation(progFeedback, 'u_canvas'),
  video:   gl.getUniformLocation(progFeedback, 'u_video'),
  decay:   gl.getUniformLocation(progFeedback, 'u_decay'),
  stretch: gl.getUniformLocation(progFeedback, 'u_stretch'),
  zoom:    gl.getUniformLocation(progFeedback, 'u_zoom'),
  scene:   gl.getUniformLocation(progFeedback, 'u_scene'),
};

const progSilhouette = program(VS, FS_SILHOUETTE);
const uSilh = {
  tex:    gl.getUniformLocation(progSilhouette, 'u_tex'),
  thresh: gl.getUniformLocation(progSilhouette, 'u_thresh'),
};

const progRGB = program(VS, FS_RGB);
const uRGB = {
  tex:    gl.getUniformLocation(progRGB, 'u_tex'),
  offset: gl.getUniformLocation(progRGB, 'u_offset'),
};

const progSort = program(VS, FS_SORT);
const uSort = {
  tex:      gl.getUniformLocation(progSort, 'u_tex'),
  strength: gl.getUniformLocation(progSort, 'u_strength'),
  res:      gl.getUniformLocation(progSort, 'u_res'),
};

const progAberr = program(VS, FS_ABERR);
const uAberr = {
  tex:      gl.getUniformLocation(progAberr, 'u_tex'),
  strength: gl.getUniformLocation(progAberr, 'u_strength'),
};

const progPalette = program(VS, FS_PALETTE);
const uPal = {
  tex:    gl.getUniformLocation(progPalette, 'u_tex'),
  strobe: gl.getUniformLocation(progPalette, 'u_strobe'),
};

const progWcopy = program(VS, FS_WEBCAM_COPY);
const uWcopy = {
  webcam: gl.getUniformLocation(progWcopy, 'u_webcam'),
  canvas: gl.getUniformLocation(progWcopy, 'u_canvas'),
  video:  gl.getUniformLocation(progWcopy, 'u_video'),
};

const progMotion = program(VS, FS_MOTION);
const uMotion = {
  tex:    gl.getUniformLocation(progMotion, 'u_tex'),
  curr:   gl.getUniformLocation(progMotion, 'u_curr'),
  prev:   gl.getUniformLocation(progMotion, 'u_prev'),
  grid:   gl.getUniformLocation(progMotion, 'u_grid'),
  thresh: gl.getUniformLocation(progMotion, 'u_thresh'),
};

const progVHS = program(VS, FS_VHS);
const uVHS = {
  tex:         gl.getUniformLocation(progVHS, 'u_tex'),
  res:         gl.getUniformLocation(progVHS, 'u_res'),
  pixelSize:   gl.getUniformLocation(progVHS, 'u_pixelSize'),
  crushLevels: gl.getUniformLocation(progVHS, 'u_crushLevels'),
  grain:       gl.getUniformLocation(progVHS, 'u_grain'),
  scanline:    gl.getUniformLocation(progVHS, 'u_scanline'),
  brightness:  gl.getUniformLocation(progVHS, 'u_brightness'),
  time:        gl.getUniformLocation(progVHS, 'u_time'),
};

const progBlit = program(VS, FS_BLIT);
const uBlitTex = gl.getUniformLocation(progBlit, 'u_tex');

// fullscreen triangle
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1,  3, -1,  -1, 3,
]), gl.STATIC_DRAW);

// ---------- video texture ----------

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

const videoTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, videoTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
// seed with 1x1 black so sampling is valid before first frame arrives
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
              new Uint8Array([0, 0, 0]));

// ---------- FBO ping-pong ----------

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

// feedback ping-pong (only the feedback pass reads/writes here — effects can't
// contaminate the trail buffer)
let feedA = null;
let feedB = null;
// effects ping-pong (each effect: read fxA, write fxB, swap)
let fxA = null;
let fxB = null;
// motion-detection ping-pong — tiny FBOs with downsampled aspect-corrected
// webcam; frame-diff drives the grid overlay.
const MOTION_W = 64;
const MOTION_H = 36;
let motionCurr = null;
let motionPrev = null;
let fboW = 0;
let fboH = 0;

function destroyFBO(f) {
  if (!f) return;
  gl.deleteTexture(f.tex);
  gl.deleteFramebuffer(f.fbo);
}

function ensureFBOs() {
  // match canvas aspect, cap at 1920x1080 for perf headroom
  let w = canvas.width;
  let h = canvas.height;
  if (w > MAX_W || h > MAX_H) {
    const scale = Math.min(MAX_W / w, MAX_H / h);
    w = Math.max(2, Math.floor(w * scale));
    h = Math.max(2, Math.floor(h * scale));
  }
  if (feedA && fboW === w && fboH === h) return;
  destroyFBO(feedA); destroyFBO(feedB);
  destroyFBO(fxA);   destroyFBO(fxB);
  feedA = createFBO(w, h);
  feedB = createFBO(w, h);
  fxA   = createFBO(w, h);
  fxB   = createFBO(w, h);
  clearFBO(feedA); clearFBO(feedB);
  clearFBO(fxA);   clearFBO(fxB);
  if (!motionCurr) {
    motionCurr = createFBO(MOTION_W, MOTION_H);
    motionPrev = createFBO(MOTION_W, MOTION_H);
    clearFBO(motionCurr); clearFBO(motionPrev);
  }
  fboW = w;
  fboH = h;
}

// ---------- sizing ----------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ensureFBOs();
}
window.addEventListener('resize', resize);
resize();

// ---------- camera enumeration ----------

async function listDevices() {
  // prompt once for both kinds so labels are populated
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {
    err.textContent = 'permission denied for camera/mic';
    return;
  }
  const devs = await navigator.mediaDevices.enumerateDevices();
  camSelect.innerHTML = '';
  audSelect.innerHTML = '';
  devs.filter(d => d.kind === 'videoinput').forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `camera ${i + 1}`;
    camSelect.appendChild(opt);
  });
  devs.filter(d => d.kind === 'audioinput').forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `audio ${i + 1}`;
    audSelect.appendChild(opt);
  });
}

// ---------- audio ----------

let audioCtx = null;
let analyser = null;
let freqData = null;
let waveData = null;
let bandRanges = null;
const bands = { bass: 0, mids: 0, highs: 0 };
// transient = positive delta above the expected decay curve — fires on drum hits
const transients = { bass: 0, mids: 0, highs: 0 };
const BAND_DECAY = 0.90;      // band peak-follower release
const TRANSIENT_DECAY = 0.80; // faster release — transients should be short pulses

// audio input gain — tuned via [ / ] during soundcheck so band bars peak
// around 0.7–0.9 on the loud moments. feeds into bands, transients, strobe.
let audioGain = 1.0;
const gainTag = document.getElementById('gain-tag');

async function setupAudio(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // line-in must bypass Chrome's processing or dynamics get crushed
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
  analyser.smoothingTimeConstant = 0; // we do our own peak-follower
  src.connect(analyser);
  // no connect to destination — avoid feedback through speakers
  freqData = new Uint8Array(analyser.frequencyBinCount);
  waveData = new Uint8Array(analyser.fftSize);

  const nyquist = audioCtx.sampleRate / 2;
  const bin = (hz) => {
    const n = analyser.frequencyBinCount;
    const i = Math.round((hz / nyquist) * n);
    return Math.max(0, Math.min(n - 1, i));
  };
  bandRanges = {
    bass:  [bin(20),   bin(200)],
    mids:  [bin(200),  bin(2000)],
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
    // transient before updating smoothed value: only captures upward spikes
    const expected = bands[k] * BAND_DECAY;
    const flux = Math.max(0, raw - expected);
    transients[k] = Math.max(flux, transients[k] * TRANSIENT_DECAY);
    // clamp to 1.0 — prevents feedback decay exceeding 1.0 which would diverge
    bands[k] = Math.min(1.0, Math.max(raw, expected));
  }
  barEls.bass.style.width  = (bands.bass  * 100).toFixed(1) + '%';
  barEls.mids.style.width  = (bands.mids  * 100).toFixed(1) + '%';
  barEls.highs.style.width = (bands.highs * 100).toFixed(1) + '%';
}

// ---------- start ----------

let running = false;

async function start() {
  err.textContent = '';
  const camId = camSelect.value;
  const audId = audSelect.value;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: camId ? { exact: camId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (e) {
    err.textContent = 'camera error: ' + e.message;
    return;
  }
  video.srcObject = stream;
  await video.play();

  try {
    await setupAudio(audId);
  } catch (e) {
    err.textContent = 'audio error: ' + e.message;
    // keep going — webcam still renders
  }

  ui.classList.add('hidden');
  running = true;
  requestAnimationFrame(loop);
}

startBtn.addEventListener('click', start);

// ---------- render loop ----------

let frozen = false;
let frameCount = 0;
const freezeTag = document.getElementById('freeze-tag');

// composition scenes — auto-cycles every SCENE_INTERVAL ms; `c` advances manually
const SCENE_NAMES = ['MIRROR', 'FLIP', 'KALEIDO-H', 'KALEIDO-V', 'QUAD', 'GRID-4', 'GRID-9'];
const SCENE_INTERVAL = 5000;
let scene = 0;
const sceneTag = document.getElementById('scene-tag');
function setScene(i) {
  scene = ((i % SCENE_NAMES.length) + SCENE_NAMES.length) % SCENE_NAMES.length;
  if (sceneTag) sceneTag.textContent = SCENE_NAMES[scene];
}
setInterval(() => setScene(scene + 1), SCENE_INTERVAL);

function bindQuad() {
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  resize();
  updateBands();
  updateCrushIntensity();
  updatePhase();
  updateTextGlitch();
  updateCodeLines();
  updateGrainPos();
  drawWaveform();

  // upload the current video frame into the texture
  if (video.readyState >= video.HAVE_CURRENT_DATA) {
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  }

  bindQuad();

  // --- feedback pass: webcam + feedA (prev) -> feedB (curr). Loops on itself.
  if (!frozen) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, feedB.fbo);
    gl.viewport(0, 0, fboW, fboH);
    gl.useProgram(progFeedback);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.uniform1i(uFb.webcam, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, feedA.tex);
    gl.uniform1i(uFb.prev, 1);
    gl.uniform2f(uFb.canvas, fboW, fboH);
    gl.uniform2f(uFb.video, video.videoWidth || 1, video.videoHeight || 1);
    const decay = 0.94 + 0.055 * bands.mids;
    gl.uniform1f(uFb.decay, decay);
    gl.uniform1f(uFb.stretch, 1.4 + 0.3 * bands.bass);
    gl.uniform1f(uFb.zoom, 0.99);
    gl.uniform1i(uFb.scene, scene);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const t = feedA; feedA = feedB; feedB = t;
  }

  // === effects chain starts here. first effect reads feedA; subsequent read fxA.

  // --- silhouette pass: feedA -> fxB, swap. Threshold pulses low on bass.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progSilhouette);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, feedA.tex);
  gl.uniform1i(uSilh.tex, 0);
  gl.uniform1f(uSilh.thresh, 0.70 - 0.40 * bands.bass);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // --- RGB channel offset: fxA -> fxB, swap. Bass drives the spread.
  // later collapsed by palette pass — the three displaced samples become a
  // luma smear rather than colored fringes.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progRGB);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uRGB.tex, 0);
  gl.uniform1f(uRGB.offset, 0.002 + 0.025 * bands.bass);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // --- pixel sort: fxA -> fxB, swap. Fires on transients (drum hits).
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progSort);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uSort.tex, 0);
  gl.uniform2f(uSort.res, fboW, fboH);
  // use loudest transient across bands; amplify so typical drum hit maxes out
  const transient = Math.max(transients.bass, transients.mids, transients.highs);
  gl.uniform1f(uSort.strength, Math.min(1.0, transient * 3.0));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // --- chromatic aberration: fxA -> fxB, swap. Radial falloff, always on.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progAberr);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uAberr.tex, 0);
  // ~30px at corners baseline, pushes to ~55px on mids peaks
  gl.uniform1f(uAberr.strength, 0.015 + 0.012 * bands.mids);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // --- palette pass: luma → blue gradient + strobe on loud peaks
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progPalette);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uPal.tex, 0);
  // strobe gate: loudest band above threshold → alternate full-white per frame
  const level = Math.max(bands.bass, bands.mids, bands.highs);
  const strobe = (level > 0.80 && (frameCount & 1) === 0) ? 1.0 : 0.0;
  gl.uniform1f(uPal.strobe, strobe);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  frameCount++;

  // --- copy webcam to motionCurr (small buffer, aspect-corrected + mirrored)
  gl.bindFramebuffer(gl.FRAMEBUFFER, motionCurr.fbo);
  gl.viewport(0, 0, motionCurr.w, motionCurr.h);
  gl.useProgram(progWcopy);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.uniform1i(uWcopy.webcam, 0);
  gl.uniform2f(uWcopy.canvas, motionCurr.w, motionCurr.h);
  gl.uniform2f(uWcopy.video, video.videoWidth || 1, video.videoHeight || 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- motion overlay: fxA + motionCurr + motionPrev -> fxB
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progMotion);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uMotion.tex, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, motionCurr.tex);
  gl.uniform1i(uMotion.curr, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, motionPrev.tex);
  gl.uniform1i(uMotion.prev, 2);
  gl.uniform2f(uMotion.grid, MOTION_W, MOTION_H);
  gl.uniform1f(uMotion.thresh, 0.06);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // swap motion pair so next frame's curr becomes this frame's prev
  { const t = motionCurr; motionCurr = motionPrev; motionPrev = t; }

  // --- VHS final: pixel crush, bit quantize, scanlines, grain, brightness osc
  gl.bindFramebuffer(gl.FRAMEBUFFER, fxB.fbo);
  gl.viewport(0, 0, fboW, fboH);
  gl.useProgram(progVHS);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uVHS.tex, 0);
  gl.uniform2f(uVHS.res, fboW, fboH);
  // drive crush/grain/scanline from the choppy crushIntensity (0.30..1.00)
  const i = crushIntensity;
  // integer pixel block size so blocks look clean (2..9)
  gl.uniform1f(uVHS.pixelSize, Math.round(2 + 7 * i));
  // crush levels jump between 36 (gentle) and 6 (very posterized)
  gl.uniform1f(uVHS.crushLevels, Math.max(6, Math.round(42 - 36 * i)));
  gl.uniform1f(uVHS.grain, 0.04 + 0.22 * i);
  gl.uniform1f(uVHS.scanline, 0.04 + 0.10 * i);
  const tSec = performance.now() / 1000;
  // base is dim normal; bass TRANSIENTS punch it to blown-out white on kicks.
  // small sine drift so quiet sections still breathe.
  const brightness =
    0.70
    + 0.04 * Math.sin(tSec * 0.55)
    + transients.bass * 4.0
    + (Math.random() - 0.5) * 0.03;
  gl.uniform1f(uVHS.brightness, brightness);
  gl.uniform1f(uVHS.time, tSec);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  { const t = fxA; fxA = fxB; fxB = t; }

  // --- final blit: fxA (latest effects output) -> screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(progBlit);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fxA.tex);
  gl.uniform1i(uBlitTex, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function resetFeedback() {
  if (!feedA) return;
  clearFBO(feedA);
  clearFBO(feedB);
}

// ---------- hotkeys (partial — full set comes in stage 4) ----------

window.addEventListener('keydown', (e) => {
  if (e.key === 'f') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  if (e.key === 'h') {
    document.getElementById('hud').classList.toggle('hidden');
    document.getElementById('text-overlay').classList.toggle('hidden');
    document.getElementById('code-lines').classList.toggle('hidden');
    document.getElementById('grain-overlay').classList.toggle('hidden');
    document.getElementById('gif-layer').classList.toggle('hidden');
    document.getElementById('wave-canvas').classList.toggle('hidden');
  }
  if (e.key === 'r') {
    resetFeedback();
  }
  if (e.key === 'c') {
    setScene(scene + 1);
  }
  if (e.code === 'Space') {
    e.preventDefault();
    frozen = !frozen;
    if (freezeTag) freezeTag.textContent = frozen ? 'FROZEN' : '';
  }
  if (e.key === '[' || e.key === ']') {
    const step = e.shiftKey ? 0.5 : 0.1; // shift for coarse steps
    audioGain += (e.key === ']' ? step : -step);
    audioGain = Math.max(0.2, Math.min(5.0, audioGain));
    if (gainTag) gainTag.textContent = audioGain.toFixed(2) + '×';
  }
});

listDevices();

// ---------- layer phase scheduler ----------
// orchestrates which DOM layers are active. changes every 2–7s so overlays
// aren't running 24/7. includes occasional empty phases (cleanse moments).

const PHASES = [
  // gif / blotch / nomu. duplicated entries raise probability of solos.
  { gif: true,  blot: false, nomu: false }, // gifs only
  { gif: true,  blot: false, nomu: false },
  { gif: false, blot: true,  nomu: false }, // blotches only
  { gif: false, blot: true,  nomu: false },
  { gif: false, blot: false, nomu: true  }, // nomu only
  { gif: false, blot: false, nomu: true  },
  { gif: true,  blot: false, nomu: true  }, // gifs + nomu
  { gif: false, blot: true,  nomu: true  }, // blotches + nomu
  { gif: true,  blot: true,  nomu: false }, // gifs + blotches (no text)
  { gif: true,  blot: true,  nomu: true  }, // everything
  { gif: false, blot: false, nomu: false }, // empty — breathing room
];
let gifsEnabled = true;
let blotchesEnabled = true;
let currentPhaseIdx = -1;
let phaseEndsAt = 0;

function applyPhase(p) {
  gifsEnabled = p.gif;
  blotchesEnabled = p.blot;
  // hide nomu via visibility so its DVD/glitch timers keep ticking underneath
  const bt = document.getElementById('big-text');
  if (bt) bt.style.visibility = p.nomu ? '' : 'hidden';
}

function updatePhase() {
  const now = performance.now();
  if (now < phaseEndsAt) return;
  let next;
  do { next = Math.floor(Math.random() * PHASES.length); }
  while (next === currentPhaseIdx && PHASES.length > 1);
  currentPhaseIdx = next;
  applyPhase(PHASES[next]);
  phaseEndsAt = now + 2000 + Math.random() * 5000;
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
const gifLayer = document.getElementById('gif-layer');
const activeGifs = [];
const MAX_GIFS = 5;

function spawnGifTile(opts) {
  opts = opts || {};
  const W = window.innerWidth;
  const H = window.innerHeight;
  // width/height independent so the tile's aspect is random — object-fit:fill
  // then stretches the gif to match, giving squashed/elongated clips
  const width  = 100 + Math.random() * 720;
  const height = 70  + Math.random() * 480;
  const x = Math.random() * Math.max(1, W - width);
  const y = Math.random() * Math.max(1, H - height);
  const targetOp = 0.30 + Math.random() * 0.30;
  const lifespan = opts.lifespan ?? (1000 + Math.random() * 3000);
  const flicker = opts.flicker ?? true;
  const isFlash = !!opts.flash;

  const el = document.createElement('div');
  el.className = 'gif-tile';
  el.style.left = x.toFixed(0) + 'px';
  el.style.top  = y.toFixed(0) + 'px';
  el.style.width  = width.toFixed(0) + 'px';
  el.style.height = height.toFixed(0) + 'px';
  el.style.opacity = targetOp.toFixed(2);

  const img = document.createElement('img');
  img.src = 'nomu_gifs/' + GIF_FILES[Math.floor(Math.random() * GIF_FILES.length)];
  img.decoding = 'async';
  el.appendChild(img);
  gifLayer.appendChild(el);

  const entry = { el, dead: false, targetOp, isFlash };
  activeGifs.push(entry);

  let flickerId = null;
  if (flicker) {
    flickerId = setInterval(() => {
      if (entry.dead) return;
      if (Math.random() < 0.12) {
        el.style.opacity = '0';
        setTimeout(() => { if (!entry.dead) el.style.opacity = entry.targetOp.toFixed(2); }, 40 + Math.random() * 80);
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

// burst = 1 normal tile + 5 rapid-flash tiles at random positions
function spawnGifBurst() {
  spawnGifTile();
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      spawnGifTile({
        lifespan: 60 + Math.random() * 140,
        flicker: false,
        flash: true,
      });
    }, i * (20 + Math.random() * 50));
  }
}

(function gifSpawnerTick() {
  if (gifsEnabled) {
    const livingMain = activeGifs.filter(g => !g.dead && !g.isFlash).length;
    if (livingMain < 1) {
      spawnGifBurst();
    } else if (livingMain < MAX_GIFS && Math.random() < 0.35) {
      spawnGifBurst();
    }
  }
  setTimeout(gifSpawnerTick, 300 + Math.random() * 900);
})();

// ---------- waveform oscilloscope ----------

const waveCanvas = document.getElementById('wave-canvas');
const waveCtx = waveCanvas.getContext('2d');

function resizeWave() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = waveCanvas.getBoundingClientRect();
  waveCanvas.width  = Math.max(1, Math.floor(r.width  * dpr));
  waveCanvas.height = Math.max(1, Math.floor(r.height * dpr));
}
resizeWave();
window.addEventListener('resize', resizeWave);

function drawWaveform() {
  if (!analyser || !waveData) return;
  analyser.getByteTimeDomainData(waveData);

  const w = waveCanvas.width;
  const h = waveCanvas.height;
  waveCtx.clearRect(0, 0, w, h);

  waveCtx.lineWidth = Math.max(1.5, 2 * Math.min(2, window.devicePixelRatio || 1));
  waveCtx.strokeStyle = '#ffffff';
  waveCtx.shadowBlur = 10;
  waveCtx.shadowColor = 'rgba(255, 255, 255, 0.55)';

  waveCtx.beginPath();
  const n = waveData.length;
  const mid = h * 0.5;
  // amplify slightly so even quiet signals are visible
  const amp = h * 0.45 * 1.2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const v = (waveData[i] - 128) / 128; // -1..1
    const y = mid + v * amp;
    if (i === 0) waveCtx.moveTo(x, y);
    else         waveCtx.lineTo(x, y);
  }
  waveCtx.stroke();
}

// ---------- DOM grain overlay (covers text + HUD too) ----------

const grainOverlay = document.getElementById('grain-overlay');
(function initGrain() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(size, size);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = Math.random() * 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  grainOverlay.style.backgroundImage = `url('${c.toDataURL()}')`;
})();

function updateGrainPos() {
  // re-seed position each frame for animated grain
  grainOverlay.style.backgroundPosition =
    `${(Math.random() * 512) | 0}px ${(Math.random() * 512) | 0}px`;
  // opacity follows the crush intensity so grain jumps with crush
  grainOverlay.style.opacity = (0.12 + 0.30 * crushIntensity).toFixed(2);
}

// ---------- crush intensity (choppy, audio-reactive) ----------
// quantized steps between 30% and 100%. re-picks every 80–380 ms. transients
// force the top steps; loud sustained sits mid; quiet sits low. controls pixel
// block size, bit-crush levels, grain amount, scanline darkness.
const CRUSH_STEPS = [0.30, 0.42, 0.55, 0.70, 0.85, 1.00];
let crushIntensity = 0.30;
let nextCrushChange = 0;

function updateCrushIntensity() {
  const now = performance.now();
  if (now < nextCrushChange) return;
  const trans = Math.max(transients.bass, transients.mids, transients.highs);
  const level = Math.max(bands.bass, bands.mids, bands.highs);
  let target;
  if (trans > 0.12) {
    // transient → top 2 steps
    target = CRUSH_STEPS[CRUSH_STEPS.length - 1 - (Math.random() < 0.5 ? 0 : 1)];
  } else if (level > 0.55) {
    // loud sustained → middle-high (steps 2–5)
    target = CRUSH_STEPS[2 + Math.floor(Math.random() * 4)];
  } else {
    // quiet → low-middle (steps 0–3)
    target = CRUSH_STEPS[Math.floor(Math.random() * 4)];
  }
  crushIntensity = target;
  nextCrushChange = now + 80 + Math.random() * 300;
  updateTextFilter();
}

// update the SVG posterize filter used on DOM overlays (text / code / HUD)
const fR = document.getElementById('fR');
const fG = document.getElementById('fG');
const fB = document.getElementById('fB');
function updateTextFilter() {
  if (!fR) return;
  // 3..8 discrete levels — high intensity = fewer levels = more posterized
  const levels = Math.max(3, Math.round(9 - 6 * crushIntensity));
  // evenly distributed discrete tableValues
  const table = Array.from({ length: levels }, (_, i) =>
    ((i + 0.5) / levels).toFixed(3)
  ).join(' ');
  fR.setAttribute('tableValues', table);
  fG.setAttribute('tableValues', table);
  fB.setAttribute('tableValues', table);
}
updateTextFilter();

// ---------- text overlay ----------

const bigText = document.getElementById('big-text');
const codeReadout = document.getElementById('code-readout');

const FONTS = [
  '"Times New Roman", serif',
  'Impact, sans-serif',
  '"Courier New", monospace',
  'Georgia, serif',
  '"Arial Black", sans-serif',
  '"Comic Sans MS", cursive',
  '"Helvetica Neue", sans-serif',
  'Verdana, sans-serif',
  '"Brush Script MT", cursive',
  '"Bradley Hand", cursive',
];
// canvas-based pixelation: render "nomu" into a low-res offscreen canvas,
// then upscale with nearest-neighbor for chunky pixels. re-renders on font
// change and on window resize.
const bigTextCanvas = document.getElementById('big-text-canvas');
const bigTextCtx = bigTextCanvas.getContext('2d');
const bigTextOffscreen = document.createElement('canvas');
const NOMU_PIXEL_SCALE = 9; // block size in display px

function renderBigText(text, fontFamily) {
  const displayFontSize = Math.max(40, window.innerWidth * 0.04);
  const fontWeight = 900;
  const fontStr = `${fontWeight} ${displayFontSize}px ${fontFamily}`;

  // measure at display size
  const octx = bigTextOffscreen.getContext('2d');
  octx.font = fontStr;
  const metrics = octx.measureText(text);
  const textW = Math.ceil(metrics.width) + 8;
  const textH = Math.ceil(displayFontSize * 1.1);

  // offscreen low-res
  const offW = Math.max(4, Math.ceil(textW / NOMU_PIXEL_SCALE));
  const offH = Math.max(4, Math.ceil(textH / NOMU_PIXEL_SCALE));
  bigTextOffscreen.width = offW;
  bigTextOffscreen.height = offH;
  const octx2 = bigTextOffscreen.getContext('2d');
  octx2.imageSmoothingEnabled = false;
  octx2.fillStyle = '#fff';
  octx2.font = `${fontWeight} ${displayFontSize / NOMU_PIXEL_SCALE}px ${fontFamily}`;
  octx2.textBaseline = 'middle';
  octx2.textAlign = 'center';
  octx2.fillText(text, offW / 2, offH / 2);

  // upscale with nearest neighbor — and pin display size so it can't stretch
  bigTextCanvas.width = textW;
  bigTextCanvas.height = textH;
  bigTextCanvas.style.width  = textW + 'px';
  bigTextCanvas.style.height = textH + 'px';
  bigTextCtx.imageSmoothingEnabled = false;
  bigTextCtx.clearRect(0, 0, textW, textH);
  bigTextCtx.drawImage(bigTextOffscreen, 0, 0, textW, textH);
}

let fontIdx = 0;
renderBigText('nomu', FONTS[0]);
setInterval(() => {
  fontIdx = (fontIdx + 1) % FONTS.length;
  renderBigText('nomu', FONTS[fontIdx]);
}, 80);
window.addEventListener('resize', () => renderBigText('nomu', FONTS[fontIdx]));

// text mode state: centered for 10s, then DVD-bounce for 4.5s, repeat
let textMode = 'center';
let textModeEnd = 0;
let textX = 0, textY = 0;      // offset from center, px
let textVx = 0, textVy = 0;    // px/sec
let lastTextTime = 0;

function enterBounce(now) {
  textMode = 'bounce';
  textModeEnd = now + 10000;
  const speed = 520;
  const angle = Math.random() * Math.PI * 2;
  textVx = Math.cos(angle) * speed;
  textVy = Math.sin(angle) * speed;
}
function enterCenter(now) {
  textMode = 'center';
  textModeEnd = now + 10000;
  textX = 0; textY = 0;
}

function updateTextGlitch() {
  if (!bigText) return;
  const now = performance.now();
  const dt = lastTextTime ? Math.min(0.05, (now - lastTextTime) / 1000) : 0;
  lastTextTime = now;

  if (textModeEnd === 0) enterCenter(now);
  if (now > textModeEnd) (textMode === 'center') ? enterBounce(now) : enterCenter(now);

  const trans = Math.max(transients.bass, transients.mids, transients.highs);

  if (textMode === 'bounce') {
    textX += textVx * dt;
    textY += textVy * dt;
    const w = bigText.offsetWidth;
    const h = bigText.offsetHeight;
    const maxX = Math.max(0, (window.innerWidth  - w) / 2);
    const maxY = Math.max(0, (window.innerHeight - h) / 2);
    if (textX >  maxX) { textX =  maxX; textVx = -Math.abs(textVx); }
    if (textX < -maxX) { textX = -maxX; textVx =  Math.abs(textVx); }
    if (textY >  maxY) { textY =  maxY; textVy = -Math.abs(textVy); }
    if (textY < -maxY) { textY = -maxY; textVy =  Math.abs(textVy); }
    // glitch opacity still applies over the bounce
    const r = Math.random();
    let opacity = 0.8;
    if (r < 0.05) opacity = 0.0;
    else if (r < 0.25 + trans * 1.5) opacity = 0.35 + Math.random() * 0.65;
    bigText.style.opacity = opacity.toFixed(2);
    bigText.style.transform = `translate(calc(-50% + ${textX.toFixed(0)}px), calc(-50% + ${textY.toFixed(0)}px))`;
    return;
  }

  // centered mode — existing jitter behavior
  const r = Math.random();
  let opacity = 0.8;
  let dx = 0, dy = 0;
  if (r < 0.05) {
    opacity = 0.0;
  } else if (r < 0.25 + trans * 1.5) {
    opacity = 0.35 + Math.random() * 0.65;
    dx = (Math.random() - 0.5) * (10 + trans * 80);
    dy = (Math.random() - 0.5) * (4 + trans * 25);
  }
  bigText.style.opacity = opacity.toFixed(2);
  bigText.style.transform = `translate(calc(-50% + ${dx.toFixed(0)}px), calc(-50% + ${dy.toFixed(0)}px))`;
}

const hex = (n, p = 4) => Math.floor(Math.abs(n)).toString(16).padStart(p, '0').toUpperCase();

// ---------- code blotches (random placed patches of rapidly mutating text) ----------

const codeLinesEl = document.getElementById('code-lines');
// char pool weighted heavy on '+' then other symbols, numbers, letters, brackets
const CODE_CHARS =
  '+'.repeat(28) +
  '*·×◇▲■○•'.repeat(3) +
  '0123456789abcdefABCDEF'.repeat(2) +
  '/\\:;<>[](){}=_';

const MAX_BLOTCHES = 10;
const MIN_BLOTCHES = 2;
const blotches = [];

function randCodeChar() { return CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; }
function randCodeText(len) { let s = ''; for (let i = 0; i < len; i++) s += randCodeChar(); return s; }

function spawnBlotch() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const fontSize = 10 + Math.random() * 11;
  const lineCount = 1 + Math.floor(Math.random() * 15);
  const width = 90 + Math.random() * 560;
  const height = lineCount * fontSize * 1.15 + 4;
  const x = Math.random() * Math.max(1, W - width);
  const y = Math.random() * Math.max(1, H - height);
  const targetOp = (0.3 + Math.random() * 0.5);
  const charWidth = fontSize * 0.62;
  const lineChars = Math.max(4, Math.floor(width / charWidth));

  const el = document.createElement('div');
  el.className = 'blotch';
  el.style.left = x.toFixed(0) + 'px';
  el.style.top  = y.toFixed(0) + 'px';
  el.style.width = width.toFixed(0) + 'px';
  el.style.fontSize = fontSize.toFixed(1) + 'px';
  el.style.opacity = '0';

  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const ln = document.createElement('div');
    ln.className = 'blotch-line';
    ln.textContent = randCodeText(lineChars);
    el.appendChild(ln);
    lines.push({ el: ln, nextUpdate: 0, baseInterval: 15 + Math.random() * 90 });
  }
  codeLinesEl.appendChild(el);

  const entry = { el, lines, lineChars, fadingOut: false, targetOp };
  blotches.push(entry);

  // fade in
  requestAnimationFrame(() => { el.style.opacity = targetOp.toFixed(2); });

  const lifespan = 800 + Math.random() * 3500;
  setTimeout(() => {
    entry.fadingOut = true;
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      const idx = blotches.indexOf(entry);
      if (idx >= 0) blotches.splice(idx, 1);
    }, 350);
  }, lifespan);
}

// spawner — stochastic, aims for 2–10 concurrent blotches when enabled
(function spawnerTick() {
  if (blotchesEnabled) {
    const activeCount = blotches.filter(b => !b.fadingOut).length;
    if (activeCount < MIN_BLOTCHES) {
      spawnBlotch();
    } else if (activeCount < MAX_BLOTCHES && Math.random() < 0.45) {
      spawnBlotch();
    }
  }
  setTimeout(spawnerTick, 120 + Math.random() * 300);
})();

function updateCodeLines() {
  if (blotches.length === 0) return;
  const now = performance.now();
  const trans = Math.max(transients.bass, transients.mids, transients.highs);
  const mult = 1 / (1 + trans * 4);
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

setInterval(() => {
  const time = new Date().toISOString().slice(11, 19);
  const sig = (-50 + bands.bass * 40 + Math.random() * 6).toFixed(1);
  const lines = [
    `CAM_01  ::  REC  ${time}`,
    `LUM  ${bands.bass.toFixed(3)}  ${bands.mids.toFixed(3)}  ${bands.highs.toFixed(3)}`,
    `GAIN ${audioGain.toFixed(2)}x  FRM ${frameCount}`,
    `0x${hex(Math.random() * 0xFFFFFF, 6)}   0x${hex(frameCount * 7919, 6)}`,
    `SIG ${sig} dB`,
  ];
  codeReadout.textContent = lines.join('\n');
}, 100);
