// Smoke test: stub media, click start, run the real loop, assert it renders.
// Catches "identifier is not defined" bugs that syntax checks cannot.
const errs = [];
window.addEventListener('error', e => errs.push(String(e.message)));
window.addEventListener('unhandledrejection', e =>
  errs.push('reject: ' + String((e.reason && e.reason.message) || e.reason)));

const mk = () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const cx = c.getContext('2d'); let f = 0;
  setInterval(() => { f++;
    cx.fillStyle = '#2b2b33'; cx.fillRect(0,0,1280,720);
    cx.fillStyle = '#ddd';
    cx.beginPath(); cx.ellipse(640+Math.sin(f/20)*200,300,95,130,0,0,7); cx.fill();
    cx.fillRect(555+Math.sin(f/20)*200,430,170,290);
  }, 16);
  return c.captureStream(30);
};
navigator.mediaDevices.enumerateDevices = async () => ([
  {deviceId:'a',kind:'videoinput',label:'Cam A'},
  {deviceId:'b',kind:'videoinput',label:'Cam B'},
  {deviceId:'m',kind:'audioinput',label:'Mic'}]);
navigator.mediaDevices.getUserMedia = async (c) => {
  if (c && c.audio && !c.video) {
    const ac = new AudioContext(); const d = ac.createMediaStreamDestination();
    const o = ac.createOscillator(); o.connect(d); o.start(); return d.stream;
  }
  return mk();
};
await refreshDevices();
document.getElementById('start').click();
await new Promise(r => setTimeout(r, 2000));
const baseFrames = frameCount;

// exercise every world, every scatter preset, every hotkey
worldEnabled = true; reconcileLayout();
for (let m = 0; m < WORLD_MODES.length; m++) {
  worldMode = m;
  for (let i = 0; i < 12; i++) await new Promise(r => requestAnimationFrame(r));
}
worldEnabled = false; reconcileLayout();
for (const n of layoutsFor()) {
  setLayout(n);
  for (let i = 0; i < 8; i++) await new Promise(r => requestAnimationFrame(r));
}
for (const k of ['w','W','w','l','o','u','j','c','x','p','g','v','n','d','d','a','r','k','t','[',']']) {
  window.dispatchEvent(new KeyboardEvent('keydown', {key:k}));
  await new Promise(r => setTimeout(r, 40));
}
await new Promise(r => setTimeout(r, 800));

// help sheet must document every hotkey — it silently drifted out of date once
const src = await (await fetch('app.js')).text();
const handled = new Set();
const re = /k === '((?:\\\\|[^'])+)'/g;
let m; while ((m = re.exec(src))) handled.add(m[1].replace('\\\\', '\\'));
const ALIASES = ['/','V','[',']','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','-','=','+'];
const undocumented = [...handled]
  .filter(k => !HELP_KEYS.includes(k) && !/^[0-9]$/.test(k) && !ALIASES.includes(k));

const uniq = [...new Set(errs)];
({
  PASS: uniq.length === 0 && frameCount > baseFrames && baseFrames > 0
        && undocumented.length === 0,
  undocumentedHotkeys: undocumented,
  framesAfterStart: baseFrames,
  framesTotal: frameCount,
  fps: +(1000/frameMsEMA).toFixed(0),
  cams: cams.length, panels: panels.length,
  glErr: gl.getError(),
  uniqueErrors: uniq,
});
