# nomu visualizer

Live audio-reactive visuals. Webcam(s) in, WebGL glitch chain out. No build step,
no dependencies.

## Running

> The page loads `shaders.js` and `app.js` with a cache-busting query, so you
> always get the current code. A stale `app.js` against a fresh `index.html`
> throws on the first missing element and the render loop dies — which looks
> exactly like "the cameras are broken".


Needs to be served over `localhost` — `getUserMedia` refuses to run from `file://`.

```bash
cd ~/dev/visualizer && python3 -m http.server 8137
```

Open <http://localhost:8137>, tick the cameras you want, pick the audio input,
hit **start**.

### Soundcheck

1. `f` — fullscreen on the projector output.
2. `[` / `]` — trim audio gain until the BASS/MIDS/HIGH bars peak around
   0.7–0.9 on the loud parts. Everything downstream keys off these.
3. `t` four times on the beat if the BPM readout looks wrong. `T` releases it
   back to auto.
4. `←` / `→` — exposure, for how bright the room actually is.

## Cameras

**All open cameras are on screen at once.** They composite into a split, grid,
strips or picture-in-picture layout with a hairline gutter and a small corner
label per cell. `l` cycles layouts, `L` stops the auto-cycling. The layout is
the background of the frame — clips and GIFs sit on top of it, so a camera is
always visible.

Only layouts that fit every open camera are offered, and the set changes as
cameras come and go.

Every video input the browser reports shows up in the list, and the set is live:
plug in a capture card or wake an iPhone over Continuity Camera and a row
appears mid-set. Unplug one and it drops out of rotation. If a camera you had
ticked disappears and comes back, it comes back ticked; if you deliberately
untick one, it stays unticked even across a reconnect.

Losing a camera drops it from the layout and the remaining cameras re-flow.
Losing *every* camera does not stop the render — the trails just decay out.

Every open camera is decoded and uploaded each frame, so GPU cost scales with
how many you run. Three at 720p is comfortable; if you run more and the fps
readout dips, the perf governor drops the internal resolution on its own.

### If a camera is missing (iPhone / Continuity Camera)

The panel shows a device count under the list. That is the diagnostic: a camera
listed but unticked is a different problem from one the browser never reported.

- **Listed but unticked** — tick it. Unticking is remembered across reconnects.
- **Not listed at all** — the browser is not seeing it, which is an OS or
  browser issue rather than this app. Hit **rescan** first; Continuity Camera
  often joins without firing the `devicechange` event that would refresh the
  list automatically.

For Continuity Camera specifically, macOS requires: same Apple ID on both
devices, Wi-Fi *and* Bluetooth on for both, the iPhone locked and physically
still, and iPhone > Settings > General > AirPlay & Continuity > Continuity
Camera turned on. It also has to be an iPhone XR or newer. Chrome is noticeably
flakier about picking it up than Safari — if it shows in Safari's camera list
but not Chrome's, restarting Chrome usually fixes it.

Also check macOS System Settings > Privacy & Security > Camera and confirm your
browser is allowed.

## How the look is organised

Three independent axes, so the same camera feed never resolves the same way
twice. All three are scheduled off the beat tracker, so changes land on bar
lines instead of arbitrary timers.

**Rigs** (`x`) — which effect passes run and how hard.

| rig | what it is |
| --- | --- |
| `FULL` | everything on |
| `CLEAN` | lets the camera actually read — intros, vocals, crowd shots |
| `SHRED` | heavy sort + aberration + datamosh displace |
| `GHOST` | long spiralling trails, heavy bloom, minimal crush |
| `SCAN` | CCTV read: sobel edges plus the motion grid |
| `MELT` | maximum displace with long trails |
| `STAMP` | hard high-contrast silhouette |

**Palettes** (`p`) — the 3-stop ramp luma gets mapped through. All one colour,
deliberately: `ICE` is the house blue and `DEEP` / `STEEL` / `TAR` are
depth and contrast variations on it, so a change reads as the room getting
colder rather than as a different piece. The auto-picker is weighted toward
`ICE`, and palette is the slowest-moving axis — one change every 50–100s.
Changes crossfade over about a second rather than cutting.

