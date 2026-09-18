/**
 * Ink on Click
 * Click and drag watercolor ink for the web. WebGL2, no dependencies.
 *
 *   import { createInk } from "./ink.js";
 *   const ink = createInk(document.querySelector("canvas"), { size: 23 });
 *   ink.set({ mode: "custom", colors: ["#ff2d55", "#1e6bff"] });
 *
 * MIT License
 */

export const defaults = Object.freeze({
  // Brush
  size: 23,            // brush radius in CSS pixels
  inkAmount: 1.8,      // ink dropped per stroke step
  holdInk: 1.05,       // ink added while the pointer is held still
  flow: 0,             // how much a fast drag pushes the ink around
  // Spread
  bloom: 1.2,          // how far wet ink creeps outward
  spreadSpeed: 0.55,   // how fast it creeps
  edgeRoughness: 0.85, // how much the paper grain breaks up the edge
  edgeSoftness: 0.89,  // blending inside the stain
  grain: 8,            // scale of the edge detail, higher is finer
  turbulence: 2.25,    // billowing motion inside the ink
  swirl: 23,           // curl and eddies
  // Fade
  fadeSpeed: 0.22,     // how quickly ink washes back to the background
  settle: 6,           // how quickly motion calms down
  // Color
  mode: "rainbow",     // "rainbow" or "custom"
  colors: ["#ff2d55", "#ffb800"], // used in custom mode, any CSS colors
  hueSpeed: 2.35,      // how fast color moves while dragging
  newHueEachClick: true, // each click starts at a random color
  saturation: 0.9,
  depth: 1,            // overall ink strength
  // Scene
  background: "#ffffff",
  quality: "high",     // "low", "medium" or "high"
  interactive: true,   // listen to pointer events on the canvas
  maxPixelRatio: 2,
});

const QUALITY = { low: [96, 512], medium: [128, 768], high: [160, 1152] };

/**
 * Start the ink effect on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Partial<typeof defaults>} options
 */
