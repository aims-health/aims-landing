/* AiMS wave line, v4 (22 Oct 2026).
   One continuous path for the whole page, generated once from the section layout.
   - Desktop: waypoints sit behind the product screens and in the side gutters. A monotone cubic
     (x as a function of y, PCHIP) runs through them, so the line can't loop, kink or overshoot, and
     every join shares its point and tangent. Any stretch that would touch text is pushed clear;
     if that fails, the whole line falls back to the gutter.
   - Phone and tablet: one gentle line down the left gutter, one waypoint per section.
   - It finishes by drawing the AiMS wave mark in the last section.
   - Story colour (v4.1): the line runs exactly through the dated dots of the story timeline. Around the
     setback dots it blends from purple to flag red (#EF4444) or watch amber (#F59E0B) and back. It's one vertical gradient in
     user space, computed once, so it follows the path's direction (the path only ever runs down the page).
     One stroke width, and no filters or shadows.
   - Drawn on scroll inside requestAnimationFrame. The long line is revealed top-down by two
     counter-moving transforms on composited layers (no repaint); only the short mark at the end uses
     stroke-dashoffset. The scroll handler is passive and reads only scrollY.
   - Rebuilt only when the width changes (resize, orientation) or once after web fonts settle.
   - prefers-reduced-motion: the whole line shows at once and nothing is animated. */