**Panels** (`l`) — no grid. Sources land in irregular overlapping rectangles
that drift, jump on the beat and trail. Max 4, and no single panel may exceed
60% of the frame in either axis.

Every set has a deliberate size hierarchy rather than a row of similar
rectangles: exactly one **HERO** carrying the composition, then **MID**s and
small **ACCENT**s against it. Equal-sized panes read as a contact sheet however
they are placed — the dominant/subordinate relationship is what makes it a
composition. When a 3D world is up it takes the hero slot, because at thumbnail
size every world looks like the same patch of noise.

Presets shift the whole set bigger or smaller while keeping the hierarchy:
`DRIFT` (3, slow), `SWARM` (4), `SLAB` (2 large), `SHARD` (4 small, fast).

**Worlds** (`w` on/off, `W` next) — these get the largest panel in the set
(46-60% of frame) and render at full internal resolution. They were previously
sharing the mask's half-res buffer and landing in a small random panel, which
made every world look like the same patch of noise.

**Worlds** (`w` on/off, `W` next) — raymarched 3D that takes a panel alongside
the cameras. `ROOMS` an endless pillared hall, `TUNNEL`, `ORBIT` a morphing
monolith, `COASTER`, `OCEAN` a shoreline with the swell on one side and calm
sand on the other, `MOUNTAIN` ridged terrain under a hazy sky, `RAIN` columns
of NOMU falling away into perspective. The camera feed is projected onto the
surfaces, so the scenes are lit and textured by what the camera sees.

**ASCII** (`y`) — off, then a density ladder that rebuilds the image out of
characters, then repeating `NOMU` filling the shape with brightness carrying
the picture. Runs before the palette so the type is graded like everything
else.

**Scenes** (`c`) — the composition transform applied to the whole composite:
`DIRECT`, `FLIP`, `KALEIDO-H`, `KALEIDO-V`, `QUAD`, `GRID-4/9/16`, `TUNNEL`, `TRI`,
`SLICE`, `COLUMN`.

`a` toggles auto-scheduling of all three. With it off, you drive.

## Reactive glitch

The effects are not applied at one global strength. Every frame builds a
control mask from the camera composite holding three channels — local detail,
frame-to-frame motion, and a decaying wake behind whatever moved — and the
displace, sort and crush passes each read it.

The result is that damage avoids detail and collects in flat areas and motion
trails. Move a hand and it drags a wake of fine pixel blocks behind it; the
face and the edges stay legible. Block size is continuous in the local energy,
so a single frame holds sizes from 1px up to the current ceiling rather than
one uniform mosaic.

The global half of the correlation is an envelope follower on audio energy
(fast attack, slow release, quantized into six tiers) which sets that ceiling —
quiet passages sit at genuinely crisp 1px, a transient hit opens it to ~9px.

- `j` cycles reactivity 0 / 0.5 / 1. At 0 you get the old uniform behaviour,
  which is worth seeing once for the comparison.
- The mask can be viewed directly for tuning (red detail, green motion, blue
  wake), but it is a diagnostic rather than a look, so it is not on a key —
  set `showMask = true` from the console if you need it.

## Overlay clips

Drop `.mp4` / `.webm` files into `clips/` and list them in
`clips/manifest.json`. They spawn as tiles on the same 12x8 grid as everything
else, over the camera composite, and are graded through the active palette so
they belong to the frame instead of sitting on top of it. See `clips/README.md`
for encoding settings and what kind of footage survives the palette.

## Hotkeys

`?` shows this in-app.

