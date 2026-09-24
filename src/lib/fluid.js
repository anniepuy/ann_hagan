// src/lib/fluid.js
// GPU fluid simulation (Stam "Stable Fluids"), vendored as a library.
//   initFluid(canvas, { pointerTarget, config })
// Each frame, on the GPU (textures = grids):
//   advect velocity → add swirl (low) → pressure solve → subtract gradient
//   → advect dye (color) → display (tone-mapped so it never hits white).
// Pointer "splats" inject velocity + color; dissipation lets it settle.

export function initFluid(canvas, options = {}) {
  const pointerTarget = options.pointerTarget || canvas;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const cfg = Object.assign(
    {
      SIM_RESOLUTION: 128,        // velocity grid
      DYE_RESOLUTION: 512,        // color grid (higher = crisper)
      DENSITY_DISSIPATION: 0.35,  // color fade (low = lingers)
      VELOCITY_DISSIPATION: 1.9,  // motion calm-down (higher = calmer)
      PRESSURE: 0.8,
      PRESSURE_ITERATIONS: 20,
      CURL: 2.0,                  // swirl (low = smooth, not jittery)
      SPLAT_RADIUS: 0.3,          // size of each mouse dab
      SPLAT_FORCE: 3000,          // push strength (gentle)
      VEL_CLAMP: 190,             // caps flick speed → stays relaxing
      COLOR_INTENSITY: 0.5,       // dye brightness (moderate = readable text)
    },
    options.config || {}
  );

  const gl =
    canvas.getContext("webgl", { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false }) ||
    canvas.getContext("experimental-webgl");
  if (!gl) { console.warn("[fluid] WebGL unavailable"); return; }

  const halfFloat = gl.getExtension("OES_texture_half_float");
  const supportLinear = gl.getExtension("OES_texture_half_float_linear");
  if (!halfFloat) { console.warn("[fluid] half-float unsupported"); return; }
  const TYPE = halfFloat.HALF_FLOAT_OES;
  const FILTER = supportLinear ? gl.LINEAR : gl.NEAREST;

  // ---------------- shaders ----------------
  const baseVert = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main(){
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;
  const clearFrag = `
    precision mediump float; varying vec2 vUv;
    uniform sampler2D uTexture; uniform float value;
    void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`;
  const splatFrag = `
    precision highp float; varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio;
    uniform vec3 color; uniform vec2 point; uniform float radius;
    void main(){
      vec2 p = vUv - point.xy; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
    }`;
  const advectionFrag = `
    precision highp float; varying vec2 vUv;
    uniform sampler2D uVelocity, uSource;
    uniform vec2 texelSize, dyeTexelSize;
    uniform float dt, dissipation;
    vec4 bilerp(sampler2D s, vec2 uv, vec2 ts){
      vec2 st = uv / ts - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);
      vec4 a = texture2D(s,(iuv+vec2(0.5,0.5))*ts), b = texture2D(s,(iuv+vec2(1.5,0.5))*ts);
      vec4 c = texture2D(s,(iuv+vec2(0.5,1.5))*ts), d = texture2D(s,(iuv+vec2(1.5,1.5))*ts);
      return mix(mix(a,b,fuv.x), mix(c,d,fuv.x), fuv.y);
    }
    void main(){
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
      gl_FragColor = result / (1.0 + dissipation * dt);
    }`;
  const divergenceFrag = `
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity;
    void main(){
      float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;  if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;  if (vB.y < 0.0) B = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`;
  const curlFrag = `
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity;
    void main(){
      float L = texture2D(uVelocity, vL).y, R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x, B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`;
  const vorticityFrag = `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity, uCurl; uniform float curl, dt;
    void main(){
      float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(clamp(vel + force * dt, -1000.0, 1000.0), 0.0, 1.0);
    }`;
  const pressureFrag = `
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uDivergence;
    void main(){
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      float div = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
    }`;
  const gradientFrag = `
    precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uVelocity;
    void main(){
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      vec2 vel = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(vel - vec2(R - L, T - B), 0.0, 1.0);
    }`;
  const displayFrag = `
    precision highp float; varying vec2 vUv;
    uniform sampler2D uTexture;
    void main(){
      vec3 c = texture2D(uTexture, vUv).rgb;
      c = c / (1.0 + c);                         // Reinhard tone map → never pure white
      vec3 bg = mix(vec3(0.043,0.031,0.070), vec3(0.086,0.059,0.133), vUv.y);
      gl_FragColor = vec4(bg + c * 0.9, 1.0);    // dye over the dark sidebar
    }`;

  // ---------------- gl helpers ----------------
  function compile(type, src, kw) {
    if (kw) src = kw.map((k) => "#define " + k + "\n").join("") + src;
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
    return s;
  }
  function Program(vs, fs, kw) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, kw));
    gl.bindAttribLocation(p, 0, "aPosition");
    gl.linkProgram(p);
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
    return { program: p, uniforms: u, bind() { gl.useProgram(p); } };
  }
  const manual = supportLinear ? null : ["MANUAL_FILTERING"];
  const P_ = {
    clear: Program(baseVert, clearFrag), splat: Program(baseVert, splatFrag),
    advection: Program(baseVert, advectionFrag, manual),
    divergence: Program(baseVert, divergenceFrag), curl: Program(baseVert, curlFrag),
    vorticity: Program(baseVert, vorticityFrag), pressure: Program(baseVert, pressureFrag),
    gradient: Program(baseVert, gradientFrag), display: Program(baseVert, displayFrag),
  };

  let blit;
  (function setupBlit() {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    blit = (t) => {
      if (t == null) { gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
      else { gl.viewport(0,0,t.width,t.height); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  function createFBO(w, h, param) {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, TYPE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture: tex, fbo, width: w, height: h, texelSizeX: 1/w, texelSizeY: 1/h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  }
  function createDouble(w, h, param) {
    let a = createFBO(w, h, param), b = createFBO(w, h, param);
    return { width: w, height: h, texelSizeX: 1/w, texelSizeY: 1/h,
      get read() { return a; }, set read(v) { a = v; },
      get write() { return b; }, set write(v) { b = v; },
      swap() { const t = a; a = b; b = t; } };
  }
  function resolution(res) {
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1 / ar;
    const min = Math.round(res), max = Math.round(res * ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  let dye, velocity, divergence, curl, pressure;
  function initFBOs() {
    const sim = resolution(cfg.SIM_RESOLUTION), dyeR = resolution(cfg.DYE_RESOLUTION);
    dye = createDouble(dyeR.width, dyeR.height, FILTER);
    velocity = createDouble(sim.width, sim.height, FILTER);
    divergence = createFBO(sim.width, sim.height, gl.NEAREST);
    curl = createFBO(sim.width, sim.height, gl.NEAREST);
    pressure = createDouble(sim.width, sim.height, gl.NEAREST);
  }

  // ---------------- sizing ----------------
  let W = 0, H = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    W = r.width; H = r.height;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    initFBOs();
  }

  // ---------------- simulation step ----------------
  function step(dt) {
    gl.disable(gl.BLEND);
    P_.curl.bind();
    gl.uniform2f(P_.curl.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.curl.uniforms.uVelocity, velocity.read.attach(0)); blit(curl);

    P_.vorticity.bind();
    gl.uniform2f(P_.vorticity.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.vorticity.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P_.vorticity.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(P_.vorticity.uniforms.curl, cfg.CURL);
    gl.uniform1f(P_.vorticity.uniforms.dt, dt); blit(velocity.write); velocity.swap();

    P_.divergence.bind();
    gl.uniform2f(P_.divergence.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.divergence.uniforms.uVelocity, velocity.read.attach(0)); blit(divergence);

    P_.clear.bind();
    gl.uniform1i(P_.clear.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(P_.clear.uniforms.value, cfg.PRESSURE); blit(pressure.write); pressure.swap();

    P_.pressure.bind();
    gl.uniform2f(P_.pressure.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.pressure.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < cfg.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(P_.pressure.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    P_.gradient.bind();
    gl.uniform2f(P_.gradient.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.gradient.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(P_.gradient.uniforms.uVelocity, velocity.read.attach(1)); blit(velocity.write); velocity.swap();

    P_.advection.bind();
    gl.uniform2f(P_.advection.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!supportLinear) gl.uniform2f(P_.advection.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P_.advection.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P_.advection.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(P_.advection.uniforms.dt, dt);
    gl.uniform1f(P_.advection.uniforms.dissipation, cfg.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    if (!supportLinear) gl.uniform2f(P_.advection.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(P_.advection.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P_.advection.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(P_.advection.uniforms.dissipation, cfg.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }
  function render() {
    gl.disable(gl.BLEND);
    P_.display.bind();
    gl.uniform1i(P_.display.uniforms.uTexture, dye.read.attach(0)); blit(null);
  }

  // ---------------- splats (mouse) ----------------
  function correctRadius(r) { const ar = canvas.width / canvas.height; return ar > 1 ? r * ar : r; }
  function splat(x, y, dx, dy, color) {
    P_.splat.bind();
    gl.uniform1i(P_.splat.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(P_.splat.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(P_.splat.uniforms.point, x, y);
    gl.uniform3f(P_.splat.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(P_.splat.uniforms.radius, correctRadius(cfg.SPLAT_RADIUS / 100));
    blit(velocity.write); velocity.swap();
    gl.uniform1i(P_.splat.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(P_.splat.uniforms.color, color.r, color.g, color.b); blit(dye.write); dye.swap();
  }
  const PAL = [[1.0,0.36,0.62],[0.62,0.36,1.0],[0.22,0.88,0.82],[1.0,0.75,0.40]]; // rose, violet, teal, amber
  function colorAt(t) {
    const s = (((t * 0.05) % 1) + 1) % 1 * PAL.length;
    const i = Math.floor(s) % PAL.length, j = (i + 1) % PAL.length, k = s - Math.floor(s);
    const a = PAL[i], b = PAL[j], m = cfg.COLOR_INTENSITY;
    return { r:(a[0]+(b[0]-a[0])*k)*m, g:(a[1]+(b[1]-a[1])*k)*m, b:(a[2]+(b[2]-a[2])*k)*m };
  }

  const pt = { x: 0, y: 0, over: false };
  function splatPointer() {
    const cl = cfg.VEL_CLAMP;
    const dx = Math.max(-cl, Math.min(cl, (pt.vx / W) * cfg.SPLAT_FORCE));
    const dy = Math.max(-cl, Math.min(cl, -(pt.vy / H) * cfg.SPLAT_FORCE));
    splat(pt.x / W, 1 - pt.y / H, dx, dy, colorAt(performance.now() * 0.001));
  }
  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const nx = e.clientX - r.left, ny = e.clientY - r.top;
    pt.vx = nx - pt.x; pt.vy = ny - pt.y; pt.x = nx; pt.y = ny; pt.over = true;
    if (!reduce) splatPointer();
  }
  pointerTarget.addEventListener("pointermove", onMove);
  pointerTarget.addEventListener("pointerdown", onMove);
  pointerTarget.addEventListener("pointerleave", () => { pt.over = false; });

  // ---------------- boot + loop ----------------
  resize();
  new ResizeObserver(resize).observe(canvas);

  // a soft resting bloom so the sidebar isn't empty; then it settles on its own
  (function bloom() {
    [[0.5,0.72],[0.4,0.46],[0.6,0.28]].forEach((p, idx) => {
      const c = colorAt(idx * 1.6);
      splat(p[0], p[1], (Math.random()-0.5)*30, (Math.random()-0.5)*30, { r:c.r*1.6, g:c.g*1.6, b:c.b*1.6 });
    });
  })();

  let running = true, lastTime = 0;
  function loop(now) {
    if (!running) return;
    let dt = lastTime ? (now - lastTime) / 1000 : 0.016;
    dt = Math.min(dt, 0.0166); lastTime = now;
    step(dt); render();
    if (!reduce) requestAnimationFrame(loop);
  }
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && !reduce) { lastTime = 0; requestAnimationFrame(loop); }
  });
  if (reduce) { for (let i = 0; i < 40; i++) step(0.016); render(); } // static settled frame
  else requestAnimationFrame(loop);
}