export function createInk(canvas, options = {}) {
  const P = { ...defaults, ...options };
  P.colors = [...(options.colors || defaults.colors)];

  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error("Ink on Click needs WebGL2.");
  const canRenderFloat = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
  gl.getExtension("OES_texture_float_linear");
  const IFMT = canRenderFloat ? gl.RGBA16F : gl.RGBA8;
  const TYPE = canRenderFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  const VS = `#version 300 es
  precision highp float;
  in vec2 aPos;
  uniform vec2 texel;
  out vec2 vUv, vL, vR, vT, vB;
  void main(){
    vUv = aPos * 0.5 + 0.5;
    vL = vUv - vec2(texel.x, 0.0); vR = vUv + vec2(texel.x, 0.0);
    vT = vUv + vec2(0.0, texel.y); vB = vUv - vec2(0.0, texel.y);
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  const NOISE = `
  float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
    for(int i=0;i<5;i++){ v += a*vnoise(p); p = r*p*2.03 + 17.1; a *= 0.5; }
    return v / 0.96875;
  }`;

  const FS = {
    splat: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTarget;
    uniform float aspect, radius, amt;
    uniform vec2 point;
    uniform vec3 value;
    uniform int mode;
    void main(){
      vec2 p = vUv - point; p.x *= aspect;
      float g = exp(-dot(p,p) / radius);
      vec4 base = texture(uTarget, vUv);
      if (mode == 0) {
        o = vec4(min(base.rgb + value * g, vec3(1.1)), min(base.a + amt * g, 2.0));
      } else {
        o = vec4(base.xy + value.xy * g, 0.0, 1.0);
      }
    }`,
    advect: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uVelocity, uSource;
    uniform vec2 simTexel;
    uniform float dt, dissipation;
    void main(){
      vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * simTexel;
      o = texture(uSource, coord) / (1.0 + dissipation * dt);
    }`,
    curl: `#version 300 es
    precision highp float;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;
    uniform sampler2D uVelocity;
    void main(){
      float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
      o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,
    vorticity: `#version 300 es
    precision highp float;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;
    uniform sampler2D uVelocity, uCurl, uDye;
    uniform float curl, dt, turbulence, grain, aspect, time;
    ${NOISE}
    void main(){
      float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      f /= length(f) + 1e-4;
      f *= curl * C; f.y *= -1.0;
      // curl noise turbulence where ink lives, gives the billowing edge
      float ink = texture(uDye, vUv).a;
      vec2 q = vUv * vec2(aspect, 1.0) * grain * 0.35 + vec2(0.0, time * 0.03);
      float e = 0.01;
      float n1 = fbm(q + vec2(0.0, e)), n2 = fbm(q - vec2(0.0, e));
      float n3 = fbm(q + vec2(e, 0.0)), n4 = fbm(q - vec2(e, 0.0));
      vec2 cn = vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
      f += cn * turbulence * 6.0 * smoothstep(0.0, 0.4, ink);
      vec2 v = texture(uVelocity, vUv).xy + f * dt;
      o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
    }`,
    divergence: `#version 300 es
    precision highp float;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;
    uniform sampler2D uVelocity;
    void main(){
      float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
      o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,
    clearP: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTexture; uniform float value;
    void main(){ o = value * texture(uTexture, vUv); }`,
    pressure: `#version 300 es
    precision highp float;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;
    uniform sampler2D uPressure, uDivergence;
    void main(){
      float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
      float d = texture(uDivergence, vUv).x;
      o = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
    }`,
    gradient: `#version 300 es
    precision highp float;
    in vec2 vUv, vL, vR, vT, vB; out vec4 o;
    uniform sampler2D uPressure, uVelocity;
    void main(){
      float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
      vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
      o = vec4(v, 0.0, 1.0);
    }`,
    // watercolor bloom: wet ink creeps outward, the paper grain blocks it in places,
    // which gives the lobed cauliflower edge
    spread: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uDye, uPaper;
    uniform vec2 texel;
    uniform float keep, rough, reach, th, blur, seed;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
    void main(){
      vec4 c = texture(uDye, vUv);
      float ang = h(gl_FragCoord.xy) * 0.785398;
      vec4 best = c, sum = vec4(0.0);
      for (int i = 0; i < 8; i++) {
        float a = ang + float(i) * 0.785398;
        vec4 n = texture(uDye, vUv + vec2(cos(a), sin(a)) * texel * reach);
        sum += n;
        if (n.a > best.a) best = n;
      }
      float mask = texture(uPaper, vUv).r;
      float k = keep * mix(1.0, mix(0.9, 1.0, mask), rough);
      vec4 g = best * k;
      vec4 res = c;
      if (g.a > th && g.a > c.a) res = max(c, g);
      // gentle mixing inside the stain so overlapping colors blend
      if (c.a > th * 0.5) res = mix(res, sum / 8.0, blur);
      o = res;
    }`,
    paper: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform float grain, aspect;
    ${NOISE}
    void main(){
      vec2 q = vUv * vec2(aspect, 1.0) * grain;
      float paper = fbm(q) * 0.55 + fbm(q * 3.3 + 5.3) * 0.3 + fbm(q * 9.1 + 2.7) * 0.15;
      o = vec4(smoothstep(0.34, 0.66, paper), 0.0, 0.0, 1.0);
    }`,
    display: `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uDye;
    uniform vec3 bg;
    uniform float depth;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec3 A = max(texture(uDye, vUv).rgb, 0.0);
      vec3 col = bg * exp(-A * depth * 3.5);
      col += (h(gl_FragCoord.xy) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`,
  };


  /* ---------- GL helpers ---------- */
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VS);
  function program(fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  const prog = {}; for (const k in FS) prog[k] = program(FS[k]);

  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const targets = [];
  function fbo(w, h, filter) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, IFMT, w, h, 0, gl.RGBA, TYPE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const t = { tex, fb, w, h, tx: 1 / w, ty: 1 / h,
      attach(i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); return i; } };
    targets.push(t); return t;
  }
  function double(w, h, filter) {
    let a = fbo(w, h, filter), b = fbo(w, h, filter);
    return { w, h, tx: 1 / w, ty: 1 / h,
      get read() { return a; }, get write() { return b; }, swap() { const t = a; a = b; b = t; } };
  }
  function freeTargets() {
    for (const t of targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    targets.length = 0;
  }

  let dye, velocity, divergence, curlT, pressure, paperT, paperKey = "", builtQuality = "";
  function res(base) {
    const ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const min = Math.round(base), max = Math.round(base * (ar < 1 ? 1 / ar : ar));
    return ar > 1 ? [max, min] : [min, max];
  }
  function initTargets() {
    freeTargets();
    const [simBase, dyeBase] = QUALITY[String(P.quality).toLowerCase()] || QUALITY.high;
    const [sw, sh] = res(simBase), [dw, dh] = res(dyeBase);
    dye = double(dw, dh, gl.LINEAR); velocity = double(sw, sh, gl.LINEAR);
    divergence = fbo(sw, sh, gl.NEAREST); curlT = fbo(sw, sh, gl.NEAREST);
    pressure = double(sw, sh, gl.NEAREST); paperT = fbo(dw, dh, gl.LINEAR);
    paperKey = ""; builtQuality = String(P.quality).toLowerCase();
  }
  function blit(target) {
    if (target) { gl.viewport(0, 0, target.w, target.h); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); }
    else { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function use(pr, texel) { gl.useProgram(pr.p); if (pr.u.texel && texel) gl.uniform2f(pr.u.texel, texel[0], texel[1]); return pr.u; }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, P.maxPixelRatio);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h || !dye) { canvas.width = w; canvas.height = h; initTargets(); }
  }
  function paintPaper() {
    const key = P.grain + "|" + canvas.width + "x" + canvas.height;
    if (key === paperKey) return;
    const u = use(prog.paper);
    gl.uniform1f(u.grain, P.grain); gl.uniform1f(u.aspect, canvas.width / canvas.height);
    blit(paperT); paperKey = key;
  }

  /* ---------- color ---------- */
  function hsl(h, s, l) {
    const k = n => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  const colorCache = new Map();
  const cctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function parseColor(str) {
    if (colorCache.has(str)) return colorCache.get(str);
    cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = "#000"; cctx.fillStyle = str || "#000";
    cctx.fillRect(0, 0, 1, 1);
    const d = cctx.getImageData(0, 0, 1, 1).data;
    const rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
    colorCache.set(str, rgb); return rgb;
  }
  const isCustom = () => String(P.mode).toLowerCase() === "custom" && P.colors && P.colors.length > 0;
  function currentRgb(h) {
    if (!isCustom()) return hsl(h, P.saturation, 0.5);
    const cols = P.colors.map(parseColor);
    // blend smoothly through the palette while dragging
    const pos = h * cols.length, i = Math.floor(pos) % cols.length, f = pos - Math.floor(pos);
    const a = cols[i], b = cols[(i + 1) % cols.length];
    const e = f * f * (3 - 2 * f);
    const c = a.map((v, k) => v + (b[k] - v) * e);
    const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, s = P.saturation / 0.9;
    return c.map(v => Math.min(1, Math.max(0, lum + (v - lum) * s)));
  }
  function absorb(h) {
    // pigment absorbance, so overlapping colors mix like real ink
    const a = currentRgb(h).map(v => -Math.log(Math.max(v, 0.05)));
    if (isCustom()) return a.map(v => v / 3.0 * 0.55);
    const m = Math.max(a[0], a[1], a[2], 1e-3);
    return a.map(v => v / m * 0.55);
  }

  /* ---------- input ---------- */
  const pointer = { down: false, x: 0, y: 0 };
  let hue = Math.random();
  const queue = [];

  function toUv(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }
  function onDown(e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = toUv(e);
    pointer.down = true; pointer.x = x; pointer.y = y;
    if (P.newHueEachClick) hue = (hue + 0.25 + Math.random() * 0.5) % 1;
    queue.push({ x, y, dx: 0, dy: 0, amt: 1 });
  }
  function onMove(e) {
    if (!pointer.down) return;
    const [x, y] = toUv(e);
    const r = canvas.getBoundingClientRect();
    const dist = Math.hypot((x - pointer.x) * r.width, (y - pointer.y) * r.height);
    if (dist < 0.5) return;
    // fill the path so fast strokes stay continuous
    const stepPx = Math.max(2, P.size * 0.35);
    const n = Math.min(24, Math.ceil(dist / stepPx));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      queue.push({ x: pointer.x + (x - pointer.x) * t, y: pointer.y + (y - pointer.y) * t,
                   dx: (x - pointer.x) / n, dy: (y - pointer.y) / n, amt: Math.min(1, dist / n / stepPx) });
    }
    hue = (hue + dist * P.hueSpeed * 0.00045) % 1;
    pointer.x = x; pointer.y = y;
  }
  function onUp() { pointer.down = false; }
  let listening = false;
  function listen(on) {
    if (on === listening) return;
    const m = on ? "addEventListener" : "removeEventListener";
    canvas[m]("pointerdown", onDown); canvas[m]("pointermove", onMove);
    canvas[m]("pointerup", onUp); canvas[m]("pointercancel", onUp);
    canvas.style.touchAction = on ? "none" : "";
    listening = on;
  }

  function splat(s, hold) {
    const aspect = canvas.width / canvas.height;
    const radius = Math.pow(P.size / Math.max(1, canvas.clientHeight), 2) * 0.5;
    let u;
    if (hold === undefined && P.flow > 0) {
      u = use(prog.splat, [velocity.tx, velocity.ty]);
      gl.uniform1i(u.uTarget, velocity.read.attach(0));
      gl.uniform1f(u.aspect, aspect); gl.uniform1f(u.radius, radius * 2.0);
      gl.uniform2f(u.point, s.x, s.y); gl.uniform1i(u.mode, 1);
      const F = 1400 * P.flow;
      gl.uniform3f(u.value, s.dx * F, s.dy * F, 0);
      blit(velocity.write); velocity.swap();
    }
    u = use(prog.splat, [dye.tx, dye.ty]);
    gl.uniform1i(u.uTarget, dye.read.attach(0));
    gl.uniform1f(u.aspect, aspect); gl.uniform1f(u.radius, radius);
    gl.uniform2f(u.point, s.x, s.y); gl.uniform1i(u.mode, 0);
    const a = absorb(hue);
    const k = P.inkAmount * (hold !== undefined ? hold : (0.55 + 0.45 * s.amt));
    // rgb holds pigment absorbance, alpha holds how wet the ink is
    gl.uniform3f(u.value, a[0] * k, a[1] * k, a[2] * k);
    gl.uniform1f(u.amt, k);
    blit(dye.write); dye.swap();
  }

  /* ---------- simulation ---------- */
  let time = 0;
  function step(dt) {
    const aspect = canvas.width / canvas.height;
    const vt = [velocity.tx, velocity.ty];

    let u = use(prog.curl, vt);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0)); blit(curlT);

    u = use(prog.vorticity, vt);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uCurl, curlT.attach(1));
    gl.uniform1i(u.uDye, dye.read.attach(2));
    gl.uniform1f(u.curl, P.swirl); gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.turbulence, P.turbulence); gl.uniform1f(u.grain, P.grain);
    gl.uniform1f(u.aspect, aspect); gl.uniform1f(u.time, time);
    blit(velocity.write); velocity.swap();

    u = use(prog.divergence, vt);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0)); blit(divergence);

    u = use(prog.clearP, vt);
    gl.uniform1i(u.uTexture, pressure.read.attach(0)); gl.uniform1f(u.value, 0.8);
    blit(pressure.write); pressure.swap();

    u = use(prog.pressure, vt);
    gl.uniform1i(u.uDivergence, divergence.attach(0));
    for (let i = 0; i < 20; i++) {
      gl.uniform1i(u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    u = use(prog.gradient, vt);
    gl.uniform1i(u.uPressure, pressure.read.attach(0));
    gl.uniform1i(u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    u = use(prog.advect, vt);
    gl.uniform2f(u.simTexel, velocity.tx, velocity.ty);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, velocity.read.attach(0));
    gl.uniform1f(u.dt, dt); gl.uniform1f(u.dissipation, P.settle);
    blit(velocity.write); velocity.swap();

    u = use(prog.advect, [dye.tx, dye.ty]);
    gl.uniform2f(u.simTexel, velocity.tx, velocity.ty);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, dye.read.attach(1));
    gl.uniform1f(u.dt, dt); gl.uniform1f(u.dissipation, P.fadeSpeed);
    blit(dye.write); dye.swap();

    // watercolor bloom, several passes per frame at dye resolution
    const passes = Math.max(1, Math.min(8, Math.round(3 * dt * 60)));
    paintPaper();
    u = use(prog.spread, [dye.tx, dye.ty]);
    gl.uniform1f(u.keep, Math.exp(-1 / (10 + P.bloom * 90)));
    gl.uniform1f(u.rough, P.edgeRoughness);
    gl.uniform1f(u.th, 0.05);
    gl.uniform1f(u.blur, P.edgeSoftness * 0.25);
    gl.uniform1i(u.uPaper, paperT.attach(1));
    gl.uniform1f(u.reach, Math.max(1, dye.h / 520) * (0.4 + P.spreadSpeed * 1.2));
    for (let i = 0; i < passes; i++) {
      gl.uniform1f(u.seed, (time * 17.0 + i * 3.1) % 100);
      gl.uniform1i(u.uDye, dye.read.attach(0));
      blit(dye.write); dye.swap();
    }
  }

  function render() {
    const u = use(prog.display);
    gl.uniform1i(u.uDye, dye.read.attach(0));
    const bg = parseColor(P.background);
    gl.uniform3f(u.bg, bg[0], bg[1], bg[2]);
    gl.uniform1f(u.depth, P.depth);
    blit(null);
  }

  function clear() {
    for (const t of targets) {
      if (t === paperT) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.w, t.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /* ---------- loop ---------- */
  let raf = 0, last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now; time += dt;
    resize();
    while (queue.length) splat(queue.shift());
    if (pointer.down && P.holdInk > 0) splat({ x: pointer.x, y: pointer.y, dx: 0, dy: 0, amt: 0 }, P.holdInk * dt * 4);
    step(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  resize();
  listen(P.interactive);
  raf = requestAnimationFrame(frame);

  return {
    /** Update any options live. */
    set(next = {}) {
      Object.assign(P, next);
      if (next.colors) P.colors = [...next.colors];
      if ("interactive" in next) listen(!!next.interactive);
      if ("quality" in next && String(P.quality).toLowerCase() !== builtQuality) initTargets();
      if ("maxPixelRatio" in next) resize();
    },
    /** Current options. */
    get options() { return { ...P, colors: [...P.colors] }; },
    /** Wipe all ink. */
    clear,
    /** Drop ink from code. x and y are 0 to 1 from the top left. */
    drop(x, y, amount = 1) { queue.push({ x, y: 1 - y, dx: 0, dy: 0, amt: Math.max(0, Math.min(1, amount)) }); },
    /** Stop the loop and free GPU memory. */
    destroy() {
      cancelAnimationFrame(raf); listen(false); freeTargets();
      for (const k in prog) gl.deleteProgram(prog[k].p);
      gl.deleteBuffer(vbo);
    },
  };
}