| key | |
| --- | --- |
| `f` | fullscreen |
| `h` | hide / show ALL overlays |
| `i` | hide / show HUD only (keeps nomu + overlays) |
| `\` | **BLACKOUT** (panic) |
| `space` | freeze feedback buffer |
| `r` | reset trails |
| `c` / `C` | next / prev scene |
| `x` / `X` | next / prev rig |
| `p` / `P` | next / prev palette |
| `a` | toggle auto scene+rig+palette |
| `1`–`9` | pick camera |
| `v` | next camera |
| `n` | hold camera (stop auto-cycle) |
| `t` / `T` | tap tempo / release to auto |
| `k` | toggle strobe + invert flashes |
| `[` / `]` | audio gain |
| `←` / `→` | exposure |
| `↑` / `↓` | waveform gain |
| `-` / `=` | render scale (disables auto) |
| `g` | text font mode (BEAT / STROBE / HOLD) |
| `l` / `L` | camera layout / auto-layout |
| `o` | aspect 16:9 (default, full frame) / 2.00 / 2.39 |
| `u` | registration marks |
| `j` | glitch reactivity 0 / .5 / 1 |
| `y` | ascii: off / ramp / nomu |
| `w` / `W` | 3D world on / next world |

The ASCII pass and the 3D worlds are WebGL passes, not DOM layers, so `h`
(hide overlays) does not touch them — they keep running with everything else
stripped away.

Both are auto-scheduled: ASCII comes in for a few bars roughly a third of the
time, and a world panel is up around two thirds of the time. World selection is
weighted — `RAIN` ~27%, `OCEAN` and `MOUNTAIN` ~18% each, the corridors ~9%
each — because uniform random over seven modes let a specific one sit out for
whole songs. Pressing `y`, `w` or `W` yourself parks the scheduler for 16 bars and then
hands control back — it does not switch auto off permanently, because one
exploratory tap used to silently stop ascii and the worlds from ever appearing
again. `a` hands control back immediately.

`k` exists because some venues ask for no strobe. It kills both the white
strobe and the negative flashes.

## Performance

Internal buffers run at up to 1920×1080. Measured frame time walks the
resolution down through 85/70/60/50% if the GPU can't hold 60fps, and back up
when it can. `-` / `=` overrides it manually. The scale and fps readouts are in
the HUD.

The lighter rigs are genuinely cheaper — a skipped pass is skipped, not
run at zero strength.

## Files

| | |
| --- | --- |
| `index.html` | markup, styles, SVG filters for the DOM overlays |
| `shaders.js` | all GLSL |
| `app.js` | everything else |
| `nomu_gifs/` | the floating GIF tiles |
| `clips/` | your overlay footage + its manifest |

## Things that are deliberately not here

- **Hard binary block patterns.** The motion wake used to be drawn as
  `step(0.55, hash)` per block, a coin flip that lit half the blocks solid
  white and read as a QR code. It now feeds the bloom bright-pass, so movement
  glows instead.
- **A low bit-depth floor.** The crush bottoms out at 30 levels, not 8. At 8
  the ordered dither amplitude is 1/8, enough to flip neighbouring pixels
  between black and white and checkerboard every flat area.
- **Grids.** No tiling scenes, and panels cap at 4 with raised minimum sizes —
  five small frames read as a thumbnail grid however they are placed.
- **A second grain layer.** There used to be a DOM `#grain-overlay` on top of
  everything at `mix-blend-mode: overlay`. Overlay blending is a contrast
  amplifier, so random noise through it snapped hard to black and white and
  covered the frame in speckle. Grain now happens only in the film pass, where
  it is luma-weighted and inside the graded image.

## Verifying a change

`node --check` is not verification for this project — it catches syntax, not
`ReferenceError`. Serve the page, open the console and paste `smoke-test.js`:
it stubs the media APIs, clicks the real start button, runs the loop, exercises
every world, preset and hotkey, and asserts frames actually rendered with no
errors. Front the browser tab first — a hidden tab pauses
`requestAnimationFrame` and the frame assertion will fail for that reason
alone.

## Known rough edges

- `nomu_gifs/` is ~160MB of animated GIFs decoded on the CPU. Converting them to
  WebM and sampling them as WebGL textures would cut the repo by ~10× and let
  them run through the palette chain instead of being colour-graded by an
  approximate SVG filter.
- The beat tracker needs a few seconds of steady kick to lock. Tap tempo (`t`)
  is the reliable override for sparse intros.
