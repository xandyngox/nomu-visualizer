// shader sources. plain global script (no modules) — loaded before app.js.
// every fragment shader takes u_tex as sampler unit 0 unless noted.

const SHADERS = (() => {

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// shared helpers pasted into shaders that need them (no #include in GLSL ES 1.0)
const LIB = `
const float PI = 3.14159265359;

float hash11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
float hash21(vec2 p)  { return fract(sin(dot(p, vec2(41.31, 289.1))) * 43758.5453); }

vec2 rot2(vec2 uv, float a) {
  vec2 p = uv - 0.5;
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
}
`;

// ---------------------------------------------------------------------------
// feedback pass: webcam (aspect-corrected + composed) combined with the decaying
// previous frame. Everything downstream reads this FBO in canonical UVs.
//
// the prev buffer is sampled through zoom + rotation, so trails spiral rather
// than only drifting straight out. combine is max() — the only blend that
// cannot diverge when decay < 1, which matters for an hour-long set.
// ---------------------------------------------------------------------------
const FS_FEEDBACK = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_webcam;
uniform sampler2D u_prev;
uniform vec2  u_canvas;
uniform vec2  u_video;
uniform float u_decay;
uniform float u_stretch;
uniform float u_zoom;    // <1 trails converge inward, >1 they fly outward
uniform float u_swirl;   // radians/frame applied to the trail buffer
uniform float u_rot;     // rotation applied to the live webcam sample
uniform float u_time;
uniform int   u_scene;
${LIB}

// composition transform, applied after aspect-fit. stretch comes after this so
// each tile stretches independently in the grid modes.
// note: per-camera mirroring happens in the composite pass, so DIRECT is a
// straight pass-through and FLIP mirrors the whole multi-camera frame
// (which also swaps the cells left-to-right, deliberately).
// no tiling compositions. GRID-4/9/16 divided the whole frame into a regular
// 2x2, 3x3 or 4x4 — a literal grid, which is the one thing this is meant not
// to look like. COLUMN's eight equal strips had the same problem.
vec2 applyScene(vec2 uv, int s, float t) {
  if (s == 0) return uv;                                                  // DIRECT
  if (s == 1) return vec2(1.0 - uv.x, uv.y);                              // FLIP
  if (s == 2) {                                                           // SLICE
    // irregular horizontal bands slid sideways — bands are uneven and
    // re-shuffle, so it never settles into a repeating pattern
    float band = floor(uv.y * 11.0);
    float off = (hash11(band + floor(t * 1.4)) - 0.5) * 0.42;
    return vec2(fract(1.0 - uv.x + off), uv.y);
  }
  if (s == 3) {                                                           // PUSH
    // slow breathing zoom. no tiling, no symmetry — just a drift in and out
    float z = 0.86 + 0.14 * sin(t * 0.21);
    return (uv - 0.5) * z + 0.5;
  }
  return uv;
}

void main() {
  float ca = u_canvas.x / u_canvas.y;
  float va = u_video.x  / u_video.y;
  vec2 wuv = v_uv;
  // cover-fit so the webcam fills the canvas
  if (ca > va) { float s = va / ca; wuv.y = (wuv.y - 0.5) * s + 0.5; }
  else         { float s = ca / va; wuv.x = (wuv.x - 0.5) * s + 0.5; }

  if (abs(u_rot) > 0.0001) wuv = rot2(wuv, u_rot);
  wuv = applyScene(wuv, u_scene, u_time);
  wuv.y = (wuv.y - 0.5) / u_stretch + 0.5;

  vec2 puv = rot2((v_uv - 0.5) * u_zoom + 0.5, u_swirl);

  vec3 webcam = texture2D(u_webcam, wuv).rgb;
  vec3 prev   = texture2D(u_prev,   puv).rgb;

  gl_FragColor = vec4(max(webcam, prev * u_decay), 1.0);
}
`;

// ---------------------------------------------------------------------------
// luminance silhouette — hard threshold, blown-out flash where lum > threshold.
// u_lumaGain scales the luma before thresholding (below 1.0 it takes more light
// to trip the flash, which is how the live look is dialed in).
// ---------------------------------------------------------------------------
const FS_SILHOUETTE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_thresh;
uniform float u_lumaGain;
uniform float u_amount;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114)) * u_lumaGain;
  float sil = step(u_thresh, lum) * u_amount;
  // slightly warm white — reads better through trail decay than pure #fff
  vec3 flash = vec3(1.0, 0.98, 0.94);
  gl_FragColor = vec4(mix(c, flash, sil), 1.0);
}
`;

// ---------------------------------------------------------------------------
// RGB channel offset — CCTV misalignment. u_angle rotates the split direction
// so it is not always a horizontal tear.
// ---------------------------------------------------------------------------
const FS_RGB = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_offset;
uniform float u_angle;
void main() {
  vec2 d = vec2(cos(u_angle), sin(u_angle)) * u_offset;
  float r = texture2D(u_tex, v_uv - d).r;
  float g = texture2D(u_tex, v_uv    ).g;
  float b = texture2D(u_tex, v_uv + d).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

// ---------------------------------------------------------------------------
// pixel sort — walk up to MAX_N pixels along u_dir carrying the brightest
// sample forward. approximates glitch-art sorting without actually sorting.
// strength 0 means the loop breaks immediately, so quiet frames are cheap.
// ---------------------------------------------------------------------------
const FS_SORT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform float u_strength;   // 0..1
uniform vec2  u_dir;        // unit direction to walk
uniform vec2  u_res;
uniform float u_react;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float bright = dot(c, vec3(0.333));
  vec3 acc = c;

  // sort runs long through flat regions and motion wakes, and barely at all
  // across detail — so edges survive and the smear grows out of the movement
  vec4 m = texture2D(u_mask, v_uv);
  float w = mix(1.0, clamp((1.0 - m.r) * 0.6 + m.b * 1.2, 0.0, 1.5), u_react);

  const int MAX_N = 14;
  int N = int(u_strength * w * float(MAX_N));
  for (int i = 1; i <= MAX_N; i++) {
    if (i > N) break;
    vec2 uv = v_uv - u_dir * (float(i) / u_res);
    vec3 s = texture2D(u_tex, uv).rgb;
    float sl = dot(s, vec3(0.333));
    if (sl > bright) { acc = s; bright = sl; }
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;

// ---------------------------------------------------------------------------
// datamosh displace — two layers:
//   bands  : horizontal strips slid sideways, some holding a single column
//            (the frozen-macroblock smear of a broken P-frame)
//   blocks : coarse macroblock grid jittered a few pixels
// wraps with fract() so displaced strips tear across the frame edge.
// ---------------------------------------------------------------------------
const FS_DISPLACE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform float u_amount;   // 0..1
uniform float u_bands;
uniform float u_blocks;
uniform float u_seed;
uniform float u_react;    // 0 = flat global strength, 1 = fully mask-driven
uniform float u_time;
uniform float u_period;   // length of one gesture cycle, in seconds
${LIB}

// how much damage this chunk has earned. the mask is sampled at the CHUNK's
// centre, not per pixel — a chunk has to displace as one piece or it shears
// into noise instead of sliding like a broken macroblock.
float weightAt(vec2 chunkUV) {
  vec4 m = texture2D(u_mask, chunkUV);
  // flat areas take the hit, detail is spared, motion wakes take the most
  float w = (1.0 - m.r) * 0.55 + m.b * 1.15;
  return mix(1.0, clamp(w, 0.0, 1.6), u_react);
}

// the gesture envelope. each chunk owns a slot in a repeating cycle, with its
// own stable phase, and within that slot it eases out, holds, and snaps back.
//
// this replaces re-randomising every chunk every 90ms. a new random offset per
// frame is noise — it flickers and reads as broken. a chunk that slides out
// over a few frames, sits, and returns is a movement, and the eye reads it as
// deliberate even when dozens are happening at once.
float gesture(float id, float time, float period) {
  float t = fract(time / period + hash21(vec2(id, 3.7)));
  // fast ease out, hold, hard cut back to rest
  return smoothstep(0.0, 0.10, t) * (1.0 - step(0.55, t));
}

void main() {
  vec2 uv = v_uv;

  // --- band layer, weighted by what is in that band
  float band = floor(v_uv.y * u_bands);
  float bw = weightAt(vec2(v_uv.x, (band + 0.5) / u_bands));
  float aBand = u_amount * bw;
  // which bands take part is stable for the whole seed window, so the same
  // bands keep gesturing rather than a different random set every frame
  float active = step(1.0 - clamp(aBand, 0.0, 1.0) * 0.9, hash21(vec2(band, u_seed)));
  float dirB = hash21(vec2(band, u_seed + 7.0)) - 0.5;
  float envB = gesture(band, u_time, u_period);
  uv.x = fract(uv.x + dirB * 0.11 * aBand * active * envB);

  // --- block layer, weighted per block, on a faster cycle
  vec2 bgrid = vec2(u_blocks, u_blocks * 0.6);
  vec2 bl = floor(v_uv * bgrid);
  float blw = weightAt((bl + 0.5) / bgrid);
  float aBlock = u_amount * blw;
  float bActive = step(1.0 - clamp(aBlock, 0.0, 1.0) * 0.5, hash21(bl + u_seed * 1.7));
  float envBl = gesture(bl.x * 31.0 + bl.y, u_time, u_period * 0.41);
  vec2 dirBl = vec2(hash21(bl + 1.3), hash21(bl + 5.7)) - 0.5;
  uv = fract(uv + dirBl * 0.018 * bActive * aBlock * envBl);

  vec3 c = texture2D(u_tex, uv).rgb;

  // frozen-column smear, only during a band's hold phase and only on a few
  // bands. gated by the envelope so it arrives and leaves with the gesture
  // instead of strobing on and off underneath it.
  float hold = step(0.90, hash21(vec2(band, u_seed + 19.0))) * active * envB;
  vec3 held = texture2D(u_tex, vec2(hash21(vec2(band, u_seed + 3.0)), v_uv.y)).rgb;
  gl_FragColor = vec4(mix(c, held, hold * 0.55), 1.0);
}
`;

// ---------------------------------------------------------------------------
// chromatic aberration with quadratic radial falloff — clean center, torn
// corners. collapsed to luma by the palette pass, so it reads as an edge smear
// rather than colored fringing.
// ---------------------------------------------------------------------------
const FS_ABERR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_strength;
void main() {
  vec2 dir = v_uv - vec2(0.5);
  float dist = length(dir);
  vec2 off = dir * (u_strength * dist * dist * 2.0);
  float r = texture2D(u_tex, v_uv + off).r;
  float g = texture2D(u_tex, v_uv      ).g;
  float b = texture2D(u_tex, v_uv - off).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

// ---------------------------------------------------------------------------
// sobel edge detect, mixed over the base. at high amount it reads as a
// wireframe trace of the performer; low amount just crisps the contours.
// ---------------------------------------------------------------------------
const FS_EDGE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_res;
uniform float u_amount;

float lum(vec2 uv) { return dot(texture2D(u_tex, uv).rgb, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 px = 1.0 / u_res;
  float tl = lum(v_uv + px * vec2(-1.0, -1.0));
  float t  = lum(v_uv + px * vec2( 0.0, -1.0));
  float tr = lum(v_uv + px * vec2( 1.0, -1.0));
  float l  = lum(v_uv + px * vec2(-1.0,  0.0));
  float r  = lum(v_uv + px * vec2( 1.0,  0.0));
  float bl = lum(v_uv + px * vec2(-1.0,  1.0));
  float b  = lum(v_uv + px * vec2( 0.0,  1.0));
  float br = lum(v_uv + px * vec2( 1.0,  1.0));

  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  float g = clamp(pow(length(vec2(gx, gy)), 0.8), 0.0, 1.0);

  vec3 base = texture2D(u_tex, v_uv).rgb;
  gl_FragColor = vec4(mix(base, vec3(g), u_amount), 1.0);
}
`;

// ---------------------------------------------------------------------------
// bloom: bright-pass -> separable blur (quarter res) -> additive combine.
// this is what gives highlights actual bleed instead of a hard clipped edge.
// ---------------------------------------------------------------------------
const FS_BRIGHT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform float u_thresh;
uniform float u_trailGlow;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = max(0.0, l - u_thresh) / max(0.0001, 1.0 - u_thresh);
  // the motion wake is pushed into the bloom source, so anything that moves
  // blooms softly behind itself instead of being stamped with hard blocks
  float tm = texture2D(u_mask, v_uv).b;
  k += tm * tm * u_trailGlow;
  gl_FragColor = vec4(c * k, 1.0);
}
`;

// 9-tap gaussian using linear-filtered pair offsets
const FS_BLUR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;   // texel-space step, one axis at a time
void main() {
  vec3 s = texture2D(u_tex, v_uv).rgb * 0.2270270270;
  s += (texture2D(u_tex, v_uv + u_dir * 1.3846153846).rgb +
        texture2D(u_tex, v_uv - u_dir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture2D(u_tex, v_uv + u_dir * 3.2307692308).rgb +
        texture2D(u_tex, v_uv - u_dir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(s, 1.0);
}
`;

const FS_COMBINE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_bloom;
uniform float u_amount;
void main() {
  vec3 c = texture2D(u_tex,   v_uv).rgb;
  vec3 b = texture2D(u_bloom, v_uv).rgb;
  gl_FragColor = vec4(c + b * u_amount, 1.0);
}
`;

// ---------------------------------------------------------------------------
// palette: collapse to luma (max-of-channels keeps the RGB-offset ghost as a
// smear), then map through a 3-stop gradient supplied from JS so the whole
// look can crossfade between palettes. also handles invert + strobe flashes.
// ---------------------------------------------------------------------------
const FS_PALETTE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3  u_dark;
uniform vec3  u_mid;
uniform vec3  u_bright;
uniform float u_strobe;    // 1 = full white this frame
uniform float u_invert;    // 1 = negative
uniform float u_contrast;
uniform float u_lift;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  float lum = max(c.r, max(c.g, c.b));
  lum = clamp((lum - 0.5) * u_contrast + 0.5 + u_lift, 0.0, 1.0);
  lum = mix(lum, 1.0 - lum, u_invert);

  vec3 color = (lum < 0.5)
    ? mix(u_dark, u_mid,    lum * 2.0)
    : mix(u_mid,  u_bright, (lum - 0.5) * 2.0);

  gl_FragColor = vec4(mix(color, vec3(1.0), u_strobe), 1.0);
}
`;

// ---------------------------------------------------------------------------
// final film pass.
//
// three things here separate "graded" from "phone filter":
//
//  1. a filmic tone curve instead of clamp(). hard-clipping highlights is what
//     makes an image read as a video filter — a shoulder that rolls off keeps
//     detail in the blown-out areas and is most of the "expensive" look.
//  2. luma-weighted grain. uniform noise over the whole frame is a video
//     effect; real emulsion grain lives in the shadows and midtones and
//     disappears in the highlights, so the weight tracks luminance.
//  3. ordered dithering before the bit-depth crush. quantizing a smooth
//     gradient bands hideously on a projector, but nudging each pixel by a
//     bayer threshold first turns the banding into a fine halftone.
//
// the pixel crush is kept but driven much gentler by default — chunky
// pixelation as a constant is the single most recognisable filter-app tell.
// ---------------------------------------------------------------------------
const FS_FILM = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_res;
uniform float u_pixelSize;
uniform float u_crushLevels;
uniform float u_grain;
uniform float u_scanline;
uniform float u_brightness;
uniform float u_time;
uniform float u_wobble;
uniform float u_vignette;
uniform float u_dither;
uniform float u_bar;       // letterbox bar height as a fraction of the frame
uniform float u_contrast;
uniform sampler2D u_mask;
uniform float u_react;     // 0 = uniform crush, 1 = mask-driven patches
uniform float u_trailGain; // brightness of the pixel wake behind movement
${LIB}

float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
#define BAYER4(a) (bayer2(0.5 * (a)) * 0.25 + bayer2(a))
#define BAYER8(a) (BAYER4(0.5 * (a)) * 0.25 + bayer2(a))

// ACES filmic approximation (Narkowicz). the shoulder is the point.
vec3 tonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  // letterbox — hard black bars, no grain or vignette inside them
  if (v_uv.y < u_bar || v_uv.y > 1.0 - u_bar) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 uv = v_uv;

  // tape wobble — per-row horizontal jitter, sine drift plus per-frame noise
  if (u_wobble > 0.0) {
    float row = floor(uv.y * u_res.y);
    float w = sin(row * 0.1 + u_time * 13.0) * 0.5
            + (hash21(vec2(row, floor(u_time * 24.0))) - 0.5);
    uv.x += w * u_wobble;
  }

  // --- how much this region has earned. sampled on a coarse cell so a whole
  // patch agrees on its block size; per-pixel would dissolve the blocks.
  float cellPx = max(5.0, u_pixelSize * 3.5);
  vec2 coarse = (floor(v_uv * u_res / cellPx) + 0.5) * cellPx / u_res;
  vec4 m = texture2D(u_mask, coarse);
  float g = clamp((1.0 - m.r) * 0.5 + m.b * 1.15, 0.0, 1.0);
  // a little noise so patch edges are ragged rather than following the
  // sampling grid — this is most of what makes it read as irregular damage
  // instead of a mosaic filter
  float edge = (hash21(floor(v_uv * u_res / cellPx) + 3.1) - 0.5) * 0.30;

  // block size is CONTINUOUS in the local energy, not a switch between two
  // sizes. quiet detailed regions land at 1px (genuinely crisp), hot regions
  // in a motion wake land at the full size, and everything in between gets an
  // intermediate size — so a single frame holds a whole range of block sizes
  // instead of one uniform mosaic. the gamma biases toward the small end so
  // big blocks stay an event rather than the default.
  float local = clamp(g + edge, 0.0, 1.0);
  float px = 1.0 + floor(pow(local, 1.6) * u_pixelSize);
  px = max(1.0, mix(u_pixelSize, px, u_react));
  vec2 pUV = floor(uv * u_res / px) * px / u_res;
  vec3 c = texture2D(u_tex, pUV).rgb;

  // the motion wake used to be drawn here as step(0.55, hash) per block — a
  // hard binary coin flip that lit half the blocks solid white and read as a
  // QR code. it now feeds the bloom bright-pass instead, so movement leaves a
  // glow rather than a field of squares.

  // exposure, then the filmic curve, so highlights roll off instead of clipping
  c = tonemap(c * u_brightness);

  // contrast pivoted on mid grey
  c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);

  // ordered-dithered bit-depth crush
  c += (BAYER8(v_uv * u_res) - 0.5) * (u_dither / u_crushLevels);
  c = floor(c * u_crushLevels + 0.5) / u_crushLevels;

  // scanlines — every other row slightly darker
  c *= 1.0 - u_scanline * mod(floor(v_uv.y * u_res.y), 2.0);

  // vignette, smooth rather than quadratic so there is no visible edge
  float d = length(v_uv - 0.5) * 1.42;
  c *= 1.0 - u_vignette * smoothstep(0.35, 1.0, d);

  // grain weighted by luminance — strongest in the shadows, gone in highlights
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float weight = 1.0 - smoothstep(0.15, 0.95, lum);
  c += (hash21(v_uv * u_res + u_time * 7.0) - 0.5) * u_grain * weight;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// raymarched world.
//
// a real 3D scene rendered per-pixel by sphere tracing a signed distance
// field. it exists so the piece is not only flat camera imagery — the eye
// reads parallax and depth here in a way no amount of 2D warping gives you.
//
// the camera feed is projected onto the surfaces (triplanar, by dominant
// normal axis), so the room is lit and textured by what the camera sees rather
// than being a separate canned animation sitting next to it.
//
// output is deliberately luminance-only — the palette pass downstream maps it
// onto the same blue ramp as everything else, so it belongs to the frame.
// ---------------------------------------------------------------------------
const FS_WORLD = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_cam;
uniform vec2  u_res;
uniform float u_time;
uniform float u_energy;   // audio energy — drives speed and light
uniform float u_px;       // ray grid pixelation, in pixels
uniform int   u_mode;     // 0 rooms 1 tunnel 2 orbit 3 coaster 4 ocean 5 mountain
${LIB}

vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ridged fBm — the abs() fold is what turns rounded hills into sharp crests
float ridged(vec2 p) {
  float h = 0.0, a = 0.55;
  for (int i = 0; i < 5; i++) {
    h += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
    p *= 2.07;
    a *= 0.5;
  }
  return h;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float map(vec3 p) {
  if (u_mode == 0) {
    // BACKROOMS — an endless pillared hall between a floor and a ceiling.
    // the xz repeat is what makes it infinite for free.
    vec3 q = p;
    q.xz = mod(q.xz + 3.0, 6.0) - 3.0;
    float pillar = sdBox(q, vec3(0.85, 20.0, 0.85)) - 0.05;
    return min(min(pillar, p.y + 2.2), 2.8 - p.y);
  }
  if (u_mode == 1) {
    // TUNNEL — a tube whose centre wanders, so flying it reads as a path
    vec2 c = vec2(sin(p.z * 0.18) * 1.7, cos(p.z * 0.13) * 1.2);
    return 2.6 - length(p.xy - c);
  }
  if (u_mode == 2) {
    // ORBIT — a monolith that morphs between a box and a sphere
    vec3 q = p;
    q.xz = rot(q.xz, u_time * 0.25);
    q.yz = rot(q.yz, sin(u_time * 0.2) * 0.3);
    float b = sdBox(q, vec3(0.9, 1.5, 0.9)) - 0.08;
    float s = length(q) - 1.55;
    return mix(b, s, 0.5 + 0.5 * sin(u_time * 0.35));
  }
  if (u_mode == 3) {
    // COASTER — a twisting, sweeping tube with a pair of rails running through
    vec3 q = p;
    q.xy = rot(q.xy, p.z * 0.11);
    q.x += sin(p.z * 0.09) * 2.2;
    float tube = 2.3 - length(q.xy);
    float rail = length(vec2(abs(q.x) - 1.35, q.y + 1.5)) - 0.09;
    return min(tube, rail);
  }
  if (u_mode == 5) {
    // MOUNTAIN — ridged terrain running to a far horizon. like the ocean this
    // is a heightfield rather than a true distance field, so the march step is
    // scaled down to stop it cutting through a ridge.
    float h = ridged(p.xz * 0.16) * 3.4 - 1.9;
    return (p.y - h) * 0.42;
  }
  // OCEAN — a shoreline. open water on one side carries the swell, the sand
  // on the other stays flat and still. the wave height is a heightfield, and
  // the camera feed gets projected across it, so the footage becomes the
  // moving water while the calm side reads as an empty beach.
  float shore = smoothstep(-1.2, 2.0, p.x);           // 0 sand, 1 open water
  float swell = sin(p.z * 0.55 + u_time * 1.15) * 0.22
              + sin(p.x * 0.75 - u_time * 0.85) * 0.16
              + sin((p.x + p.z) * 1.35 + u_time * 1.9) * 0.07;
  float ground = mix(-0.32, 0.0, shore) + swell * shore;
  // heightfields are not true distance fields, so scale the step down to keep
  // the march from overshooting through a wave crest
  return (p.y - ground) * 0.55;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

void main() {
  // quantise the ray grid before marching. this is a real low-resolution
  // render rather than a blur of a sharp one — edges stay hard, which is the
  // difference between "low-poly render" and "smeared".
  vec2 uv = (floor(v_uv * u_res / u_px) + 0.5) * u_px / u_res;
  vec2 sp = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);

  float t = u_time * (0.55 + u_energy * 0.9);

  vec3 ro, ta;
  if (u_mode == 0) {
    ro = vec3(sin(t * 0.25) * 1.6, sin(t * 1.7) * 0.07, t * 2.0);
    ta = ro + vec3(sin(t * 0.25 + 1.0) * 0.5, -0.05, 1.0);
  } else if (u_mode == 1) {
    float z = t * 3.0;
    ro = vec3(sin(z * 0.18) * 1.7, cos(z * 0.13) * 1.2, z);
    float z2 = z + 2.0;
    ta = vec3(sin(z2 * 0.18) * 1.7, cos(z2 * 0.13) * 1.2, z2);
  } else if (u_mode == 2) {
    float a = t * 0.35;
    ro = vec3(cos(a) * 5.0, sin(t * 0.2) * 1.8, sin(a) * 5.0);
    ta = vec3(0.0);
  } else if (u_mode == 3) {
    float z = t * 5.5;                       // fast — it is a coaster
    vec2 off = rot(vec2(0.0, -1.1), -z * 0.11);
    ro = vec3(off.x - sin(z * 0.09) * 2.2, off.y, z);
    float z2 = z + 2.5;
    vec2 off2 = rot(vec2(0.0, -1.1), -z2 * 0.11);
    ta = vec3(off2.x - sin(z2 * 0.09) * 2.2, off2.y, z2);
  } else if (u_mode == 4) {
    // OCEAN — low over the shoreline, drifting along it and looking out to sea
    ro = vec3(-1.4 + sin(t * 0.12) * 0.8, 0.85, t * 1.1);
    ta = ro + vec3(2.2, -0.42 + sin(t * 0.2) * 0.06, 0.7);
  } else {
    // MOUNTAIN — flying over the ridges, banking slowly
    ro = vec3(sin(t * 0.09) * 6.0, 3.1 + sin(t * 0.17) * 0.5, t * 1.6);
    ta = ro + vec3(sin(t * 0.09 + 0.8) * 2.0, -0.55, 2.4);
  }

  vec3 fwd = normalize(ta - ro);
  vec3 rgt = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up  = cross(fwd, rgt);
  vec3 rd  = normalize(fwd * 1.5 + rgt * sp.x + up * sp.y);

  float dist = 0.0;
  float hit = 0.0;
  for (int i = 0; i < 64; i++) {
    vec3 pos = ro + rd * dist;
    float d = map(pos);
    if (d < 0.004 * dist) { hit = 1.0; break; }
    if (dist > ((u_mode == 4 || u_mode == 5) ? 90.0 : 38.0)) break;
    dist += d * 0.85;
  }

  // open scenes get a sky: a soft gradient with a cloud band, so the horizon
  // reads instead of the terrain floating in void
  vec3 col = vec3(0.0);
  if (u_mode == 4 || u_mode == 5) {
    float sky = smoothstep(-0.15, 0.55, rd.y);
    float band = vnoise(vec2(rd.x * 5.0 + u_time * 0.05, rd.y * 9.0)) * smoothstep(0.02, 0.4, rd.y);
    col = vec3(0.05 + sky * 0.16 + band * 0.12);
  }
  if (hit > 0.5) {
    vec3 pos = ro + rd * dist;
    vec3 n = normalAt(pos);

    // headlight — a torch on the camera, which is what sells "walking through"
    float lam = max(0.0, dot(n, -rd)) * 0.75 + 0.25;

    // triplanar projection of the camera feed by dominant normal axis
    vec2 tuv;
    if (abs(n.y) > 0.5)      tuv = pos.xz * 0.11;
    else if (abs(n.x) > 0.5) tuv = pos.zy * 0.11;
    else                     tuv = pos.xy * 0.11;
    float cam = dot(texture2D(u_cam, fract(tuv)).rgb, vec3(0.299, 0.587, 0.114));

    col = vec3(0.06 + lam * 0.45 + cam * 0.6 * lam);
    // the ocean wants a far horizon, the interiors want close fog
    col *= exp(-dist * ((u_mode == 4 || u_mode == 5) ? 0.016 : 0.055));
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// ASCII pass — resolve the image into a grid of glyphs.
//
// two modes:
//   RAMP  glyph chosen by cell brightness from a density ladder, the classic
//         ASCII-art mapping. the picture is drawn by which characters appear.
//   WORD  glyphs spell NOMU over and over and brightness carries the image, so
//         the shape fills with repeating text rather than with symbols.
//
// the source is sampled once at the CELL CENTRE, not per pixel — sampling per
// pixel would just paint the image through a glyph-shaped stencil, which looks
// like a texture overlay instead of like the image being rebuilt out of type.
// ---------------------------------------------------------------------------
const FS_ASCII = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_atlas;
uniform vec2  u_res;
uniform float u_cell;       // cell size in pixels
uniform float u_count;      // total glyphs in the atlas
uniform float u_rampLo;     // first index of the density ladder
uniform float u_rampN;      // how many glyphs in the ladder
uniform float u_wordLo;     // first index of the NOMU glyphs
uniform float u_wordN;
uniform float u_mode;       // 0 = RAMP, 1 = WORD
uniform float u_amount;
${LIB}

void main() {
  vec2 grid = u_res / u_cell;
  vec2 cellId = floor(v_uv * grid);
  vec2 cellUV = fract(v_uv * grid);
  vec2 centre = (cellId + 0.5) / grid;

  vec3 src = texture2D(u_tex, centre).rgb;
  float lum = dot(src, vec3(0.299, 0.587, 0.114));

  float idx, bright;
  if (u_mode < 0.5) {
    idx = u_rampLo + floor(clamp(lum, 0.0, 0.999) * u_rampN);
    bright = 1.0;
  } else {
    // step the word along rows as well as columns so it reads as running text
    // rather than as vertical stripes of the same letter
    idx = u_wordLo + mod(cellId.x + cellId.y * 2.0, u_wordN);
    bright = smoothstep(0.06, 0.55, lum);
  }

  vec2 auv = vec2((idx + cellUV.x) / u_count, cellUV.y);
  float g = texture2D(u_atlas, auv).r;

  gl_FragColor = vec4(mix(src, vec3(g * bright), u_amount), 1.0);
}
`;

// ---------------------------------------------------------------------------
// 3D letter rain — columns of NOMU falling away into perspective.
//
// four depth layers, each scaled about the vanishing point and running at its
// own speed. near layers are large, fast and bright; far layers are small,
// slow and dim, which is what produces the depth read without raymarching
// anything. each column has a bright head and a fading tail.
// ---------------------------------------------------------------------------
const FS_RAIN = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_atlas;
uniform sampler2D u_cam;
uniform vec2  u_res;
uniform float u_time;
uniform float u_count;
uniform float u_wordLo;
uniform float u_wordN;
uniform float u_energy;
${LIB}

void main() {
  vec3 acc = vec3(0.0);

  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    // depth: layer 0 is closest. scaling UVs about centre by z pushes the
    // layer away, and shrinking the cell with it keeps the glyphs perspective
    // -correct rather than just smaller.
    float z = 1.0 + fk * 0.85;
    vec2 p = (v_uv - 0.5) * z + 0.5;
    float cell = (26.0 + u_energy * 8.0) / z;

    vec2 grid = u_res / cell;
    vec2 id = floor(p * grid);
    vec2 cuv = fract(p * grid);

    float col = id.x + fk * 37.0;
    float speed = (0.35 + hash11(col) * 1.1) * (1.0 + u_energy * 1.4);
    float fall = u_time * speed * 7.0;

    // where this cell sits in its column's cycle: 0 at the head, 1 at the tail
    float trailLen = 10.0 + hash11(col + 5.0) * 14.0;
    float phase = fract((id.y + fall) / trailLen);
    float bright = pow(1.0 - phase, 3.2);

    // the glyph changes as the column falls, so the text churns
    float gi = u_wordLo + mod(floor(id.y + fall) + floor(hash11(col) * 4.0), u_wordN);
    vec2 auv = vec2((gi + cuv.x) / u_count, cuv.y);
    float g = texture2D(u_atlas, auv).r;

    // head glyph blown out, tail dim
    float head = step(0.94, 1.0 - phase);
    float lay = g * bright * (0.35 + 0.65 / z) + g * head * 0.5;

    // camera feed gates the rain, so it thickens where there is something to
    // see and thins out over empty stage
    float camLum = dot(texture2D(u_cam, v_uv).rgb, vec3(0.299, 0.587, 0.114));
    acc += vec3(lay * (0.45 + camLum * 0.9));
  }

  gl_FragColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// analysis pass — builds the control mask every other effect reads.
//
// this is what stops the glitch being a uniform sheet over the whole frame.
// instead of one global strength, each effect asks "what is happening HERE"
// and reacts to it:
//
//   R  detail   local high-frequency energy. a face, an edge, a hand has
//               detail; a wall or a blown-out background does not.
//   G  motion   frame-to-frame luminance change at this pixel.
//   B  trail    motion, held and decayed, and bled slightly outward — so a
//               hand or a swing of hair drags a wake behind it that persists
//               for a beat instead of vanishing the next frame.
//
// downstream, flat areas and motion wakes get the damage and detailed still
// areas stay legible. that inversion is the whole trick: uniform glitch reads
// as a filter, glitch that avoids the face reads as deliberate.
// ---------------------------------------------------------------------------
const FS_ANALYZE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_curr;    // composite, this frame
uniform sampler2D u_prev;    // composite, last frame
uniform sampler2D u_mask;    // mask, last frame (for trail persistence)
uniform vec2  u_res;
uniform float u_decay;
uniform float u_detailGain;
uniform float u_motionGain;

float lumAt(sampler2D t, vec2 uv) {
  return dot(texture2D(t, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 px = 1.0 / u_res;
  float c = lumAt(u_curr, v_uv);

  // local detail: distance from a cheap 4-tap average a few pixels out.
  // high where there is structure, near zero on flat walls and blowouts.
  float avg = (lumAt(u_curr, v_uv + vec2(px.x * 3.0, 0.0))
             + lumAt(u_curr, v_uv - vec2(px.x * 3.0, 0.0))
             + lumAt(u_curr, v_uv + vec2(0.0, px.y * 3.0))
             + lumAt(u_curr, v_uv - vec2(0.0, px.y * 3.0))) * 0.25;
  float detail = clamp(abs(c - avg) * u_detailGain, 0.0, 1.0);

  float motion = clamp(abs(c - lumAt(u_prev, v_uv)) * u_motionGain, 0.0, 1.0);

  // trail — hold and decay in place, with a small outward bleed so the wake
  // has a soft edge instead of ending on a hard pixel boundary.
  //
  // the bleed factor has to be well below 1. taking max() of the neighbourhood
  // at ~0.97 is a flood fill: each frame the wake grows by the sample radius
  // while barely fading, so anything crossing the frame eventually seeds the
  // whole mask and every effect goes uniform again — exactly the problem the
  // mask exists to solve. 0.86 keeps the bleed to a few pixels.
  float n = max(
    max(texture2D(u_mask, v_uv + vec2(px.x * 2.0, 0.0)).b,
        texture2D(u_mask, v_uv - vec2(px.x * 2.0, 0.0)).b),
    max(texture2D(u_mask, v_uv + vec2(0.0, px.y * 2.0)).b,
        texture2D(u_mask, v_uv - vec2(0.0, px.y * 2.0)).b));
  float held = max(texture2D(u_mask, v_uv).b, n * 0.86) * u_decay;
  float trail = max(motion, held);

  gl_FragColor = vec4(detail, motion, trail, 1.0);
}
`;

// ---------------------------------------------------------------------------
// one camera drawn into one cell of the multi-camera composite. the cell rect
// is set by gl.viewport, so this shader only has to cover-fit the source into
// whatever aspect that cell turned out to be.
// ---------------------------------------------------------------------------
const FS_CELL = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_cell;    // cell size in px — its aspect is what we fit to
uniform vec2  u_video;   // source video dimensions
uniform float u_mirror;  // 1 = flip horizontally (front-facing cameras)
void main() {
  float ca = u_cell.x  / u_cell.y;
  float va = u_video.x / u_video.y;
  vec2 uv = v_uv;
  if (ca > va) { float s = va / ca; uv.y = (uv.y - 0.5) * s + 0.5; }
  else         { float s = ca / va; uv.x = (uv.x - 0.5) * s + 0.5; }
  uv.x = mix(uv.x, 1.0 - uv.x, u_mirror);
  gl_FragColor = vec4(texture2D(u_tex, uv).rgb, 1.0);
}
`;

// copy webcam (aspect-corrected + mirrored) into a small FBO for motion detect
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
  if (ca > va) { float s = va / ca; uv.y = (uv.y - 0.5) * s + 0.5; }
  else         { float s = ca / va; uv.x = (uv.x - 0.5) * s + 0.5; }
  uv.x = 1.0 - uv.x;
  gl_FragColor = vec4(texture2D(u_webcam, uv).rgb, 1.0);
}
`;

// motion overlay: frame-diff the small webcam buffers; cells above threshold
// get a bright box drawn over the graded output. grid matches buffer res 1:1.
const FS_MOTION = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_curr;
uniform sampler2D u_prev;
uniform vec2  u_grid;
uniform float u_thresh;
uniform float u_amount;
void main() {
  vec3 base = texture2D(u_tex, v_uv).rgb;
  vec2 cellUV = (floor(v_uv * u_grid) + 0.5) / u_grid;
  float a = dot(texture2D(u_curr, cellUV).rgb, vec3(0.3333));
  float b = dot(texture2D(u_prev, cellUV).rgb, vec3(0.3333));
  float active = step(u_thresh, abs(a - b));

  vec2 local = fract(v_uv * u_grid);
  float d = min(min(local.x, local.y), min(1.0 - local.x, 1.0 - local.y));
  float isBorder = 1.0 - step(0.035, d); // thinner box outline

  vec3 line = vec3(0.95, 0.98, 1.0);
  gl_FragColor = vec4(mix(base, line, active * isBorder * u_amount), 1.0);
}
`;

// final blit: FBO -> screen
const FS_BLIT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() { gl_FragColor = texture2D(u_tex, v_uv); }
`;

return {
  VS, FS_FEEDBACK, FS_SILHOUETTE, FS_RGB, FS_SORT, FS_DISPLACE, FS_ABERR,
  FS_EDGE, FS_BRIGHT, FS_BLUR, FS_COMBINE, FS_PALETTE, FS_FILM,
  FS_CELL, FS_ANALYZE, FS_WORLD, FS_ASCII, FS_RAIN,
  FS_WEBCAM_COPY, FS_MOTION, FS_BLIT,
};

})();
