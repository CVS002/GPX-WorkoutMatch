"use strict";
/* Native in-app route map — renders the SVG the app used to embed as an iframe
   widget. Consumes /api/mapdata (route, per-km tiers, hazards, stops, streets)
   and the live effort segments; draws everything itself so the map, legend,
   hazard popovers and Street View are all first-class app UI.

   window.WDMap.mount(...) once; then load()/setSegs()/setRide()/setLayers(). */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const VBW = 820, VBH = 470, PAD = 16;
  const TIER = { g: "#2e9e5b", m: "#d99a2b", p: "#d1495b" };   // clean / caution / avoid
  const NEUTRAL = "#9aa0a6";
  const KIND = { warmup: "#9aa0a6", work: "#3b6fd4", rest: "#b8bcc2", tt: "#8b3fc4", cooldown: "#9aa0a6" };
  const HAZNAME = {
    traffic_signal: "traffic light", level_crossing: "level crossing", roundabout: "roundabout",
    give_way: "give-way", stop_sign: "stop sign", yield_left: "left-turn into priority",
    right_before_left: "priority from right", recurring_stop: "recurring stop",
  };
  // which legend toggle each hazard type belongs to
  function group(t) {
    if (t === "give_way" || t === "stop_sign" || t === "yield_left") return "giveway";
    if (t === "right_before_left") return "priority";
    if (t === "recurring_stop") return "stops";
    return "signals";
  }
  const fmtKm = (v) => (Math.round(v * 10) / 10).toString();
  const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

  const M = {
    svg: null, wrap: null, opts: {},
    data: null, segs: [], ride: null, rideThresh: 33,
    vis: { streets: true, effort: true, bands: true, signals: true, giveway: true, priority: true, stops: true, ride: true },
    g: {}, prj: null, XY: [], KM: [], vb: { x: 0, y: 0, w: VBW, h: VBH },
  };

  function mount(svg, opts) {
    M.svg = svg; M.wrap = svg.parentElement; M.opts = opts || {};
    ["streets", "base", "ride", "work", "mark", "flag", "label"].forEach(name => {
      const g = mk("g", {}); M.g[name] = g; svg.appendChild(g);
    });
    wireZoomPan();
  }

  // ---- projection (equirectangular, fit route bounds into the viewBox) ----
  function buildProjection() {
    const b = M.data.bounds;
    const mLat = (b.minLa + b.maxLa) / 2, kx = Math.cos(mLat * Math.PI / 180);
    const spanX = (b.maxLo - b.minLo) * kx || 1e-6, spanY = (b.maxLa - b.minLa) || 1e-6;
    const sc = Math.min((VBW - 2 * PAD) / spanX, (VBH - 2 * PAD) / spanY);
    const offX = (VBW - spanX * sc) / 2, offY = (VBH - spanY * sc) / 2;
    M.prj = (la, lo) => [offX + (lo - b.minLo) * kx * sc, VBH - (offY + (la - b.minLa) * sc)];
    M.XY = M.data.route.map(p => M.prj(p[0], p[1]));
    M.KM = M.data.route.map(p => p[2]);
  }
  function xyAtKm(km) {
    const KM = M.KM, XY = M.XY;
    if (km <= KM[0]) return XY[0];
    if (km >= KM[KM.length - 1]) return XY[XY.length - 1];
    for (let i = 0; i < KM.length - 1; i++) {
      if (km >= KM[i] && km <= KM[i + 1]) {
        const f = (km - KM[i]) / ((KM[i + 1] - KM[i]) || 1);
        return [XY[i][0] + (XY[i + 1][0] - XY[i][0]) * f, XY[i][1] + (XY[i + 1][1] - XY[i][1]) * f];
      }
    }
    return XY[XY.length - 1];
  }
  const tierAtKm = (km) => {
    const pk = M.data.perkm[Math.min(M.data.perkm.length - 1, Math.max(0, Math.floor(km)))];
    return pk ? pk.tier : "m";
  };

  // ---- layers ----
  function drawStreets() {
    const g = M.g.streets; g.innerHTML = "";
    if (!M.vis.streets) return;
    (M.data.streets || []).forEach(way => {
      if (way.length < 2) return;
      const d = "M" + way.map(p => { const [x, y] = M.prj(p[0], p[1]); return x.toFixed(1) + " " + y.toFixed(1); }).join(" L");
      g.appendChild(mk("path", { d, fill: "none", stroke: "var(--tl-street,#c9c9c4)", "stroke-width": 1, "stroke-linecap": "round", opacity: .7 }));
    });
  }
  function colAtKm(km) { return M.vis.effort ? (TIER[tierAtKm(km)] || TIER.m) : NEUTRAL; }
  function drawBase() {
    const g = M.g.base; g.innerHTML = "";
    const XY = M.XY, KM = M.KM;
    let i = 0;
    while (i < XY.length - 1) {
      const c = colAtKm(KM[i]); let j = i;
      let d = "M" + XY[i][0].toFixed(1) + " " + XY[i][1].toFixed(1);
      while (j < XY.length - 1 && colAtKm(KM[j]) === c) { j++; d += " L" + XY[j][0].toFixed(1) + " " + XY[j][1].toFixed(1); }
      g.appendChild(mk("path", { d, fill: "none", stroke: c, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      i = j;
    }
  }
  function drawWork() {
    const g = M.g.work; g.innerHTML = "";
    if (!M.vis.bands) return;
    const bnd = [M.segs[0] ? M.segs[0].a : 0, ...M.segs.map(s => s.b)];
    M.segs.forEach((s, si) => {
      if (s.kind !== "work" && s.kind !== "tt") return;
      const a = bnd[si], b = bnd[si + 1];
      const pa = xyAtKm(a); let d = "M" + pa[0].toFixed(1) + " " + pa[1].toFixed(1);
      for (let i = 0; i < M.XY.length; i++) if (M.KM[i] > a && M.KM[i] < b) d += " L" + M.XY[i][0].toFixed(1) + " " + M.XY[i][1].toFixed(1);
      const pb = xyAtKm(b); d += " L" + pb[0].toFixed(1) + " " + pb[1].toFixed(1);
      const pa2 = mk("path", { d, fill: "none", stroke: KIND[s.kind] || "#3b6fd4", "stroke-width": 7, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: .85 });
      pa2.appendChild(tip(`${s.name} — km ${fmtKm(a)}–${fmtKm(b)} @ ${s.pct}%`));
      g.appendChild(pa2);
    });
  }
  function drawFlags() {
    const g = M.g.flag; g.innerHTML = "";
    if (M.vis.bands) {
      const bnd = M.segs.map(s => s.b).slice(0, -1);
      bnd.forEach(k => { const [x, y] = xyAtKm(k); g.appendChild(mk("circle", { cx: x, cy: y, r: 3.5, fill: "var(--tl-flag,#1a1a1a)", stroke: "#fff", "stroke-width": 1.5 })); });
    }
    const [sx, sy] = M.XY[0], [fx, fy] = M.XY[M.XY.length - 1];
    g.appendChild(tipWrap(mk("circle", { cx: sx, cy: sy, r: 5, fill: "#2e9e5b", stroke: "#fff", "stroke-width": 1.5 }), "start"));
    g.appendChild(tipWrap(mk("circle", { cx: fx, cy: fy, r: 5, fill: "#111", stroke: "#fff", "stroke-width": 1.5 }), "finish"));
  }
  function tri(x, y, r, fill, stroke, dash) {
    const a = { points: `${(x - r).toFixed(1)},${(y - r * .85).toFixed(1)} ${(x + r).toFixed(1)},${(y - r * .85).toFixed(1)} ${x.toFixed(1)},${(y + r).toFixed(1)}`, fill, stroke: stroke || "#fff", "stroke-width": 1, "stroke-linejoin": "round" };
    if (dash) a["stroke-dasharray"] = "2 1.5";
    return mk("polygon", a);
  }
  function drawMarkers() {
    const g = M.g.mark; g.innerHTML = "";
    (M.data.haz || []).forEach(h => {
      if (!M.vis[group(h.t)]) return;
      const [x, y] = M.prj(h.pos[0], h.pos[1]); const t = h.t;
      let shape;
      if (t === "give_way" || t === "stop_sign") shape = tri(x, y, 5, "#e67e22", "#fff");
      else if (t === "yield_left") shape = tri(x, y, 5, "#f1c40f", "#7a5c00");
      else if (t === "right_before_left") shape = tri(x, y, 5, "none", "#c9a400", true);
      else shape = mk("rect", { x: x - 3, y: y - 3, width: 6, height: 6, fill: "#c0392b", stroke: "#fff", "stroke-width": 1, transform: `rotate(45 ${x} ${y})` });
      shape.style.cursor = "pointer";
      shape.appendChild(tip((HAZNAME[t] || t) + " · km " + fmtKm(h.km) + " · click for details"));
      shape.addEventListener("click", e => { e.stopPropagation(); openPopover(h, x, y); });
      g.appendChild(shape);
    });
    if (M.vis.stops) (M.data.stops || []).forEach(s => {
      const [x, y] = M.prj(s.pos[0], s.pos[1]);
      const c = mk("circle", { cx: x, cy: y, r: 4, fill: "none", stroke: "#c0392b", "stroke-width": 2 });
      c.style.cursor = "pointer";
      c.appendChild(tip("recurring near-stop · km " + fmtKm(s.km) + " · click for details"));
      c.addEventListener("click", e => { e.stopPropagation(); openPopover({ t: "recurring_stop", km: s.km, pos: s.pos, stop_rate: s.stop_rate }, x, y); });
      g.appendChild(c);
    });
  }
  // ride speed overlay — pink above threshold, purple below; break on GPS gaps
  function drawRide() {
    const g = M.g.ride; g.innerHTML = "";
    if (!M.vis.ride || !M.ride || M.ride.length < 2) return;
    const P = M.ride.map(p => { const q = M.prj(p[0], p[1]); return [q[0], q[1], p[2]]; });
    const GAP = 0.004, th = M.rideThresh;
    let i = 0;
    while (i < P.length - 1) {
      const fast = P[i][2] != null && P[i][2] > th;
      let d = "M" + P[i][0].toFixed(1) + " " + P[i][1].toFixed(1), mn = P[i][2], mx = P[i][2], j = i;
      while (j < P.length - 1) {
        if (Math.abs(M.ride[j][0] - M.ride[j + 1][0]) + Math.abs(M.ride[j][1] - M.ride[j + 1][1]) > GAP) break;
        if ((P[j + 1][2] != null && P[j + 1][2] > th) !== fast) break;
        j++; d += " L" + P[j][0].toFixed(1) + " " + P[j][1].toFixed(1);
        const v = P[j][2]; if (v != null) { if (mn == null || v < mn) mn = v; if (mx == null || v > mx) mx = v; }
      }
      if (j > i) {
        const pa = mk("path", { d, fill: "none", stroke: fast ? "#e91e63" : "#8e24aa", "stroke-width": fast ? 4.5 : 2.2, opacity: fast ? .95 : .5, "stroke-linecap": "round", "stroke-linejoin": "round" });
        pa.appendChild(tip((fast ? "⚡ " : "") + (mn != null ? mn.toFixed(1) + "–" + mx.toFixed(1) + " km/h" : "no speed data")));
        g.appendChild(pa); i = j;
      } else i++;
    }
  }
  function drawLabels() {
    const g = M.g.label; g.innerHTML = "";
    if (!M.vis.labels && M.vis.labels === false) return;
    const rkm = M.data.route_km;
    for (let km = 5; km < rkm; km += 5) {
      const [x, y] = xyAtKm(km);
      const t = mk("text", { x: (x + 3).toFixed(1), y: (y - 3).toFixed(1), "font-size": 9, fill: "var(--tl-lab2,#555)", stroke: "var(--tl-labstroke,#fff)", "stroke-width": 2.5, "paint-order": "stroke" });
      t.textContent = km; g.appendChild(t);
    }
  }
  function tip(text) { const t = document.createElementNS(NS, "title"); t.textContent = text; return t; }
  function tipWrap(node, text) { node.appendChild(tip(text)); return node; }

  function redrawDynamic() { drawWork(); drawFlags(); drawRide(); }
  function redrawAll() { drawStreets(); drawBase(); drawMarkers(); drawLabels(); redrawDynamic(); }

  // ---- hazard popover (small card anchored near the marker) ----
  function openPopover(item, vx, vy) {
    closePopover();
    const r = M.svg.getBoundingClientRect(), wr = M.wrap.getBoundingClientRect();
    // viewBox coords -> screen coords -> wrap-relative
    const sx = r.left + (vx - M.vb.x) / M.vb.w * r.width;
    const sy = r.top + (vy - M.vb.y) / M.vb.h * r.height;
    const pop = document.createElement("div");
    pop.className = "map-pop"; pop.id = "mapPop";
    const name = HAZNAME[item.t] || item.t;
    const bits = [`km ${fmtKm(item.km)}`];
    if (item.c) bits.push(`${item.c} confidence`);
    if (item.turn) bits.push(`${item.turn} turn`);
    if (item.stop_rate != null) bits.push(`stops ${Math.round(item.stop_rate * 100)}% of passes`);
    pop.innerHTML = `<div class="mp-hd"><b>${name}</b><button class="mp-x" title="close">✕</button></div>` +
      `<div class="mp-sub">${bits.join(" · ")}</div>` +
      `<div class="mp-act"><button class="mp-sv">Street View</button>` +
      `<button class="mp-veto" title="stop this counting against the route">I ride through this</button></div>`;
    M.wrap.appendChild(pop);
    // clamp within the wrap
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = sx - wr.left + 10, top = sy - wr.top - ph - 8;
    if (top < 4) top = sy - wr.top + 14;
    left = Math.max(4, Math.min(wr.width - pw - 4, left));
    pop.style.left = left + "px"; pop.style.top = top + "px";
    pop.querySelector(".mp-x").onclick = closePopover;
    pop.querySelector(".mp-sv").onclick = () => M.opts.onStreetView && M.opts.onStreetView(item.pos, `${name} km ${fmtKm(item.km)}`);
    pop.querySelector(".mp-veto").onclick = () => { closePopover(); M.opts.onVeto && M.opts.onVeto(item.km); };
  }
  function closePopover() { const p = document.getElementById("mapPop"); if (p) p.remove(); }

  // ---- zoom / pan (mutates the viewBox) ----
  function applyVB() { M.svg.setAttribute("viewBox", `${M.vb.x.toFixed(1)} ${M.vb.y.toFixed(1)} ${M.vb.w.toFixed(1)} ${M.vb.h.toFixed(1)}`); }
  function clampVB() {
    if (M.vb.w > VBW) M.vb.w = VBW; if (M.vb.h > VBH) M.vb.h = VBH;
    if (M.vb.x < 0) M.vb.x = 0; if (M.vb.y < 0) M.vb.y = 0;
    if (M.vb.x + M.vb.w > VBW) M.vb.x = VBW - M.vb.w;
    if (M.vb.y + M.vb.h > VBH) M.vb.y = VBH - M.vb.h;
  }
  function toVB(cx, cy) { const r = M.svg.getBoundingClientRect(); return [M.vb.x + (cx - r.left) / r.width * M.vb.w, M.vb.y + (cy - r.top) / r.height * M.vb.h]; }
  function zoomAt(cx, cy, f) {
    const minW = VBW * 0.1;
    let nw = Math.max(minW, Math.min(VBW, M.vb.w * f)); const nh = nw * (VBH / VBW);
    M.vb.x = cx - (cx - M.vb.x) * (nw / M.vb.w); M.vb.y = cy - (cy - M.vb.y) * (nh / M.vb.h);
    M.vb.w = nw; M.vb.h = nh; clampVB(); applyVB();
  }
  function wireZoomPan() {
    const svg = M.svg;
    svg.addEventListener("wheel", e => { e.preventDefault(); const [cx, cy] = toVB(e.clientX, e.clientY); zoomAt(cx, cy, e.deltaY < 0 ? 0.85 : 1 / 0.85); }, { passive: false });
    let pan = null;
    svg.addEventListener("pointerdown", e => {
      if (e.target.closest && e.target.closest("[data-nozoom]")) return;
      closePopover();
      pan = { x: e.clientX, y: e.clientY, vx: M.vb.x, vy: M.vb.y };
      svg.setPointerCapture(e.pointerId); svg.classList.add("grabbing");
    });
    svg.addEventListener("pointermove", e => {
      if (!pan) return; const r = svg.getBoundingClientRect();
      M.vb.x = pan.vx - (e.clientX - pan.x) / r.width * M.vb.w;
      M.vb.y = pan.vy - (e.clientY - pan.y) / r.height * M.vb.h; clampVB(); applyVB();
    });
    const end = e => { if (pan) { pan = null; svg.classList.remove("grabbing"); try { svg.releasePointerCapture(e.pointerId); } catch (_) {} } };
    svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  }
  function resetView() { M.vb = { x: 0, y: 0, w: VBW, h: VBH }; applyVB(); }

  // ---- public API ----
  window.WDMap = {
    mount,
    load(data) {
      M.data = data; buildProjection(); resetView(); redrawAll();
    },
    setSegs(segs) { M.segs = (segs || []).map(s => ({ ...s })); if (M.data) redrawDynamic(); },
    setRide(track, thresh) { M.ride = track; if (thresh) M.rideThresh = thresh; if (M.data) drawRide(); },
    setLayers(vis) { Object.assign(M.vis, vis); if (M.data) redrawAll(); },
    zoom(f) { zoomAt(M.vb.x + M.vb.w / 2, M.vb.y + M.vb.h / 2, f); },
    resetView, closePopover,
    hasData: () => !!M.data,
  };
})();
