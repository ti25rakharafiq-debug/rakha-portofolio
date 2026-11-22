/*
 * scene3d.js  |  Three.js r128
 * ---------------------------------------------------------------------------
 * 2.5D / 3D Multi-Layer Parallax Diorama  (gaya Kage - threeui.com)
 *
 * Empat ilustrasi disusun sebagai bidang THREE.PlaneGeometry pada kedalaman
 * sumbu Z yang berbeda. Kamera perspektif bergerak MAJU menembus ruang 3D
 * mengikuti scroll halaman sehingga jarak antar-layer terasa nyata:
 *
 *      Z = -40   layer1-sky.jpg         langit, matahari, awan      (paling jauh)
 *      Z = -25   layer2-torii.jpg       gerbang Torii + pulau karang
 *      Z = -12   layer3-ocean.jpg       gelombang laut
 *      Z =  -4   layer4-foreground.jpg  batu karang + rumput pantai (paling dekat)
 *
 * Kebutuhan HTML:
 *   <canvas id="bg-3d"></canvas>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
 *   <script src="scene3d.js"></script>      (dimuat SETELAH three.min.js)
 *
 * Kebutuhan berkas (relatif terhadap halaman HTML):
 *   assets/layer1-sky.jpg.jpg   assets/layer2-torii.jpg.jpg
 *   assets/layer3-ocean.jpg.jpg assets/layer4-foreground.jpg.jpg
 *
 * PENTING: buka lewat server lokal (http://localhost/...), BUKAN file://.
 * Browser memblokir tekstur WebGL dari file:// (aturan keamanan CORS).
 * Halaman juga harus bisa di-scroll (tinggi konten > tinggi layar).
 *
 * Teknik utama
 *  - Alpha keying: layer 2-4 berlatar hitam diproses SEKALI saat dimuat
 *    (canvas 2D, di CPU) menjadi tekstur RGBA premultiplied. Area hitam
 *    menjadi 100% transparan tanpa pinggiran abu-abu, bintik noise JPG
 *    dibuang, dan area gelap DI DALAM objek (retakan batu) tetap opak.
 *    Jika canvas ter-taint, otomatis jatuh ke keying luminance di shader.
 *  - Semua layer diselaraskan pada garis horizon dunia yang sama, lalu
 *    parallax terjadi alami dari gerak kamera 3D (bukan trik 2D).
 *  - Animasi: ombak (distorsi UV), rumput (sway berbasis mask warna),
 *    kilau laut, napas cahaya matahari, partikel emas di tiap celah layer.
 *
 * API:  window.Scene3D = { pause, resume, dispose, ready (Promise), config }
 *       Event 'scene3d:ready' dikirim ke window saat aset siap, dan kelas
 *       'scene3d-ready' ditambahkan ke <html> (untuk menyembunyikan loader).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Konfigurasi (ubah di sini)                                         */
  /* ------------------------------------------------------------------ */
  const CONFIG = {
    canvasId: 'bg-3d',
    maxPixelRatio: 1.75,        // batas devicePixelRatio (optimasi HP)
    applyCanvasStyles: true,    // pasang style fixed + fullscreen + z-index -1 otomatis
    opaqueBackground: true,     // false = latar transparan (dasar laut prosedural disembunyikan)
    fadeInMs: 900,              // durasi fade-in canvas setelah aset siap
    introSeconds: 2.6,          // dolly-in pembuka (0 = nonaktif)
    introDolly: 3.0,            // kamera mulai sejauh ini di belakang posisi awal

    imageAspect: 2576 / 1438,   // rasio default gambar (dibaca ulang dari gambar yang dimuat)
    textureMaxWidth: { desktop: 2048, mobile: 1536 },

    /* ---- Kamera & koreografi scroll ---- */
    camera: {
      fov: 45,
      near: 0.1,
      far: 160,
      zStart: 10,               // posisi z kamera saat scroll = 0
      zEnd: -12,                // posisi z kamera saat scroll = 100% (menembus rumput & ombak)
      height: 0.9,              // tinggi mata di atas garis laut (memisahkan horizon antar-layer)
      yRise: 0.6,               // kamera naik sedikit sepanjang scroll (paralaks vertikal)
      horizonStart: 0.60,       // posisi garis horizon di layar (0 = atas, 1 = bawah) saat scroll = 0
      horizonEnd: 0.64,         // ... saat scroll = 100% (kamera "menengadah" sedikit)
      xEndFocus: 1.0,           // 1 = gerbang Torii tepat di tengah layar di akhir scroll
      xCurve: 2.4,              // >1 = pergeseran horizontal baru terasa di paruh akhir
      scrollSmoothing: 3.2,     // makin besar = kamera makin cepat menyusul scroll (lerp)
      fadeNear: { start: 8.0, end: 2.6 },  // layer memudar saat kamera mendekatinya (jarak, unit z)
      fovKick: 0.12,            // FOV melebar sedikit saat scroll cepat (0 = nonaktif)
      fovKickMax: 2.5
    },

    /* ---- Mouse / sentuhan ---- */
    pointer: {
      shift: 0.7,               // geser kamera (unit dunia) -> sumber parallax kedalaman
      yaw: 0.02,                // rotasi kecil mengikuti kursor (radian)
      pitch: 0.012,
      breath: 0.25,             // ayunan idle kamera
      smoothing: 3.0
    },

    /* ---- Definisi layer (jauh -> dekat) ----
     *  z        : kedalaman bidang
     *  horizon  : posisi garis horizon di dalam gambar (0 = atas, 1 = bawah)
     *  anchor   : 'horizon' (horizon gambar disejajarkan dengan horizon dunia)
     *             'bottom'  (tepi bawah gambar menempel di dasar layar)
     *  focus    : titik penting (0..1 horizontal) yang dibawa ke tengah pada layar sempit/portrait
     *  minHeight: tinggi bidang minimum relatif tinggi pandang (menjaga cakupan di layar portrait)
     *  key      : parameter alpha keying (null = gambar opak, tanpa keying)
     *     lo/hi      ambang kecerahan: <= lo transparan penuh, >= hi opak penuh
     *     despeckle  buang bintik noise JPG di sekitar tepi
     *     close      radius penutupan retakan gelap yang tembus ke latar (px @2576)
     *     fillHoles  lubang transparan tertutup <= nilai ini (px @2576) diisi opak
     *     band       lebar pita tepi (px) yang mempertahankan alpha parsial
     */
    layers: [
      { id: 'sky', url: 'assets/layer1-sky.jpg.jpg', z: -40, order: 0,
        horizon: 0.9284, anchor: 'horizon', focus: 0.369, minHeight: 0.86,
        key: null, fadeNear: false, sky: true },
      { id: 'torii', url: 'assets/layer2-torii.jpg.jpg', z: -25, order: 2,
        horizon: 0.6391, anchor: 'horizon', focus: 0.272, minHeight: 0.75, track: true,
        key: { lo: 0.045, hi: 0.11, despeckle: true, close: 0, fillHoles: 0, band: 3 },
        bottomFade: [0.745, 0.779] },
      { id: 'ocean', url: 'assets/layer3-ocean.jpg.jpg', z: -12, order: 4,
        horizon: 0.4715, anchor: 'horizon', focus: 0.5, minHeight: 1.0,
        key: { lo: 0.045, hi: 0.11, despeckle: true, close: 0, fillHoles: 0, band: 3 },
        wave: true },
      { id: 'foreground', url: 'assets/layer4-foreground.jpg.jpg', z: -4, order: 6,
        anchor: 'bottom', focus: 0.5,
        key: { lo: 0.045, hi: 0.11, despeckle: true, close: 3, fillHoles: 4200, band: 3 },
        grass: true }
    ],

    /* ---- Animasi ---- */
    wave:  { amount: 1.0 },                      // kekuatan goyangan ombak (1 = default)
    grass: { amount: 1.0 },                      // kekuatan ayunan rumput
    sparkle: 1.0,                                // kedip kilau di permukaan laut
    sun: { u: 0.369, v: 0.838, glow: 1.0 },      // posisi matahari pada gambar langit (u dari kiri, v dari atas)

    /* ---- Partikel cahaya / buih emas (diselipkan di celah antar-layer) ---- */
    particles: {
      desktop: 190,
      mobile: 100,
      color: '#ffc766',
      core: '#fff3cf',
      opacity: 0.95,
      // ruang di antara layer; partikel dekat dibuat lebih kecil, lambat, dan ayunannya sempit
      slabs: [
        { zMin: -39, zMax: -27, weight: 0.20, order: 1, size: 0.22, rise: 0.45, sway: 0.90 },   // sky   -> torii
        { zMin: -23, zMax: -14, weight: 0.28, order: 3, size: 0.18, rise: 0.35, sway: 0.70 },   // torii -> ocean
        { zMin: -10, zMax: -6,  weight: 0.22, order: 5, size: 0.12, rise: 0.22, sway: 0.40 },   // ocean -> foreground
        { zMin: -2,  zMax: 8,   weight: 0.30, order: 7, size: 0.07, rise: 0.14, sway: 0.25 }    // di depan foreground
      ]
    },

    /* ---- Dasar laut prosedural (hanya terlihat lewat celah saat ombak memudar) ---- */
    sea: { top: '#3f7590', bottom: '#17405a' }
  };

  /* ------------------------------------------------------------------ */
  /*  Shader                                                             */
  /* ------------------------------------------------------------------ */
  const VERT_LAYER = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const FRAG_LAYER = `
    uniform sampler2D uMap;
    uniform float uTime;
    uniform float uOpacity;
    uniform float uShaderKey;
    uniform float uKeyLo;
    uniform float uKeyHi;
    uniform vec2  uBottomFade;   // [mulai, selesai] fade tepi bawah (pecahan dari atas gambar)
    uniform vec2  uTexel;        // 1 / ukuran tekstur
    uniform float uWave;
    uniform float uGrass;
    uniform float uSky;
    uniform float uSparkle;
    uniform vec2  uSun;          // (u, vDariAtas)
    uniform float uSunGlow;
    uniform float uImgAspect;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float lumOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
      vec2 uv = vUv;
      float vTop = 1.0 - uv.y;          // 0 = tepi atas gambar, 1 = tepi bawah
      float t = uTime;

      /* --- langit: awan bernapas pelan (menjauhi area matahari/horizon) --- */
      if (uSky > 0.0) {
        float cw = 1.0 - smoothstep(0.45, 0.86, vTop);
        uv.x += sin(t * 0.07 + vTop * 5.0) * 0.0040 * cw * uSky;
        uv.y += cos(t * 0.05 + uv.x * 4.0) * 0.0020 * cw * uSky;
      }

      /* --- ombak: distorsi UV, lemah di horizon, kuat di dekat penonton --- */
      if (uWave > 0.0) {
        float k  = 0.22 + 0.78 * smoothstep(0.46, 0.95, vTop);
        float w1 = sin(uv.x * 28.0 + t * 1.10 + vTop * 9.0);
        float w2 = sin(uv.x * 61.0 - t * 0.80 + vTop * 23.0);
        float w3 = sin(uv.y * 34.0 + t * 0.90 + uv.x * 5.0);
        float sw = sin(uv.x * 3.0 + t * 0.55);
        uv.x += (w1 * 0.0030 + w2 * 0.0011) * uWave * k;
        uv.y += (w3 * 0.0035 + w1 * 0.0012 + sw * 0.0030) * uWave * k;
      }

      /* --- rumput: ayunan angin; batu (gelap & tak jenuh) tidak ikut bergoyang --- */
      if (uGrass > 0.0) {
        vec3 c0 = texture2D(uMap, uv).rgb;
        float mx = max(c0.r, max(c0.g, c0.b));
        float mn = min(c0.r, min(c0.g, c0.b));
        float rock = (1.0 - smoothstep(0.03, 0.08, mx - mn)) * (1.0 - smoothstep(0.20, 0.32, mx));
        float living = 1.0 - rock;
        float hk = pow(1.0 - smoothstep(0.25, 1.0, vTop), 1.5);   // ujung daun bergerak lebih jauh
        float ph = uv.x * 7.0 + t * 1.25;
        float gust = 0.55 + 0.45 * sin(t * 0.37 + uv.x * 2.0);
        float sway = (sin(ph + vTop * 4.0) + 0.45 * sin(ph * 2.1 + t * 0.9 + vTop * 7.0)) * gust;
        uv.x += sway * 0.0036 * uGrass * hk * living;
        uv.y += cos(ph * 1.3 + t) * 0.0009 * uGrass * hk * living;
      }

      vec4 texel = texture2D(uMap, uv);

      /* --- cadangan: keying luminance di shader (bila tekstur belum diproses di CPU) --- */
      if (uShaderKey > 0.5) {
        float m = max(texel.r, max(texel.g, texel.b));
        float a = smoothstep(uKeyLo, uKeyHi, m);
        texel = vec4(texel.rgb * step(uKeyLo * 0.6, m), a);
      }

      /* --- kilau laut: bintang kecil berkedip (deteksi high-pass agar busa tidak ikut) --- */
      if (uSparkle > 0.0) {
        float lum = lumOf(texel.rgb);
        vec2 o = uTexel * 3.0;
        float lm = (lumOf(texture2D(uMap, uv + vec2(o.x, 0.0)).rgb) +
                    lumOf(texture2D(uMap, uv - vec2(o.x, 0.0)).rgb) +
                    lumOf(texture2D(uMap, uv + vec2(0.0, o.y)).rgb) +
                    lumOf(texture2D(uMap, uv - vec2(0.0, o.y)).rgb)) * 0.25;
        float spark = clamp((lum - lm - 0.10) * 2.0, 0.0, 1.0) * smoothstep(0.75, 0.95, lum);
        float ph = hash21(floor(uv * vec2(70.0, 40.0))) * 6.2831;
        float tw = 0.5 + 0.5 * sin(t * (1.4 + ph * 0.25) + ph * 3.0);
        texel.rgb *= 1.0 - spark * (1.0 - tw) * 0.85 * uSparkle;
      }

      /* --- napas cahaya matahari --- */
      if (uSky > 0.0) {
        vec2 dd = (vec2(uv.x, vTop) - uSun) * vec2(uImgAspect, 1.0);
        float glow = exp(-dot(dd, dd) * 55.0) * (0.10 + 0.05 * sin(t * 0.55)) * uSunGlow;
        texel.rgb += vec3(1.0, 0.86, 0.55) * glow;
      }

      /* --- fade tepi bawah (air Torii menyatu dengan dasar laut) --- */
      float bf = 1.0 - smoothstep(uBottomFade.x, uBottomFade.y, vTop);

      texel *= bf * uOpacity;     // premultiplied: skala RGB dan alpha bersama
      gl_FragColor = texel;
    }
  `;

  const VERT_SEA = `
    varying vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.9999, 1.0);
    }
  `;

  const FRAG_SEA = `
    uniform vec3  uTop;
    uniform vec3  uBottom;
    uniform float uTime;
    uniform float uHorizon;
    varying vec2 vUv;
    void main() {
      float y = 1.0 - vUv.y;
      float k = smoothstep(uHorizon, 1.0, y);
      vec3 c = mix(uTop, uBottom, k);
      float rip = sin(y * 140.0 + sin(vUv.x * 9.0 + uTime * 0.5) * 2.2 + uTime * 0.7) * 0.5 + 0.5;
      c += (rip - 0.5) * 0.035 * k;
      gl_FragColor = vec4(c, 1.0);
    }
  `;

  const VERT_MOTE = `
    uniform float uTime;
    uniform float uScale;
    uniform float uMaxPoint;
    uniform float uSize;
    uniform float uRise;
    uniform float uWind;
    uniform float uSway;
    attribute float aSeed;
    attribute float aScale;
    attribute vec4  aWrap;     // x0, lebarX, y0, tinggiY  (volume pembungkus)
    varying float vAlpha;
    varying float vGlint;
    varying float vHeat;

    void main() {
      vec3 p = position;
      float t = uTime;
      float sp = 0.55 + aSeed * 0.9;

      p.y = aWrap.z + mod(p.y - aWrap.z + t * uRise * sp, aWrap.w);
      p.x = aWrap.x + mod(p.x - aWrap.x + t * uWind * (0.4 + aSeed), aWrap.y);

      float ph = aSeed * 62.8318;
      p.x += sin(t * 0.37 + ph + p.y * 0.18) * uSway;
      p.z += cos(t * 0.29 + ph * 1.3 + p.x * 0.11) * uSway * 0.7;
      p.y += sin(t * 0.51 + ph * 0.7) * uSway * 0.25;

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float d = -mv.z;
      gl_Position = projectionMatrix * mv;

      float fx = (p.x - aWrap.x) / aWrap.y;
      float fy = (p.y - aWrap.z) / aWrap.w;
      float fEdge = smoothstep(0.0, 0.12, fx) * (1.0 - smoothstep(0.88, 1.0, fx)) *
                    smoothstep(0.0, 0.12, fy) * (1.0 - smoothstep(0.88, 1.0, fy));
      float tw    = 0.55 + 0.45 * sin(t * (1.1 + aSeed * 2.3) + ph);
      float fNear = smoothstep(2.0, 7.0, d);
      float fFar  = 1.0 - smoothstep(70.0, 110.0, d);
      vAlpha = tw * fNear * fFar * fEdge;
      vGlint = smoothstep(0.85, 1.4, aScale);
      vHeat  = 0.5 + 0.5 * sin(t * 0.8 + ph * 2.0);

      float size = uSize * aScale * uScale / max(d, 0.001);
      gl_PointSize = clamp(size, 1.5, uMaxPoint);
    }
  `;

  const FRAG_MOTE = `
    uniform vec3  uColor;
    uniform vec3  uCore;
    uniform float uOpacity;
    varying float vAlpha;
    varying float vGlint;
    varying float vHeat;

    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = min(length(c) * 2.0, 1.0);
      float glow = pow(max(1.0 - d, 0.0), 2.2);
      float core = 1.0 - smoothstep(0.0, 0.30, d);
      float glint = max(0.0, 1.0 - abs(c.x) * 14.0) * max(0.0, 1.0 - abs(c.y) * 2.4) +
                    max(0.0, 1.0 - abs(c.y) * 14.0) * max(0.0, 1.0 - abs(c.x) * 2.4);
      float a = (glow * 0.70 + core * 0.55 + glint * 0.35 * vGlint) * vAlpha * uOpacity;
      vec3 col = mix(uColor, uCore, clamp(core * (0.5 + 0.5 * vHeat) + glint * 0.5, 0.0, 1.0));
      // premultiplied: alpha keluaran dikurangi = setengah aditif, tetap terlihat di langit terang
      gl_FragColor = vec4(col * a, a * 0.5);
    }
  `;

  /* ------------------------------------------------------------------ */
  /*  Util                                                               */
  /* ------------------------------------------------------------------ */
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  // acak deterministik (tata letak partikel sama setiap dimuat)
  const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  /* ================================================================== */
  /*  ALPHA KEYING (CPU, sekali saat dimuat)                             */
  /*                                                                     */
  /*  Gambar berlatar hitam = gambar yang sudah "premultiplied" terhadap */
  /*  hitam. Maka RGB asli dipertahankan sebagai RGB premultiplied dan   */
  /*  hanya ALPHA yang dihitung. Dengan blending premultiplied tidak ada */
  /*  piksel abu-abu di tepi: hitam tidak menyumbang apa pun.            */
  /* ================================================================== */
  /* @@KEY_BEGIN */
  function morphPass(src, w, h, r, horizontal, useMax) {
    const dst = new Uint8Array(src.length);
    if (horizontal) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let v = useMax ? 0 : 255;
          const x0 = x - r < 0 ? 0 : x - r;
          const x1 = x + r >= w ? w - 1 : x + r;
          for (let k = x0; k <= x1; k++) {
            const s = src[row + k];
            if (useMax ? s > v : s < v) v = s;
          }
          dst[row + x] = v;
        }
      }
    } else {
      for (let y = 0; y < h; y++) {
        const y0 = y - r < 0 ? 0 : y - r;
        const y1 = y + r >= h ? h - 1 : y + r;
        for (let x = 0; x < w; x++) {
          let v = useMax ? 0 : 255;
          for (let k = y0; k <= y1; k++) {
            const s = src[k * w + x];
            if (useMax ? s > v : s < v) v = s;
          }
          dst[y * w + x] = v;
        }
      }
    }
    return dst;
  }
  const dilateGray = (a, w, h, r) => morphPass(morphPass(a, w, h, r, true, true), w, h, r, false, true);
  const erodeGray = (a, w, h, r) => morphPass(morphPass(a, w, h, r, true, false), w, h, r, false, false);

  /*
   * Klasifikasi piksel transparan (alpha ~ 0):
   *   mark = 1  transparan yang dipertahankan (latar luar + celah tertutup besar, mis. di antara tiang Torii)
   *   mark = 2  lubang tertutup kecil -> akan diisi opak (retakan/bayangan gelap di dalam batu)
   */
  function classifyTransparent(a, w, h, thr, maxFill) {
    const N = w * h;
    const mark = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const push = (i) => { stack[sp++] = i; mark[i] = 1; };

    for (let x = 0; x < w; x++) {
      let i = x; if (a[i] < thr && !mark[i]) push(i);
      i = (h - 1) * w + x; if (a[i] < thr && !mark[i]) push(i);
    }
    for (let y = 0; y < h; y++) {
      let i = y * w; if (a[i] < thr && !mark[i]) push(i);
      i = y * w + w - 1; if (a[i] < thr && !mark[i]) push(i);
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && !mark[i - 1] && a[i - 1] < thr) push(i - 1);
      if (x < w - 1 && !mark[i + 1] && a[i + 1] < thr) push(i + 1);
      if (y > 0 && !mark[i - w] && a[i - w] < thr) push(i - w);
      if (y < h - 1 && !mark[i + w] && a[i + w] < thr) push(i + w);
    }

    // komponen transparan yang tidak menyentuh tepi gambar
    const comp = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (mark[s] || a[s] >= thr) continue;
      let cn = 0;
      sp = 0;
      stack[sp++] = s; mark[s] = 3;
      while (sp > 0) {
        const i = stack[--sp];
        comp[cn++] = i;
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0 && !mark[i - 1] && a[i - 1] < thr) { mark[i - 1] = 3; stack[sp++] = i - 1; }
        if (x < w - 1 && !mark[i + 1] && a[i + 1] < thr) { mark[i + 1] = 3; stack[sp++] = i + 1; }
        if (y > 0 && !mark[i - w] && a[i - w] < thr) { mark[i - w] = 3; stack[sp++] = i - w; }
        if (y < h - 1 && !mark[i + w] && a[i + w] < thr) { mark[i + w] = 3; stack[sp++] = i + w; }
      }
      const v = cn <= maxFill ? 2 : 1;
      for (let k = 0; k < cn; k++) mark[comp[k]] = v;
    }
    return mark;
  }

  /*
   * rgba  : Uint8ClampedArray RGBA hasil getImageData (baris pertama = atas gambar)
   * opt   : { lo, hi, despeckle, close, fillHoles, band }
   * hasil : Uint8Array RGBA premultiplied, baris dibalik ke orientasi GL (baris pertama = bawah)
   */
  function keyToPremultipliedRGBA(rgba, w, h, opt) {
    const N = w * h;
    const ref = w / 2576;                                   // semua radius & luas dinyatakan pada lebar 2576 px
    const lo = opt.lo, hi = opt.hi;

    // 1) alpha awal dari kecerahan (max kanal), kurva smoothstep
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const t = clamp((i / 255 - lo) / (hi - lo), 0, 1);
      lut[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
    let a = new Uint8Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      a[i] = lut[r > g ? (r > b ? r : b) : (g > b ? g : b)];
    }

    // 2) buang bintik noise JPG di luar tepi (opening 3x3)
    if (opt.despeckle) a = dilateGray(erodeGray(a, w, h, 1), w, h, 1);

    // 3) tutup retakan gelap sempit yang tembus ke latar (closing)
    const cr = Math.round((opt.close || 0) * Math.max(ref, 0.5));
    if (cr > 0) a = erodeGray(dilateGray(a, w, h, cr), w, h, cr);

    // 4) isi lubang tertutup kecil; lindungi bagian dalam objek dari alpha parsial
    const thr = 8;
    const maxFill = Math.round((opt.fillHoles || 0) * ref * ref);
    const mark = classifyTransparent(a, w, h, thr, maxFill);
    const T = new Uint8Array(N);
    for (let i = 0; i < N; i++) T[i] = mark[i] === 1 ? 255 : 0;
    const band = Math.max(1, Math.round((opt.band || 3) * Math.max(ref, 0.5)));
    const nearT = dilateGray(T, w, h, band);
    for (let i = 0; i < N; i++) {
      if (mark[i] === 1) a[i] = 0;
      else if (mark[i] === 2) a[i] = 255;
      else if (a[i] < 255 && nearT[i] === 0) a[i] = 255;
    }

    // 5) rakit RGBA premultiplied + balik baris (GL: baris pertama = bawah)
    const out = new Uint8Array(N * 4);
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const i = sy * w + x;
        const o = (y * w + x) * 4;
        const al = a[i];
        if (al !== 0) {
          const p = i * 4;
          out[o] = rgba[p]; out[o + 1] = rgba[p + 1]; out[o + 2] = rgba[p + 2];
        }
        out[o + 3] = al;
      }
    }
    return out;
  }
  /* @@KEY_END */

  /* ================================================================== */
  /*  LAYOUT (fungsi murni: bisa diuji tanpa WebGL)                      */
  /*                                                                     */
  /*  Setiap bidang dibuat cukup besar untuk menutupi layar pada posisi  */
  /*  kamera awal + margin untuk seluruh gerak mouse. Margin dihitung    */
  /*  dari jarak layer: layer dekat bergeser jauh lebih banyak daripada  */
  /*  layer jauh (itulah parallax), sehingga butuh margin lebih besar.   */
  /*  Horizon tiap gambar disejajarkan di y = 0 dunia, jadi susunan      */
  /*  tetap benar walau gambar punya tinggi horizon berbeda-beda.        */
  /* ================================================================== */
  /* @@LAYOUT_BEGIN */
  // FOV dasar: layar potret memakai FOV lebih lebar agar volume tetap terlihat
  function baseFovFor(cfg, aspect) {
    return aspect < 1 ? cfg.camera.fov + (1 - aspect) * 14 : cfg.camera.fov;
  }

  function computeLayout(cfg, aspect) {
    const C = cfg.camera, P = cfg.pointer;
    const fov = baseFovFor(cfg, aspect);
    const tanH = Math.tan(fov * Math.PI / 360);
    const tanW = tanH * aspect;
    // rasio pelebaran frustum saat FOV-kick (scroll cepat) -> dipakai sebagai margin tambahan
    const kick = C.fovKick ? Math.tan((fov + C.fovKickMax) * Math.PI / 360) / tanH : 1;
    const items = [];
    for (let li = 0; li < cfg.layers.length; li++) {
      const L = cfg.layers[li];
      const d = C.zStart - L.z;
      const V = 2 * d * tanH;                         // tinggi pandang pada kedalaman ini
      const Wd = V * aspect;                          // lebar pandang
      const imgAspect = L.imgAspect || cfg.imageAspect;
      // margin pergeseran: geser kamera + napas idle + yaw/pitch (di tepi layar dikali 1+tan^2) + FOV-kick
      const mx = P.shift + P.breath + P.yaw * d * (1 + tanW * tanW) + 0.2 + Wd * (kick - 1) / 2;
      const my = P.shift * 0.7 + P.breath * 0.6 + P.pitch * d * (1 + tanH * tanH) + 0.1 + V * (kick - 1) / 2;

      let w = Math.max(Wd * 1.02, Wd + 2 * mx);
      let h = w / imgAspect;
      if (L.minHeight && h < V * L.minHeight) { h = V * L.minHeight; w = h * imgAspect; }

      // layar sempit/portrait: geser bidang agar titik penting (Torii, matahari) masuk ke tengah
      let cx = 0;
      const port = clamp((imgAspect - aspect) / (imgAspect - 0.6), 0, 1) * 0.85;
      if (L.focus != null && port > 0) {
        const lim = Math.max(0, (w - Wd) / 2 - mx);
        cx = clamp((0.5 - L.focus) * w * port, -lim, lim);
      }

      let cy;
      if (L.anchor === 'bottom') {
        const bottom = C.height - (1 - C.horizonStart) * V - 0.02 * V - my;
        cy = bottom + h / 2;
      } else {
        cy = ((L.horizon != null ? L.horizon : 0.5) - 0.5) * h;       // horizon gambar -> y = 0 dunia
      }

      items.push({
        id: L.id, z: L.z, cx: cx, cy: cy, w: w, h: h,
        focusX: cx + ((L.focus != null ? L.focus : 0.5) - 0.5) * w     // posisi dunia titik fokus
      });
    }
    return items;
  }
  /* @@LAYOUT_END */

  /* ------------------------------------------------------------------ */
  /*  Init                                                               */
  /* ------------------------------------------------------------------ */
  function init() {
    const canvas = document.getElementById(CONFIG.canvasId);
    if (!canvas) { console.warn('[scene3d] <canvas id="' + CONFIG.canvasId + '"> tidak ditemukan.'); return; }
    if (typeof THREE === 'undefined') { console.warn('[scene3d] Three.js belum dimuat. Muat three.min.js (r128) sebelum scene3d.js.'); return; }
    if (location.protocol === 'file:') {
      console.warn('[scene3d] Dibuka lewat file://. Browser memblokir tekstur WebGL dari file lokal; jalankan lewat server lokal (mis. "npx serve" atau "python3 -m http.server").');
    }

    const isCoarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduceMotion = !!(reduceMq && reduceMq.matches);

    if (CONFIG.applyCanvasStyles) {
      Object.assign(canvas.style, {
        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
        zIndex: '-2', pointerEvents: 'none', display: 'block'
      });
      // 100lvh menjaga ukuran canvas tetap saat address bar Android muncul/hilang
      try { if (window.CSS && CSS.supports && CSS.supports('height', '100lvh')) canvas.style.height = '100lvh'; } catch (e) { /* abaikan */ }
    }
    canvas.style.opacity = '0';
    document.documentElement.classList.add('scene3d-loading');

    /* ---- Renderer ---- */
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: false,
        alpha: true,
        depth: false,
        stencil: false,
        powerPreference: 'default'
      });
    } catch (err) {
      console.warn('[scene3d] WebGL tidak tersedia:', err);
      canvas.style.display = 'none';
      return;
    }
    renderer.setClearColor(new THREE.Color(CONFIG.sea.bottom), CONFIG.opaqueBackground ? 1 : 0);

    let pixelRatio = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);
    const gl = renderer.getContext();
    let hwMaxPoint = 64;
    try { const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); if (r && r[1]) hwMaxPoint = r[1]; } catch (e) { /* abaikan */ }
    const isGL2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    const maxAniso = Math.min(4, (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) ? renderer.capabilities.getMaxAnisotropy() : 1);

    const C = CONFIG.camera;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(C.fov, 1, C.near, C.far);
    camera.rotation.order = 'YXZ';

    /* ---- Uniform bersama ---- */
    const U = {
      time: { value: 0 },
      scale: { value: 600 },
      maxPoint: { value: 64 }
    };

    /* ---- Dasar laut prosedural (cadangan di belakang semua layer) ---- */
    const seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(CONFIG.sea.top) },
        uBottom: { value: new THREE.Color(CONFIG.sea.bottom) },
        uTime: U.time,
        uHorizon: { value: C.horizonStart }
      },
      vertexShader: VERT_SEA,
      fragmentShader: FRAG_SEA,
      depthTest: false,
      depthWrite: false
    });
    const seaGeo = new THREE.PlaneGeometry(2, 2);
    const seaMesh = new THREE.Mesh(seaGeo, seaMat);
    seaMesh.frustumCulled = false;
    seaMesh.renderOrder = -10;
    seaMesh.visible = CONFIG.opaqueBackground;
    scene.add(seaMesh);

    /* ---- Bidang layer ---- */
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const layerObjs = [];     // { cfg, mesh, mat, tex, baseY, intro }
    const motes = [];         // { points, geo, slab, count }
    const disposables = [];

    function createLayerMesh(L, tex, shaderKey, imgW, imgH) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: tex },
          uTime: U.time,
          uOpacity: { value: 0 },
          uShaderKey: { value: shaderKey ? 1 : 0 },
          uKeyLo: { value: L.key ? L.key.lo : 0.045 },
          uKeyHi: { value: L.key ? L.key.hi : 0.11 },
          uBottomFade: { value: new THREE.Vector2(L.bottomFade ? L.bottomFade[0] : 2.0, L.bottomFade ? L.bottomFade[1] : 3.0) },
          uTexel: { value: new THREE.Vector2(1 / imgW, 1 / imgH) },
          uWave: { value: 0 },
          uGrass: { value: 0 },
          uSky: { value: 0 },
          uSparkle: { value: 0 },
          uSun: { value: new THREE.Vector2(CONFIG.sun.u, CONFIG.sun.v) },
          uSunGlow: { value: CONFIG.sun.glow },
          uImgAspect: { value: imgW / imgH }
        },
        vertexShader: VERT_LAYER,
        fragmentShader: FRAG_LAYER,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = L.order;
      mesh.visible = false;
      scene.add(mesh);
      const obj = { cfg: L, mesh: mesh, mat: mat, tex: tex, baseY: 0, intro: 0 };
      layerObjs.push(obj);
      return obj;
    }

    /* ---- Pemuatan & pemrosesan tekstur ---- */
    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        if (location.protocol !== 'file:') img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('[scene3d] Gagal memuat tekstur: ' + url + ' (periksa nama file dan jalankan lewat HTTP server)'));
        img.src = url;
      });
    }

    const nextTick = () => new Promise((r) => setTimeout(r, 0));

    function configureTexture(tex, w, h, mipmaps) {
      const pot = (n) => (n & (n - 1)) === 0;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.magFilter = THREE.LinearFilter;
      if (mipmaps && (isGL2 || (pot(w) && pot(h)))) {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
      } else {
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
      }
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
    }

    function buildTexture(img, L) {
      const maxW = isCoarse ? CONFIG.textureMaxWidth.mobile : CONFIG.textureMaxWidth.desktop;
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));

      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* abaikan */ }
      ctx.drawImage(img, 0, 0, w, h);

      if (!L.key) {                                   // gambar opak (langit)
        const tex = new THREE.CanvasTexture(cv);
        configureTexture(tex, w, h, true);
        return { tex: tex, shaderKey: false, w: w, h: h };
      }

      try {
        const id = ctx.getImageData(0, 0, w, h);
        const data = keyToPremultipliedRGBA(id.data, w, h, L.key);
        const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.flipY = false;
        tex.premultiplyAlpha = false;
        tex.unpackAlignment = 1;
        configureTexture(tex, w, h, true);
        return { tex: tex, shaderKey: false, w: w, h: h };
      } catch (err) {
        // canvas ter-taint (CORS) -> keying luminance di shader dengan tekstur gambar apa adanya
        console.warn('[scene3d] Keying CPU gagal untuk "' + L.id + '", memakai keying shader:', err);
        const tex = new THREE.Texture(img);
        configureTexture(tex, img.naturalWidth, img.naturalHeight, true);
        return { tex: tex, shaderKey: true, w: img.naturalWidth, h: img.naturalHeight };
      }
    }

    /* ---- Partikel cahaya / buih emas ---- */
    const moteColor = new THREE.Color(CONFIG.particles.color);
    const moteCore = new THREE.Color(CONFIG.particles.core);
    const PC = CONFIG.particles;
    const totalMotes = isCoarse ? PC.mobile : PC.desktop;

    function buildMotes() {
      let wsum = 0;
      PC.slabs.forEach((s) => { wsum += s.weight; });
      PC.slabs.forEach((slab, si) => {
        const count = Math.max(8, Math.round(totalMotes * slab.weight / wsum));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        geo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(count), 1));
        geo.setAttribute('aScale', new THREE.BufferAttribute(new Float32Array(count), 1));
        geo.setAttribute('aWrap', new THREE.BufferAttribute(new Float32Array(count * 4), 4));
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTime: U.time, uScale: U.scale, uMaxPoint: U.maxPoint,
            uSize: { value: slab.size },
            uRise: { value: slab.rise },
            uWind: { value: slab.rise * (0.35 + rnd(si * 5 + 3) * 0.3) },
            uSway: { value: slab.sway },
            uColor: { value: moteColor }, uCore: { value: moteCore },
            uOpacity: { value: 0 }
          },
          vertexShader: VERT_MOTE,
          fragmentShader: FRAG_MOTE,
          transparent: true,
          premultipliedAlpha: true,
          depthTest: false,
          depthWrite: false
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        points.renderOrder = slab.order;
        scene.add(points);
        motes.push({ points: points, geo: geo, mat: mat, slab: slab, count: count, seedBase: si * 1000 });
      });
    }

    // posisi dihitung dari volume pandang pada kamera awal (dipanggil ulang saat aspek berubah)
    function layoutMotes(aspect) {
      const tanH = Math.tan(baseFovFor(CONFIG, aspect) * Math.PI / 360);
      motes.forEach((m) => {
        const pos = m.geo.attributes.position.array;
        const seed = m.geo.attributes.aSeed.array;
        const scl = m.geo.attributes.aScale.array;
        const wrap = m.geo.attributes.aWrap.array;
        for (let j = 0; j < m.count; j++) {
          const s = m.seedBase + j * 13;
          const z = lerp(m.slab.zMin, m.slab.zMax, rnd(s + 1));
          const d = Math.max(3, C.zStart - z);
          const V = 2 * d * tanH;
          const halfW = V * Math.max(aspect, 1.0) * 0.5 * 1.3;
          const yc = C.height + (C.horizonStart - 0.5) * V;
          const yr = V * 1.3;
          const x = (rnd(s + 2) * 2 - 1) * halfW;
          const y = yc - yr * 0.5 + rnd(s + 3) * yr;
          pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z;
          seed[j] = rnd(s + 4);
          scl[j] = 0.5 + rnd(s + 5) * 1.0;
          wrap[j * 4] = -halfW; wrap[j * 4 + 1] = halfW * 2;
          wrap[j * 4 + 2] = yc - yr * 0.5; wrap[j * 4 + 3] = yr;
        }
        m.geo.attributes.position.needsUpdate = true;
        m.geo.attributes.aSeed.needsUpdate = true;
        m.geo.attributes.aScale.needsUpdate = true;
        m.geo.attributes.aWrap.needsUpdate = true;
      });
    }
    buildMotes();

    /* ---- Ukuran & kualitas ---- */
    let vw = 0, vh = 0, baseFov = C.fov, fovKick = 0, curAspect = 0;
    let scrollY = window.pageYOffset || 0;
    let maxScroll = 1;
    let camXEnd = 0;

    function refreshMaxScroll() {
      maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    }

    function applyLayout() {
      const aspect = Math.max(0.2, (vw || window.innerWidth) / (vh || window.innerHeight));
      const items = computeLayout(CONFIG, aspect);
      let trackX = 0;
      items.forEach((it, idx) => {
        const L = CONFIG.layers[idx];
        if (L.track) trackX = it.focusX;
        const obj = layerObjs.find((o) => o.cfg === L);
        if (!obj) return;
        obj.mesh.scale.set(it.w, it.h, 1);
        obj.mesh.position.set(it.cx, it.cy, it.z);
        obj.baseY = it.cy;
      });
      camXEnd = trackX * C.xEndFocus;
      if (Math.abs(aspect - curAspect) > 0.001) { layoutMotes(aspect); curAspect = aspect; }
    }

    function resize(force) {
      refreshMaxScroll();
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      if (!w || !h) return;
      // abaikan perubahan tinggi kecil (address bar Android) agar buffer tidak dibuat ulang
      if (!force && w === vw && (h === vh || (isCoarse && Math.abs(h - vh) < 140))) return;
      vw = w; vh = h;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(w, h, false);
      U.maxPoint.value = Math.min(hwMaxPoint, 72 * pixelRatio);
      camera.aspect = w / h;
      // layar potret: FOV lebih lebar agar volume tetap terlihat (rumus sama dengan layout)
      baseFov = baseFovFor(CONFIG, camera.aspect);
      applyLayout();
    }

    /* ---- Input: kursor & sentuhan ---- */
    const input = { tx: 0, ty: 0, x: 0, y: 0 };
    const setTarget = (cx, cy) => {
      input.tx = clamp((cx / Math.max(1, window.innerWidth)) * 2 - 1, -1, 1);
      input.ty = clamp((cy / Math.max(1, window.innerHeight)) * 2 - 1, -1, 1);
    };
    const resetTarget = () => { input.tx = 0; input.ty = 0; };

    const listeners = [];
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };

    on(window, 'pointermove', (e) => { if (e.pointerType !== 'touch') setTarget(e.clientX, e.clientY); }, { passive: true });
    on(window, 'touchstart', (e) => { const t = e.touches[0]; if (t) setTarget(t.clientX, t.clientY); }, { passive: true });
    on(window, 'touchmove', (e) => { const t = e.touches[0]; if (t) setTarget(t.clientX, t.clientY); }, { passive: true });
    on(window, 'touchend', resetTarget, { passive: true });
    on(window, 'touchcancel', resetTarget, { passive: true });
    on(document.documentElement, 'mouseleave', resetTarget);
    on(window, 'scroll', () => { scrollY = window.pageYOffset || 0; }, { passive: true });

    let rzRaf = 0;
    on(window, 'resize', () => {
      if (rzRaf) return;
      rzRaf = requestAnimationFrame(() => { rzRaf = 0; resize(false); });
    });
    on(window, 'load', () => resize(false));

    let ro = null;
    if ('ResizeObserver' in window) {
      let roRaf = 0;
      ro = new ResizeObserver(() => {
        if (roRaf) return;
        roRaf = requestAnimationFrame(() => { roRaf = 0; refreshMaxScroll(); });
      });
      ro.observe(document.body);
    }

    if (reduceMq) {
      const onReduce = (e) => { reduceMotion = e.matches; };
      try { reduceMq.addEventListener('change', onReduce); } catch (e) { reduceMq.addListener(onReduce); }
    }

    resize(true);

    /* ---- Loop ---- */
    let rafId = 0, lastT = 0, time = 0, frames = 0, emaDt = 1 / 60, disposed = false;
    let sp = clamp(scrollY / maxScroll, 0, 1);      // progres scroll yang sudah di-lerp
    let readyAt = -1;                                // detik 'time' saat aset siap
    let started = false;
    const introOn = () => CONFIG.introSeconds > 0 && !reduceMotion;

    function pathAt(p) {
      return {
        x: camXEnd * Math.pow(p, C.xCurve),
        y: C.height + C.yRise * p,
        z: lerp(C.zStart, C.zEnd, p),
        horizon: lerp(C.horizonStart, C.horizonEnd, p)
      };
    }

    function frame(now) {
      rafId = requestAnimationFrame(frame);
      let dt = (now - lastT) / 1000;
      lastT = now;
      if (!(dt > 0)) return;
      const rawDt = Math.min(dt, 0.25);
      dt = Math.min(dt, 0.05);

      /* kualitas adaptif: turunkan DPR (min 1) bila perangkat lambat */
      frames++;
      if (frames > 40) {
        emaDt += (rawDt - emaDt) * 0.06;
        if (frames % 90 === 0 && emaDt > 0.027 && pixelRatio > 1.01) {
          pixelRatio = Math.max(1, pixelRatio - 0.25);
          resize(true);
          emaDt = 1 / 60;
        }
      }

      /* waktu animasi */
      time += dt * (reduceMotion ? 0.25 : 1);
      U.time.value = time;
      const motionK = reduceMotion ? 0.4 : 1;

      /* progres scroll -> lerp mulus (eksponensial, bebas-frame-rate) */
      const progress = clamp(scrollY / maxScroll, 0, 1);
      const prevSp = sp;
      sp += (progress - sp) * (1 - Math.exp(-dt * C.scrollSmoothing));
      if (Math.abs(progress - sp) < 0.00005) sp = progress;

      /* intro: kamera meluncur masuk + layer muncul berurutan */
      let introE = 1;
      if (readyAt >= 0 && introOn()) {
        const k = clamp((time - readyAt) / CONFIG.introSeconds, 0, 1);
        introE = 1 - Math.pow(1 - k, 3);
      }

      /* kamera maju menembus kedalaman ruang 3D */
      const path = pathAt(sp);
      const dolly = (1 - introE) * CONFIG.introDolly;
      const pk = reduceMotion ? 0.35 : 1;
      const ik = 1 - Math.exp(-dt * CONFIG.pointer.smoothing);
      input.x += (input.tx - input.x) * ik;
      input.y += (input.ty - input.y) * ik;
      const PT = CONFIG.pointer;

      camera.position.z = path.z + dolly;
      camera.position.x = path.x + input.x * PT.shift * pk + Math.sin(time * 0.11) * PT.breath;
      camera.position.y = path.y - input.y * PT.shift * 0.7 * pk + Math.cos(time * 0.09) * PT.breath * 0.6;
      camera.rotation.y = -input.x * PT.yaw * pk;
      camera.rotation.x = -input.y * PT.pitch * pk;

      /* sensasi kecepatan: FOV melebar sedikit saat scroll cepat */
      const velZ = Math.abs((sp - prevSp) * (C.zStart - C.zEnd)) / dt;
      const kickTarget = (reduceMotion || !C.fovKick) ? 0 : Math.min(velZ * C.fovKick, C.fovKickMax);
      fovKick += (kickTarget - fovKick) * (1 - Math.exp(-dt * 5));
      const fov = baseFov + fovKick;
      camera.fov = fov;
      // lens-shift: garis horizon di layar bergeser (tanpa memiringkan kamera => tanpa distorsi keystone)
      camera.setViewOffset(vw, vh, 0, -(path.horizon - 0.5) * vh, vw, vh);
      seaMat.uniforms.uHorizon.value = path.horizon;
      U.scale.value = (vh * pixelRatio * 0.5) / Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);

      /* layer: pudar saat kamera mendekat, lewati yang sudah di belakang kamera */
      const camZ = camera.position.z;
      for (let i = 0; i < layerObjs.length; i++) {
        const o = layerObjs[i];
        const L = o.cfg;
        const dist = camZ - L.z;
        let op = 1;
        if (L.fadeNear !== false) {
          op = smooth01((dist - C.fadeNear.end) / (C.fadeNear.start - C.fadeNear.end));
        } else if (dist <= 0.5) op = 0;
        // muncul berurutan dari jauh ke dekat saat intro
        const stagger = i / Math.max(1, layerObjs.length);
        op *= smooth01((introE - stagger * 0.45) / 0.55);
        o.mat.uniforms.uOpacity.value = op;
        o.mesh.visible = op > 0.003;
        if (!o.mesh.visible) continue;
        const u = o.mat.uniforms;
        u.uWave.value = L.wave ? CONFIG.wave.amount * motionK : 0;
        u.uGrass.value = L.grass ? CONFIG.grass.amount * motionK : 0;
        u.uSky.value = L.sky ? motionK : 0;
        u.uSparkle.value = L.wave ? CONFIG.sparkle * motionK : 0;
        if (L.wave) o.mesh.position.y = o.baseY + Math.sin(time * 0.6) * 0.06 * motionK;   // laut naik-turun halus
      }

      /* partikel: pudar mengikuti intro */
      for (let i = 0; i < motes.length; i++) {
        motes[i].mat.uniforms.uOpacity.value = PC.opacity * smooth01((introE - 0.35) / 0.65);
        motes[i].points.visible = introE > 0.36;
      }

      renderer.render(scene, camera);
    }

    function start() {
      if (rafId || disposed) return;
      lastT = performance.now();
      rafId = requestAnimationFrame(frame);
    }
    function stop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    // jeda saat tab tidak aktif
    on(document, 'visibilitychange', () => { if (document.hidden) stop(); else if (started) start(); });
    on(canvas, 'webglcontextlost', (e) => { e.preventDefault(); stop(); });
    on(canvas, 'webglcontextrestored', () => { resize(true); if (started) start(); });

    /* ---- Muat aset -> proses -> mulai ---- */
    let resolveReady;
    const readyPromise = new Promise((r) => { resolveReady = r; });

    (async function loadAll() {
      let successfulCount = 0;

      await Promise.all(CONFIG.layers.map(async (L) => {
        let img;
        try {
          img = await loadImage(L.url);
        } catch (err) {
          console.error('[scene3d]', err.message);
          return;
        }
        if (!img || disposed) return;

        await nextTick();                                   // beri napas ke main thread di antara layer
        L.imgAspect = img.naturalWidth / img.naturalHeight;
        const built = buildTexture(img, L);
        const obj = createLayerMesh(L, built.tex, built.shaderKey, built.w, built.h);
        disposables.push(built.tex);
        if (L.sky) obj.mat.uniforms.uSky.value = 1;
        successfulCount++;

        // Jangan tunggu seluruh Promise.all: layer yang berhasil dapat langsung tampil
        // meski satu atau beberapa path aset gagal atau masih dimuat.
        if (successfulCount === 1) {
          applyLayout();
          canvas.style.transition = 'opacity ' + CONFIG.fadeInMs + 'ms ease';
          requestAnimationFrame(() => { canvas.style.opacity = '1'; });
        }
      }));

      if (disposed) return;
      if (successfulCount === 0) {
        console.error('[scene3d] Tidak ada tekstur berhasil dimuat. Periksa seluruh path aset di CONFIG.layers.');
        resolveReady(false);
        return;
      }

      applyLayout();
      readyAt = time;
      started = true;
      document.documentElement.classList.remove('scene3d-loading');
      document.documentElement.classList.add('scene3d-ready');
      canvas.style.transition = 'opacity ' + CONFIG.fadeInMs + 'ms ease';
      canvas.style.opacity = '1';
      if (!document.hidden) start();
      try { window.dispatchEvent(new CustomEvent('scene3d:ready')); } catch (e) { /* abaikan */ }
      resolveReady(true);
    })();

    function dispose() {
      disposed = true;
      stop();
      listeners.forEach((l) => l[0].removeEventListener(l[1], l[2], l[3]));
      if (ro) ro.disconnect();
      disposables.forEach((t) => t.dispose());
      layerObjs.forEach((o) => o.mat.dispose());
      motes.forEach((m) => { m.geo.dispose(); m.mat.dispose(); });
      planeGeo.dispose(); seaGeo.dispose(); seaMat.dispose();
      renderer.dispose();
    }

    window.Scene3D = { pause: stop, resume: () => { if (started) start(); }, dispose: dispose, ready: readyPromise, config: CONFIG };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