(function () {
  'use strict';
  var root = document.querySelector('.page');
  if (!root || !document.createElementNS) return;
  var NS = 'http://www.w3.org/2000/svg';
  var COLOUR = '#8B3DFF', PURPLE = COLOUR, TONES = { flag: '#EF4444', watch: '#F59E0B' };
  var mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduce = !!(mq && mq.matches) || /full/.test(location.hash);
  var S = null, DOTS = [];  // built state (see render) and the story dots
  var lastW = 0, lastH = 0, ticking = false, lastOff = -1;

  function rel(el, ox, oy) {
    var r = el.getBoundingClientRect();
    return { l: r.left - ox, r: r.right - ox, t: r.top - oy, b: r.bottom - oy, w: r.width, h: r.height,
             x: r.left - ox + r.width / 2, y: r.top - oy + r.height / 2 };
  }
  // the box the words actually fill (a short line in a wide paragraph leaves the rest free)
  function textRect(el, ox, oy) {
    var rg = document.createRange(); rg.selectNodeContents(el);
    var r = rg.getBoundingClientRect();
    if (!r.width) return rel(el, ox, oy);
    return { l: r.left - ox, r: r.right - ox, t: r.top - oy, b: r.bottom - oy };
  }
  function visible(el) { return el.offsetParent !== null || el.getClientRects().length > 0; }

  // Monotone cubic (Fritsch-Carlson) through points sorted by y. Returns cubic Beziers [p0,p1,p2,p3].
  function pchip(P) {
    var n = P.length, h = [], d = [], m = [], i, out = [];
    for (i = 0; i < n - 1; i++) { h[i] = P[i + 1].y - P[i].y; d[i] = (P[i + 1].x - P[i].x) / h[i]; }
    m[0] = 0; m[n - 1] = 0;                                     // vertical at both ends
    for (i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;                       // turning point: vertical tangent
      else { var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
    }
    for (i = 0; i < n - 1; i++) {
      var a = P[i], b = P[i + 1], k = h[i] / 3;
      out.push([[a.x, a.y], [a.x + m[i] * k, a.y + k], [b.x - m[i + 1] * k, b.y - k], [b.x, b.y]]);
    }
    return out;
  }
  function bez(c, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, e = 3 * u * t * t, f = t * t * t;
    return [a * c[0][0] + b * c[1][0] + e * c[2][0] + f * c[3][0], a * c[0][1] + b * c[1][1] + e * c[2][1] + f * c[3][1]];
  }
  // first text box a set of curves runs into, or null
  function hit(curves, boxes) {
    for (var i = 0; i < curves.length; i++) {
      var c = curves[i], steps = Math.max(8, Math.ceil(Math.abs(c[3][1] - c[0][1]) / 6));
      for (var s = 0; s <= steps; s++) {
        var p = bez(c, s / steps);
        for (var j = 0; j < boxes.length; j++) { var q = boxes[j]; if (p[0] > q.l && p[0] < q.r && p[1] > q.t && p[1] < q.b) return { x: p[0], y: p[1], q: q, i: i }; }
      }
    }
    return null;
  }
  // drop waypoints that crowd the one before (keeps the curves long and the tension even)
  function thin(P, gap) {
    var out = [P[0]];
    for (var i = 1; i < P.length; i++) { if (P[i].y - out[out.length - 1].y >= gap || P[i].keep) out.push(P[i]); }
    for (var k = 1; k < out.length; k++) if (out[k].y <= out[k - 1].y + 1) out[k].y = out[k - 1].y + 1;
    return out;
  }

  function build() {
    [].slice.call(root.querySelectorAll(':scope > .wave')).forEach(function (o) { o.parentNode.removeChild(o); });
    root.classList.add('measuring');                            // reveal transforms off while we read the layout
    var R0 = root.getBoundingClientRect(), ox = R0.left, oy = R0.top, W = R0.width, H = root.offsetHeight;
    var vw = innerWidth, vh = innerHeight, phone = vw < 900;
    var secs = [].slice.call(root.querySelectorAll(':scope > section')).filter(visible);
    var last = secs[secs.length - 1], markBox = last && last.querySelector('.mark-box');
    if (!secs.length || !markBox) { root.classList.remove('measuring'); return; }
    var wrap = secs[0].querySelector('.wrap'), WR = wrap ? rel(wrap, ox, oy) : { l: 40, r: W - 40 };
    var padL = wrap ? parseFloat(getComputedStyle(wrap).paddingLeft) || 0 : 0;
    var MB = rel(markBox, ox, oy), hdr = root.querySelector('.hdr'), top0 = hdr ? rel(hdr, ox, oy).b + 24 : 90;
    var P = [], curves, i;
    DOTS = [];
    function dotsIn(s) {
      return [].slice.call(s.querySelectorAll('.tl-dot')).filter(visible).map(function (el) {
        var q = rel(el, ox, oy), t = el.getAttribute('data-tone'), d = { x: q.x, y: q.y, keep: true, fixed: true, el: el, tone: t === 'spike' ? 'flag' : t };
        DOTS.push(d); return d;
      });
    }

    if (phone) {
      // ---- phone and tablet: the gutter between the screen edge and the content ----
      var gx = Math.max(10, (WR.l + padL) * 0.42), amp = Math.min(6, gx * 0.35);
      P.push({ x: gx, y: top0 });
      secs.forEach(function (s, k) {
        if (s === last) return;
        var q = rel(s, ox, oy), ds = dotsIn(s);
        if (ds.length) { P.push.apply(P, ds); return; }
        P.push({ x: gx + (k % 2 ? -amp : amp), y: q.t + q.h * 0.5 });
      });
      P = thin(P, 260);
      curves = finish(P, gx, MB, W, true, false);
    } else {
      // ---- desktop: behind the product screens, through the gaps, in the gutters ----
      var GL = Math.max(16, (WR.l + padL) * 0.5), GR = W - GL, PADX = Math.min(22, (WR.l + padL) * 0.35);
      var boxes = [].slice.call(root.querySelectorAll('h1,h2,h3,h4,p,li,time,blockquote,label,input,select,textarea,table,.btn,.eyebrow,.tag,.card,.price,.tier,.pt,.wall>div,.status>div,.form,.pcmp,.facts>div,.legal-doc,.qa,.cap,.who-card,.step-n,.chip,.brief,.tcard,.tmid,.feat,.team-wrap'))
        .filter(function (e) { return visible(e) && !e.closest('footer') && !e.closest('.shot,.phone,.ph-slot,.bezel') && !e.classList.contains('tl-ev'); })
        .map(function (e) { var q = /^(P|H1|H2|H3|H4|LI|BLOCKQUOTE|TIME)$/.test(e.tagName) ? textRect(e, ox, oy) : rel(e, ox, oy); return { l: q.l - PADX, r: q.r + PADX, t: q.t - 18, b: q.b + 18 }; })
        .filter(function (q) { return q.b < MB.t; });
      var side = null;
      secs.forEach(function (s) {
        if (s === last) return;
        var q = rel(s, ox, oy);
        var media = [].slice.call(s.querySelectorAll('.media .shot,.media .phone,.media .ph-slot,.media .bezel,.ph-slot.media')).filter(visible).map(function (m) { return rel(m, ox, oy); });
        var ds = dotsIn(s);
        if (ds.length) {                                         // enter and leave the timeline straight, clear of the labels
          var f0 = ds[0], f1 = ds[ds.length - 1], g = Math.min(130, (ds.length > 1 ? (ds[1].y - f0.y) : 190) * 0.68);
          P.push({ x: f0.x, y: f0.y - g, keep: true, fixed: true }); P.push.apply(P, ds); P.push({ x: f1.x, y: f1.y + g, keep: true, fixed: true });
          side = f1.x < W / 2 ? 'L' : 'R';
        }
        else if (media.length) {
          media.forEach(function (m) {
            var x = m.l + m.w * (m.x < W / 2 ? 0.38 : 0.62);       // a little off-centre, towards the outside
            P.push({ x: x, y: m.t + m.h * 0.5 });
            side = m.x < W / 2 ? 'L' : 'R';
          });
        } else {
          // no screen to sit behind: use a gutter. Coming from the middle of the page (a timeline, a screen),
          // take the right one, because section headings sit on the left.
          var px = P.length ? P[P.length - 1].x : 0;
          if (!side || (px > W * 0.2 && px < W * 0.8)) side = 'R';
          P.push({ x: side === 'L' ? GL : GR, y: q.t + q.h * 0.5 });
        }
      });
      // start just under the header, straight above the first waypoint
      P.unshift({ x: P.length ? P[0].x : GL, y: top0 });
      P = thin(P, 220);
      // settle into the nearest gutter before the turn into the mark (added before the repair pass, so it's checked too)
      var settleR = P[P.length - 1].x > W / 2;
      P.push({ x: settleR ? GR : GL, y: Math.min(P[P.length - 1].y + 300, MB.t - 200) });
      // push any stretch that touches text out into clear space (nearest side of the text, or the gutter)
      for (var it = 0; it < 40; it++) {
        curves = pchip(P);
        var c = hit(curves, boxes);
        if (!c) break;
        var nx = (c.x - c.q.l < c.q.r - c.x) ? c.q.l - 6 : c.q.r + 6;
        nx = Math.max(GL, Math.min(GR, nx));
        if (nx > c.q.l && nx < c.q.r) nx = (c.x < W / 2) ? GL : GR;
        // hold the clear x along the whole height of the box: points at its top and bottom edges, inside this stretch
        var at = c.i + 1, y0 = P[at - 1].y, y1 = P[at].y;
        [c.q.t, c.q.b].forEach(function (yy) {
          var lim0 = P[at - 1].fixed ? 12 : 30, lim1 = P[at].fixed ? 12 : 30;   // never move a dated dot; squeeze in next to it instead
          if (yy <= y0 + lim0 || yy >= y1 - lim1) { var j = Math.abs(yy - y0) < Math.abs(yy - y1) ? at - 1 : at; if (Math.abs(P[j].y - yy) < 60 && j > 0 && !P[j].fixed) P[j].x = nx; return; }
          P.splice(at, 0, { x: nx, y: yy, keep: true }); if (yy === c.q.t) at++;
        });
        P.sort(function (p, q) { return p.y - q.y; });
      }
      if (hit(pchip(P), boxes)) {                                // safety net: the plain gutter line
        P = [{ x: GL, y: top0 }];
        secs.forEach(function (s, k) { if (s === last) return; var q = rel(s, ox, oy); P.push({ x: GL + (k % 2 ? -1 : 1) * Math.min(10, GL * 0.3), y: q.t + q.h * 0.5 }); });
        P = thin(P.filter(function (p) { return !DOTS.some(function (d) { return Math.abs(d.y - p.y) < 220; }); }).concat(DOTS).sort(function (a, b) { return a.y - b.y; }), 300);
      }
      curves = finish(P, P[P.length - 1].x > W / 2 ? GR : GL, MB, W, false, P[P.length - 1].x > W / 2);
    }
    root.classList.remove('measuring');
    render(curves, W, H, vh, phone);
  }

  // last waypoint -> the AiMS mark across .mark-box, with no corner where the line becomes the mark.
  // From the left the line curves straight into the mark's first stroke (its start is flat, then rises).
  // From the right the line itself becomes the mark's right arm: it sweeps down into the trough and
  // carries on as the wave, so the mark's sharp top-right tip is never a join.
  function finish(P, gx, MB, W, phone, fromRight) {
    var t14 = Math.tan(14 * Math.PI / 180), bx0 = MB.l, bx1 = MB.r, by0 = MB.t, by1 = MB.b, cy = (by0 + by1) / 2;
    function M(u, v) { var px = bx0 + (u - 1) / 59 * (bx1 - bx0), py = by0 + (v + 4) / 32 * (by1 - by0); return [px - t14 * (py - cy), py]; }
    var seg = [[[1, 28], [6, 28], [12, 8], [20, 8]], [[20, 8], [28, 8], [32, 24], [42, 24]], [[42, 24], [52, 24], [56, -4], [60, -4]]];
    if (fromRight) seg = seg.reverse().map(function (g) { return g.slice().reverse(); }).slice(1);   // start at the trough
    else seg[0][1] = [10, 28];                                   // ease the mark's first bend so it matches the incoming curve
    var T = M(seg[0][0][0], seg[0][0][1]), dx = Math.abs(gx - T[0]);
    var drop = fromRight ? Math.max(by1 - by0, dx * 0.85) : Math.max(28, dx);
    var y0 = T[1] - drop, lastP = P[P.length - 1];
    if (y0 - lastP.y < 160) P[P.length - 1] = { x: gx, y: Math.min(lastP.y, y0 - 160) };
    P.push({ x: gx, y: y0, keep: true });
    var curves = pchip(P), dir = T[0] > gx ? 1 : -1;
    // one cubic: vertical at the gutter, horizontal (in the mark's direction) where it meets the mark. Its last
    // handle is sized so its bend at the join equals the mark's bend there (curvature-continuous: no visible seam).
    var c1 = M(seg[0][1][0], seg[0][1][1]), c2 = M(seg[0][2][0], seg[0][2][1]);
    var ax = c1[0] - T[0], ay = c1[1] - T[1], bx = c2[0] - c1[0], by = c2[1] - c1[1], la = Math.hypot(ax, ay);
    var k0 = la ? (2 / 3) * Math.abs(ax * by - ay * bx) / (la * la * la) : 0;   // the mark's curvature where it starts
    var p1y = y0 + drop * 0.55, hh = Math.abs(T[1] - p1y);
    var hand = k0 > 0 ? Math.sqrt((2 / 3) * hh / k0) : dx * 0.4;
    hand = Math.max(dx * 0.15, Math.min(dx * 0.85, hand));
    // the hand-over to the mark's own path happens here, on the straight vertical stretch, so the swoop and the
    // logo are one stroke and the two round caps overlap on a straight line (invisible)
    curves.markFrom = curves.length;
    curves.push([[gx, y0], [gx, p1y], [T[0] - dir * hand, T[1]], T]);
    seg.forEach(function (g) { curves.push([curves[curves.length - 1][3], M(g[1][0], g[1][1]), M(g[2][0], g[2][1]), M(g[3][0], g[3][1])]); });
    return curves;
  }

  function pathD(cs) {
    var f = function (v) { return Math.round(v * 10) / 10; }, d = 'M' + f(cs[0][0][0]) + ' ' + f(cs[0][0][1]);
    cs.forEach(function (c) { d += 'C' + f(c[1][0]) + ' ' + f(c[1][1]) + ' ' + f(c[2][0]) + ' ' + f(c[2][1]) + ' ' + f(c[3][0]) + ' ' + f(c[3][1]); });
    return d;
  }
  function svgWith(d, w, h, vb, sw) {
    var svg = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', vb);
    p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', COLOUR);
    p.setAttribute('stroke-width', sw); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p); return svg;
  }

  // Setback colour: each run of dots marked data-tone="flag" (red #EF4444) or "watch" (amber #F59E0B)
  // blends in just before its first dot, holds through its last, and blends back to purple before the
  // next dot. All runs are stops on one vertical user-space gradient (the path only runs down the page).
  function storyGradient(H) {
    var D = DOTS.slice().sort(function (p, q) { return p.y - q.y; }), stops = [[0, PURPLE]], i = 0;
    while (i < D.length) {
      if (!TONES[D[i].tone]) { i++; continue; }
      var j = i; while (j + 1 < D.length && D[j + 1].tone === D[i].tone) j++;
      var c = TONES[D[i].tone], prev = D[i - 1], next = D[j + 1], y0 = D[i].y, y1 = D[j].y;
      var a = prev ? Math.max(prev.y + 12, y0 - 110) : y0 - 110;
      var z = next ? Math.min(next.y - 12, y1 + (next.y - y1) * 0.7) : y1 + 140;
      stops.push([a, PURPLE], [y0 - 14, c], [y1 + 14, c], [z, PURPLE]);
      i = j + 1;
    }
    if (stops.length === 1) return null;
    stops.push([H, PURPLE]);
    var g = document.createElementNS(NS, 'linearGradient'), defs = document.createElementNS(NS, 'defs'), last = 0;
    g.setAttribute('id', 'wave-story'); g.setAttribute('gradientUnits', 'userSpaceOnUse');
    g.setAttribute('x1', 0); g.setAttribute('y1', 0); g.setAttribute('x2', 0); g.setAttribute('y2', H);
    stops.forEach(function (st) { var o = Math.max(last, Math.max(0, Math.min(1, st[0] / H))); last = o; var e = document.createElementNS(NS, 'stop'); e.setAttribute('offset', o.toFixed(5)); e.setAttribute('stop-color', st[1]); g.appendChild(e); });
    defs.appendChild(g); return defs;
  }

  // The long line is drawn once and revealed top-down by two counter-moving transforms on composited
  // layers (no repaint while scrolling, because the path runs steadily down the page). Only the short AiMS
  // mark at the end uses stroke-dashoffset.
  function render(curves, W, H, vh, phone) {
    var sw = phone ? 4 : 6, main = curves.slice(0, curves.markFrom), mark = curves.slice(curves.markFrom);
    // The line is cut into stacked tiles (about 1,200 px each). Each tile is a clip with the same path
    // inside, offset by its viewBox, so user-space coordinates (and the gradient) are shared. Small layers
    // stay composited on every browser; one page-tall layer would be dropped back to repainting.
    var d = pathD(main), TILE = 1200, tiles = [], n = Math.ceil(H / TILE), gradOk = !!storyGradient(H), first = null;
    for (var ti = 0; ti < n; ti++) {
      var y0 = ti * TILE, h = Math.min(TILE, H - y0);
      var clip = document.createElement('div');
      clip.className = 'wave'; clip.setAttribute('aria-hidden', 'true');
      clip.style.cssText = 'position:absolute;left:0;top:' + y0 + 'px;width:' + W + 'px;height:' + h + 'px;overflow:hidden;z-index:1;pointer-events:none;will-change:transform';
      var inner = svgWith(d, W, h, '0 ' + y0 + ' ' + W + ' ' + h, sw);
      if (gradOk) { var g = storyGradient(H), id = 'wave-story-' + ti; g.firstChild.setAttribute('id', id); inner.insertBefore(g, inner.firstChild); inner.lastChild.setAttribute('stroke', 'url(#' + id + ')'); }
      inner.style.cssText = 'position:absolute;left:0;top:0;will-change:transform';
      clip.appendChild(inner);
      tiles.push({ clip: clip, inner: inner, y0: y0, h: h, v: -1 });
      if (!first) first = clip;
    }
    // the mark: its own small svg, positioned over its own box
    var xs = [], ys = []; mark.forEach(function (c) { c.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
    var mx = Math.min.apply(0, xs) - 10, my = Math.min.apply(0, ys) - 10, mw = Math.max.apply(0, xs) - mx + 10, mh = Math.max.apply(0, ys) - my + 10;
    var msvg = svgWith(pathD(mark), mw, mh, mx + ' ' + my + ' ' + mw + ' ' + mh, sw);
    msvg.setAttribute('class', 'wave'); msvg.style.cssText = 'position:absolute;left:' + mx + 'px;top:' + my + 'px;z-index:1;pointer-events:none;overflow:visible';
    root.insertBefore(msvg, root.firstChild);
    for (var tj = tiles.length - 1; tj >= 0; tj--) root.insertBefore(tiles[tj].clip, root.firstChild);
    var mp = msvg.firstChild, ML = mp.getTotalLength();
    mp.style.strokeDasharray = ML + ' ' + ML;

    // scroll -> reveal. The tip sits at tipK of the screen height; the mark draws over the next 45% of a
    // screen. If the page is too short for that, the whole mapping is compressed so it ends at the bottom.
    var tipK = phone ? 0.8 : 0.74, maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
    var mainEnd = main[main.length - 1][3][1] + sw, mStart = mainEnd - tipK * vh, mSpan = vh * 0.45;
    var a = Math.max(1, (mStart + mSpan) / maxScroll);
    S = { tiles: tiles, mark: mp, ML: ML, H: H, a: a, tipK: tipK * vh, mStart: mStart, mSpan: mSpan, mainEnd: mainEnd };
    S.dots = DOTS.slice().sort(function (p, q) { return p.y - q.y; }); S.di = 0;
    S.dots.forEach(function (d) { d.el.classList.remove('on'); d.el.parentNode.classList.remove('on'); });
    root.classList.add('wave-on');                               // story labels now wait for the line
    lastOff = -1; lastTip = -1;
    if (reduce) { set(H, 0); return; }
    draw();
  }
  var lastTip = -1;
  function set(tip, off) {
    if (tip !== lastTip) {
      for (var k = 0; k < S.tiles.length; k++) {                // only the tile at the tip changes
        var t = S.tiles[k], v = Math.max(0, Math.min(t.h, tip - t.y0));
        if (v !== t.v) { t.clip.style.transform = 'translate3d(0,' + (v - t.h) + 'px,0)'; t.inner.style.transform = 'translate3d(0,' + (t.h - v) + 'px,0)'; t.v = v; }
      }
      lastTip = tip;
    }
    if (off !== lastOff) { S.mark.style.strokeDashoffset = off; lastOff = off; }
    var D = S.dots;                                              // a dot lights up as the line reaches it
    while (S.di < D.length && D[S.di].y <= tip) { var e = D[S.di++].el; e.classList.add('on'); e.parentNode.classList.add('on'); }
    while (S.di > 0 && D[S.di - 1].y > tip) { var f = D[--S.di].el; f.classList.remove('on'); f.parentNode.classList.remove('on'); }
  }
  function draw() {
    ticking = false;
    if (!S) return;
    var y = window.pageYOffset * S.a;
    var tip = Math.round(Math.min(S.H, Math.max(0, y + S.tipK)) * 2) / 2;
    var mf = Math.min(1, Math.max(0, (y - S.mStart) / S.mSpan));
    if (tip >= S.mainEnd) tip = S.H;
    set(tip, Math.round(S.ML * (1 - mf) * 2) / 2);
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(draw); } }

  function maybeBuild(force) {
    var w = root.offsetWidth, h = root.offsetHeight;
    if (!force && w === lastW && Math.abs(h - lastH) < 2) return;
    lastW = w; lastH = h; build();
  }
  var rt;
  function onResize() { if (root.offsetWidth === lastW) return; clearTimeout(rt); rt = setTimeout(function () { maybeBuild(true); }, 200); }

  maybeBuild(true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { maybeBuild(false); });
  addEventListener('load', function () { maybeBuild(false); });
  addEventListener('resize', onResize, { passive: true });
  addEventListener('orientationchange', function () { setTimeout(function () { maybeBuild(true); }, 250); }, { passive: true });
  if (!reduce) addEventListener('scroll', onScroll, { passive: true });
  if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { reduce = e.matches; maybeBuild(true); });

  // v5 scenes, Apple style: as a scene scrolls through the screen its device turns from a few degrees to flat and
  // settles (scroll-scrubbed), with a little parallax, and its words fade up just ahead of it. Scene positions are
  // cached (rebuilt only on resize/fonts); each frame reads scrollY only and writes transforms and opacity.
  var scn = [].slice.call(document.querySelectorAll('.scene'));
  if (scn.length && !reduce) {
    var SC = [], vhS = innerHeight, sq = false, smallS = innerWidth < 900;
    var cache = function () {
      vhS = innerHeight; smallS = innerWidth < 900;
      SC = scn.map(function (s) { var r = s.getBoundingClientRect(); return { top: r.top + window.pageYOffset, h: r.height, dev: s.querySelector('.device'), tx: s.querySelector('.tx'), rev: s.querySelector('.scene-grid.rev') !== null, hero: s.classList.contains('hero-scene') }; });
    };
    var paint = function () {
      sq = false;
      var y = window.pageYOffset;
      for (var i = 0; i < SC.length; i++) {
        var c = SC[i], p = (y + vhS - c.top) / (vhS + c.h);          // 0 entering at the bottom, 1 leaving at the top
        if (p < -0.05 || p > 1.05) continue;
        p = Math.max(0, Math.min(1, p));
        var t = Math.min(1, p / 0.45), e = 1 - Math.pow(1 - t, 3);   // turns in over the first 45%, then holds
        var side = c.rev ? -1 : 1, ry = (smallS ? 0 : (c.hero ? 0 : 16 * side)) * (1 - e), rx = (smallS ? 6 : 10) * (1 - e);
        var ty = (smallS ? 30 : 70) * (1 - e) - (p - 0.5) * (smallS ? 20 : 50);  // settles, then drifts slowly (parallax)
        var sc = 0.92 + 0.08 * e;
        if (c.dev) c.dev.style.transform = 'perspective(1800px) translate3d(0,' + ty.toFixed(1) + 'px,0) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) scale(' + sc.toFixed(3) + ')';
        if (c.tx) { var o = Math.max(0, Math.min(1, (p - (c.hero ? 0 : 0.04)) / (c.hero ? 0.12 : 0.2))); c.tx.style.opacity = o.toFixed(3); c.tx.style.transform = 'translate3d(0,' + (24 * (1 - o)).toFixed(1) + 'px,0)'; }
      }
    };
    var tick = function () { if (!sq) { sq = true; requestAnimationFrame(paint); } };
    cache(); paint();
    addEventListener('scroll', tick, { passive: true });
    addEventListener('resize', function () { clearTimeout(cache.t); cache.t = setTimeout(function () { cache(); paint(); }, 200); }, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { cache(); paint(); });
    addEventListener('load', function () { cache(); paint(); });
  }

  // demo clips: silent loops that play only while at least half on screen; poster only with reduced motion
  var vids = document.querySelectorAll('video.clip');
  if (vids.length && 'IntersectionObserver' in window) {
    // warm up: when a clip is within about a screen, load it while the browser is idle, so starting it later
    // doesn't set up the decoder in the middle of a scroll
    var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 200); };
    var warm = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting || reduce) return;
        var v = e.target; warm.unobserve(v);
        idle(function () { v.preload = 'auto'; v.load(); }, { timeout: 1500 });
      });
    }, { rootMargin: '900px 0px' });
    for (var wi = 0; wi < vids.length; wi++) warm.observe(vids[wi]);
    var vio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var v = e.target;
        if (reduce) { v.pause(); return; }
        if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else if (!v.paused) v.pause();
      });
    }, { threshold: 0.5 });
    for (var vi = 0; vi < vids.length; vi++) vio.observe(vids[vi]);
  }

  // reveal-on-scroll for content (opacity and transform only). Off with reduced motion.
  var els = document.querySelectorAll('.rv');
  if (reduce || !('IntersectionObserver' in window)) { for (var i = 0; i < els.length; i++) els[i].classList.add('in'); return; }
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
  for (var j = 0; j < els.length; j++) io.observe(els[j]);
})();
