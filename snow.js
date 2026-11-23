/*! snow.js - tiny dependency-free snowfall that piles up on your elements.
 *  Tag any element with  data-snow  and flakes will settle on its top edge.
 *
 *    <div data-snow>...</div>
 *    <div data-snow data-snow-max="30" data-snow-pass="0.5">...</div>
 *
 *    Snow.start({ image: 'flake.svg' });
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    image: null,          // URL of your own SVG/PNG flake. null = built-in soft dot
    count: 120,           // flakes on a 1280x720 screen (scales with screen area)
    minCount: 30,         // never go below this
    size: [6, 14],        // px, [small, big]. Big flakes fall faster (feels like depth)
    speed: [30, 70],      // px per second
    sway: 20,             // side-to-side drift
    wind: 0,              // constant sideways push (px/sec), can be negative
    maxPile: 14,          // default max snow depth (px) on a tagged element
    passChance: 0.2,      // chance (0-1) a flake falls through an element instead of landing
    buildSpeed: 1,        // how fast piles grow
    pileColor: '#f4f8ff',
    zIndex: 9999,
    fps: 60,              // use 30 for very weak devices
    pixelRatio: 1,        // 1 = cheapest. Snow is soft, so you rarely need more
    respectReducedMotion: true
  };

  var BIN = 4;            // pile resolution: one height value per 4px of width
  var SPRITE = 32;        // flake sprite is rendered once at this size
  function noop() {}

  function start(opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) o[k] = opts[k];

    var NOOP = { pause: noop, resume: noop, clear: noop, refresh: noop, destroy: noop };
    if (o.respectReducedMotion && global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches) return NOOP;

    // ---- canvas -------------------------------------------------------
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:' + o.zIndex;
    document.body.appendChild(cv);

    // ---- state (typed arrays = no garbage, no per-flake objects) -------
    var maxN = Math.ceil(o.count * 2);
    var fx = new Float32Array(maxN), fy = new Float32Array(maxN);
    var fs = new Float32Array(maxN), fv = new Float32Array(maxN);
    var fp = new Float32Array(maxN), ig = new Int32Array(maxN);
    var W = 0, H = 0, n = 0, target = 0, quality = 1;
    var surfs = [], act = [], map = new Map(), uid = 0;
    var raf = 0, timer = 0, rt = 0, last = 0, acc = 0, frames = 0;
    var frameMs = 1000 / o.fps;
    var sprite = makeSprite(o.image);

    // ---- flakes --------------------------------------------------------
    function spawn(i, top) {
      var f = Math.random();
      fs[i] = Math.round(o.size[0] + f * (o.size[1] - o.size[0]));
      fv[i] = o.speed[0] + f * (o.speed[1] - o.speed[0]);
      fx[i] = Math.random() * W;
      fy[i] = top ? -fs[i] : Math.random() * H;
      fp[i] = Math.random() * 6.28;
      ig[i] = -1;               // id of a surface this flake is allowed to pass through
    }

    function setCount() {
      var want = Math.round(target * quality);
      while (n < want) spawn(n++, false);
      n = want;
    }

    function resize() {
      var pr = o.pixelRatio;
      W = global.innerWidth; H = global.innerHeight;
      cv.width = (W * pr) | 0; cv.height = (H * pr) | 0;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      target = Math.max(o.minCount, Math.min(maxN, Math.round(o.count * W * H / 921600)));
      setCount();
      refresh();
    }

    // ---- tagged elements -> surfaces ------------------------------------
    // Positions are cached in *page* coordinates, so scrolling costs nothing.
    function refresh() {
      var els = document.querySelectorAll('[data-snow]');
      var seen = new Set(), list = [], sx = global.scrollX, sy = global.scrollY;
      for (var i = 0; i < els.length; i++) {
        var el = els[i], r = el.getBoundingClientRect();
        if (r.width < 16) continue;                       // hidden / tiny
        var S = map.get(el);
        if (!S) { S = { id: ++uid, h: new Float32Array(0), any: false }; map.set(el, S); }
        S.fixed = global.getComputedStyle(el).position === 'fixed';
        S.left = r.left + (S.fixed ? 0 : sx);
        S.top = r.top + (S.fixed ? 0 : sy);
        S.w = r.width;
        var cols = Math.ceil(r.width / BIN);
        if (cols !== S.h.length) {                        // element resized: keep the snow
          var nh = new Float32Array(cols);
          nh.set(S.h.subarray(0, Math.min(cols, S.h.length)));
          S.h = nh;
        }
        S.max = parseFloat(el.getAttribute('data-snow-max')) || o.maxPile;
        var p = parseFloat(el.getAttribute('data-snow-pass'));
        S.pass = isNaN(p) ? o.passChance : p;
        seen.add(S); list.push(S);
      }
      map.forEach(function (S, el) { if (!seen.has(S)) map.delete(el); });
      surfs = list;
    }

    // Drop snow on column c; it rolls downhill first so piles stay smooth.
    function land(S, c, size) {
      var h = S.h, end = h.length - 1;
      for (var t = 0; t < 6; t++) {
        if (c > 0 && h[c] > h[c - 1] + 1.5) c--;
        else if (c < end && h[c] > h[c + 1] + 1.5) c++;
        else break;
      }
      var amt = size * 0.12 * o.buildSpeed;
      for (var d = -2; d <= 2; d++) {
        var q = c + d;
        if (q < 0 || q > end) continue;
        h[q] = Math.min(S.max, h[q] + amt * (1 - Math.abs(d) * 0.3));
      }
      S.any = true;
    }

    // ---- main loop -----------------------------------------------------
    function frame(t) {
      raf = global.requestAnimationFrame(frame);
      var dt = t - last;
      if (dt < frameMs - 2) return;                       // fps cap
      last = t;
      if (dt > 100) dt = frameMs;                         // first frame / tab was hidden
      adapt(dt);
      dt /= 1000;

      var sx = global.scrollX, sy = global.scrollY, m = 0, i, j, S;

      // which surfaces are on screen this frame?
      for (j = 0; j < surfs.length; j++) {
        S = surfs[j];
        S.vl = S.left - (S.fixed ? 0 : sx);
        S.vt = S.top - (S.fixed ? 0 : sy);
        if (S.vt > -S.max - 20 && S.vt < H + 20 && S.vl < W && S.vl + S.w > 0) act[m++] = S;
      }

      ctx.clearRect(0, 0, W, H);

      for (i = 0; i < n; i++) {
        fp[i] += dt * 1.3;
        var nx = fx[i] + (Math.sin(fp[i]) * o.sway + o.wind) * dt;
        var ny = fy[i] + fv[i] * dt;
        var bottom = ny + fs[i] * 0.4;

        for (j = 0; j < m; j++) {
          S = act[j];
          if (S.id === ig[i] || nx < S.vl || nx >= S.vl + S.w) continue;
          var c = ((nx - S.vl) / BIN) | 0;
          var surface = S.vt - S.h[c];
          if (bottom >= surface && bottom < surface + 8 + fv[i] * dt) {
            if (Math.random() < S.pass) { ig[i] = S.id; }  // falls straight through
            else { land(S, c, fs[i]); spawn(i, true); nx = fx[i]; ny = fy[i]; break; }
          }
        }

        if (ny > H + 10) { spawn(i, true); continue; }
        if (nx < -20) nx = W + 20; else if (nx > W + 20) nx = -20;
        fx[i] = nx; fy[i] = ny;
        var z = fs[i];
        ctx.drawImage(sprite, (nx - z / 2) | 0, (ny - z / 2) | 0, z, z);
      }

      // piles: one filled path per surface
      ctx.fillStyle = o.pileColor;
      for (j = 0; j < m; j++) {
        S = act[j];
        if (!S.any) continue;
        var h = S.h, len = h.length;
        ctx.beginPath();
        ctx.moveTo(S.vl, S.vt + 1);
        for (var q = 0; q < len; q++) {
          var e = Math.min(q, len - 1 - q) * BIN / 10;    // soften the ends
          ctx.lineTo(S.vl + q * BIN + BIN / 2, S.vt - h[q] * (e < 1 ? e : 1));
        }
        ctx.lineTo(S.vl + S.w, S.vt + 1);
        ctx.fill();
      }
    }

    // If the device struggles, quietly use fewer flakes (never goes back up).
    function adapt(dt) {
      acc += dt;
      if (++frames < 90) return;
      var avg = acc / frames;
      acc = frames = 0;
      if (avg > frameMs * 1.5 && quality > 0.3) { quality -= 0.2; setCount(); }
    }

    // ---- public controls -------------------------------------------------
    function resume() {
      if (raf) return;
      last = 0;
      raf = global.requestAnimationFrame(frame);
      timer = global.setInterval(refresh, 1500);          // catches layout shifts
    }
    function pause() {
      global.cancelAnimationFrame(raf); raf = 0;
      global.clearInterval(timer);
    }
    function clear() {
      surfs.forEach(function (S) { S.h.fill(0); S.any = false; });
    }
    function onResize() { global.clearTimeout(rt); rt = global.setTimeout(resize, 150); }
    function destroy() {
      pause();
      global.removeEventListener('resize', onResize);
      if (cv.parentNode) cv.parentNode.removeChild(cv);
    }

    global.addEventListener('resize', onResize);
    resize();
    resume();
    return { pause: pause, resume: resume, clear: clear, refresh: refresh, destroy: destroy };
  }

  // Flake sprite: rendered ONCE to a small canvas, then just stamped each frame.
  // (Drawing an SVG directly every frame is slow, so we rasterize it first.)
  function makeSprite(src) {
    var c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    var g = c.getContext('2d'), r = SPRITE / 2;
    var grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(255,255,255,.95)');
    grad.addColorStop(0.5, 'rgba(255,255,255,.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    if (src) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
        var k = Math.min(SPRITE / w, SPRITE / h);
        g.clearRect(0, 0, SPRITE, SPRITE);
        g.drawImage(img, (SPRITE - w * k) / 2, (SPRITE - h * k) / 2, w * k, h * k);
      };
      img.src = src;
    }
    return c;
  }

  global.Snow = { start: start };
})(window);
