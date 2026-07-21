"use strict";
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const state = { routeId: null, ftp: 300, tsb: null, phase: "build", lastStim: null,
                segs: [], rkm: 0, workouts: [], wcat: "all", wsearch: "",
                bufferKm: 5, refSpeed: 30,     // overwritten from /api/health
                rideTrack: null, rideFile: null };

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { detail: txt }; }
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data));
  return data;
}
const show = (id) => $(id).classList.remove("hidden");

// ---- health ----
(async () => {
  try {
    const h = await api("/api/health");
    if (h.buffer_km) state.bufferKm = h.buffer_km;
    if (h.ref_speed_kmh) state.refSpeed = h.ref_speed_kmh;
    const box = $("#health");
    const icu = el("span", "pill " + (h.icu_configured ? "ok" : "bad"),
      h.icu_configured ? "intervals.icu ✓" : "intervals.icu not set");
    box.appendChild(icu);
    if (h.missing_engine.length)
      box.appendChild(el("span", "pill bad", "missing: " + h.missing_engine.join(", ")));
  } catch (e) { /* ignore */ }
})();

// ---- Step 1: upload ----
const drop = $("#drop"), fileInput = $("#file");
$("#pick").onclick = () => fileInput.click();
fileInput.onchange = () => fileInput.files[0] && uploadGpx(fileInput.files[0]);
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) uploadGpx(f); });

async function uploadGpx(file) {
  const fd = new FormData(); fd.append("file", file);
  const box = $("#routeSummary"); box.classList.remove("hidden");
  box.innerHTML = "<p class='muted'>Analysing route…</p>";
  try {
    const r = await api("/api/route", { method: "POST", body: fd });
    state.routeId = r.route_id;
    // a new route invalidates any ride overlay from the previous one
    state.rideTrack = state.rideFile = state.rideMatches = null;
    $("#rideList").innerHTML = ""; $("#rideInfo").textContent = "";
    $("#clearRide").classList.add("hidden");
    renderRoute(r);
    afterRouteReady();
  } catch (e) { box.innerHTML = `<p class='err-msg'>${e.message}</p>`; }
}

// Once a route is loaded, rank a recommendation and populate the workout picker
// (both need the route's distance/terrain). Totals were already fetched on load.
async function afterRouteReady() {
  state.ftp = parseInt($("#ftp").value) || state.ftp || 300;
  state.phase = $("#phase").value;
  let top = "all";
  try {
    const rec = await api("/api/objectives", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, tsb: state.tsb, phase: state.phase, last: state.lastStim }),
    });
    top = rec.top || "all";
    $("#recommend").innerHTML = `Recommended for today: <b>${rec.top}</b> ` +
      `<span class='muted'>— ${rec.reason}</span>`;
  } catch (e) { $("#recommend").textContent = ""; }
  await loadWorkouts(top);
  $("#s2").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRoute(r) {
  const stops = r.stop_hotspots.length;
  const g = el("div", "grid2");
  const stat = (b, s) => { const d = el("div", "stat"); d.appendChild(el("b", null, b)); d.appendChild(el("span", null, s)); return d; };
  g.append(
    stat(r.distance_km + " km", "distance"),
    stat((r.elevation_gain_m ?? "–") + " m", "elevation gain"),
    stat(r.coverage_pct != null ? r.coverage_pct + "%" : "–", "ridden before"),
    stat(stops, "stop hotspots"),
    stat(r.osm.hazards, "OSM junctions"),
  );
  const box = $("#routeSummary"); box.innerHTML = `<b>${r.filename}</b>`;
  box.appendChild(g);
  if (r.effort_blocks.length) {
    box.appendChild(el("h3", null, "Cleanest effort-ready blocks"));
    box.appendChild(el("div", "muted small", r.effort_blocks.join(" · ")));
  }
}

// ---- Step 2: context ----
async function loadContext() {
  const box = $("#context"); box.innerHTML = "<p class='muted'>Loading intervals.icu…</p>";
  let ctx;
  try { ctx = await api("/api/context"); }
  catch (e) { box.innerHTML = `<p class='err-msg'>${e.message}</p>`; return; }
  if (!ctx.configured) {
    box.innerHTML = `<p class='muted'>${ctx.note}</p>`;
    $("#ftp").value = 300; return;
  }
  const parts = [];
  if (ctx.fitness) {
    state.tsb = ctx.fitness.tsb;
    parts.push(`<div class='grid2'>
      <div class='stat'><b>${ctx.fitness.ctl ?? "–"}</b><span>CTL (fitness)</span></div>
      <div class='stat'><b>${ctx.fitness.atl ?? "–"}</b><span>ATL (fatigue)</span></div>
      <div class='stat'><b>${ctx.fitness.tsb ?? "–"}</b><span>TSB (form)</span></div></div>`);
  }
  if (ctx.sport && ctx.sport.ftp) { state.ftp = ctx.sport.ftp; }
  if (ctx.load) {
    state.lastStim = ctx.load.last_stimulus;
    const rows = ctx.load.rows.slice(0, 8).map(r =>
      `<tr><td>${r.age}d</td><td>${r.date.slice(5)}</td><td>${r.load}</td><td>${r.if ?? "–"}</td><td>${r.stimulus}</td><td class='muted'>${r.name.slice(0, 26)}</td></tr>`).join("");
    parts.push(`<table><tr><th>ago</th><th>date</th><th>load</th><th>IF</th><th>stim</th><th>session</th></tr>${rows}</table>`);
    const hd = ctx.load.headroom ? "no quality day in 14d — headroom for a key session"
      : `last quality day ${ctx.load.last_quality_days}d ago`;
    parts.push(`<p class='muted small'>7-day load ${ctx.load.load7} · 14-day ${ctx.load.load14} · ${hd}</p>`);
  }
  if (ctx.errors && ctx.errors.length) parts.push(`<p class='err-msg small'>${ctx.errors.join("; ")}</p>`);
  box.innerHTML = parts.join("");
  $("#ftp").value = state.ftp;
}

// intervals.icu totals don't depend on the route, so fetch them right away —
// they're on screen (Step 2) before Step 1 is even complete.
loadContext();
$("#phase").addEventListener("change", () => { state.phase = $("#phase").value; if (state.routeId) afterRouteReady(); });
$("#ftp").addEventListener("change", () => { state.ftp = parseInt($("#ftp").value) || 300; if (state.segs.length) renderSegTable(); });

// ---- design + map ----
const STEP = 0.5, MINSEG = 0.5;
let segPushTimer = null;

// The map is drawn natively (see map.js). Its base layers come from
// /api/mapdata (fetched once per route, cached server-side); effort bands and
// the ride overlay are pushed in from state without any refetch.
WDMap.mount($("#map"), { onVeto: applyVeto, onStreetView: openStreetView });

let mapReqSeq = 0;
async function loadMapData() {
  if (!state.routeId) return;
  const seq = ++mapReqSeq;
  try {
    const md = await api(`/api/mapdata/${state.routeId}`);
    if (seq !== mapReqSeq) return;         // a newer route/veto is already loading
    WDMap.load(md);
    WDMap.setSegs(state.segs);
    WDMap.setRide(state.rideTrack, parseFloat($("#spdThresh").value) || 33);
    buildLegend();
  } catch (e) { /* map stays blank; the rest of the design still works */ }
}

function applyDesign(d) {
  window._design = d;
  state.mode = d.mode || "route";
  state.unit = state.mode === "blank" ? "min" : "km";
  state.segs = (d.segs || []).map(s => ({ ...s }));
  const hint = $(".maphint"), tbl = $("#segtable"), mw = $("#mapwrap"), lg = $("#legend");
  if (state.mode === "blank") {
    state.rkm = 600;                                  // edit headroom (minutes)
    mw.classList.add("hidden"); lg.classList.add("hidden");
    if (hint) hint.style.display = "none";
    tbl.classList.add("blank");
    $("#rideBlock").classList.add("hidden");
    $("#addSeg").classList.remove("hidden");
    $("#hdrPos").textContent = "Time (min)";
    $("#s4title").textContent = "Build workout";
    $("#s4sub").textContent = "— time-based, no route";
    $("#segHint").textContent = "— drag the bar's boundaries, or ◀ ▶ move · − + resize (0.5 min steps)";
  } else {
    state.rkm = d.route_km;
    mw.classList.remove("hidden"); lg.classList.remove("hidden");
    if (hint) hint.style.display = "";
    tbl.classList.remove("blank");
    $("#rideBlock").classList.remove("hidden");
    $("#addSeg").classList.add("hidden");
    $("#hdrPos").textContent = "Route km";
    $("#s4title").textContent = "Design & map";
    $("#s4sub").textContent = "— review and adjust before any date";
    $("#segHint").textContent = "— drag the bar's boundaries, or ◀ ▶ move · − + resize (0.5 km steps)";
    // base map: reload only when the route/corrections changed; otherwise just
    // repaint the bands (workout switch, nudge) on the map we already have.
    if (state.mapRouteId !== state.routeId || state.mapDirty) {
      state.mapRouteId = state.routeId; state.mapDirty = false;
      loadMapData();
    } else if (WDMap.hasData()) {
      WDMap.setSegs(state.segs);
    }
  }
  renderMeta(d);
  renderSegTable();
  renderSyntaxIssues(d);
}

function renderMeta(d) {
  // don't yank the title input out from under the user mid-rename
  if (document.activeElement && document.activeElement.id === "wtitle") return;
  const tiles = [
    `<div><span class='muted'>${d.session_name || d.objective}</span><br>` +
      `<input id='wtitle' value='${escAttr(d.title)}' spellcheck='false' title='workout title — click to edit'></div>`,
    `<div><div class='v'>${d.load_estimate}</div><span class='muted small'>est. load</span></div>`,
    `<div><div class='v'>${d.if_estimate}</div><span class='muted small'>est. IF</span></div>`,
    `<div><div class='v'>${d.duration_min}′</div><span class='muted small'>~duration</span></div>`,
  ];
  if (state.mode !== "blank")
    tiles.push(`<div><div class='v'>${d.written_km} km</div><span class='muted small'>written (route ${d.route_km})</span></div>`);
  tiles.push(`<div><div class='v'>${d.reps_placed}/${d.reps_requested || "–"}</div><span class='muted small'>efforts</span></div>`);
  $("#designMeta").innerHTML = tiles.join("");
  $("#wtitle").onchange = async (e) => {
    const t = e.target.value.trim();
    if (!t) { e.target.value = (window._design || {}).title || ""; return; }
    try {
      const r = await api("/api/title", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route_id: state.routeId, title: t }),
      });
      if (window._design) window._design.title = r.title;
    } catch (err) { $("#issues").innerHTML = `<div class='issue error'>${err.message}</div>`; }
  };
}
function renderSyntaxIssues(d) {
  $("#syntax").textContent = d.syntax;
  const iss = $("#issues"); iss.innerHTML = "";
  (d.issues || []).forEach(i => iss.appendChild(el("div", "issue " + i.level, i.msg)));
}

// ---- searchable workout picker ----
async function loadWorkouts(activeCat) {
  const r = await api("/api/workouts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route_id: state.routeId }),
  });
  state.workouts = r.workouts || [];
  state.wcat = activeCat && state.workouts.some(w => w.category === activeCat) ? activeCat : "all";
  state.wsearch = "";
  $("#wsearch").value = "";
  renderChips(); renderWlist();
}
// starred workouts persist in the browser (per-machine) for easy reuse
function getStars() {
  try { return new Set(JSON.parse(localStorage.getItem("wd_starred") || "[]")); }
  catch { return new Set(); }
}
function starKey(w) { return `${w.category}|${w.name}|${w.structure}`; }
function toggleStar(w) {
  const s = getStars(); const k = starKey(w);
  s.has(k) ? s.delete(k) : s.add(k);
  localStorage.setItem("wd_starred", JSON.stringify([...s]));
  renderChips(); renderWlist();
}

function renderChips() {
  const hasStars = getStars().size > 0;
  const cats = [...(hasStars ? ["★ starred"] : []), "all", ...new Set(state.workouts.map(w => w.category))];
  const box = $("#catchips"); box.innerHTML = "";
  cats.forEach(c => {
    const val = c === "★ starred" ? "starred" : c;
    const b = el("button", "chip-btn" + (val === state.wcat ? " on" : ""), c);
    b.onclick = () => { state.wcat = val; renderChips(); renderWlist(); };
    box.appendChild(b);
  });
}
function renderWlist() {
  const q = state.wsearch.trim().toLowerCase();
  const cur = window._design || {};
  const stars = getStars();
  // A search query spans ALL categories (ignores the chip); otherwise the chip
  // narrows — "starred" shows only favourites. Starred always sort to the top.
  let items = state.workouts.filter(w =>
    q ? w.search.includes(q)
      : state.wcat === "starred" ? stars.has(starKey(w))
      : (state.wcat === "all" || w.category === state.wcat));
  items = items.slice().sort((a, b) => (stars.has(starKey(b)) ? 1 : 0) - (stars.has(starKey(a)) ? 1 : 0));
  const box = $("#wlist"); box.innerHTML = "";
  if (!items.length) {
    box.appendChild(el("div", "wempty", state.wcat === "starred"
      ? "No starred workouts yet — tap ☆ on any card to save it here."
      : "No workouts match — try a different term or category."));
    return;
  }
  items.forEach(w => {
    const on = cur.session_name === w.name && cur.objective === w.category;
    const starred = stars.has(starKey(w));
    const b = el("button", "witem" + (on ? " on" : ""));
    b.innerHTML = `<span class='star${starred ? " on" : ""}' title='${starred ? "unstar" : "star for reuse"}'>${starred ? "★" : "☆"}</span>` +
      `<span class='cat'>${w.category}</span><b>${w.name}</b>` +
      `<span class='st'>${w.structure} · ~${w.body_min}′ work${w.plan ? " · " + w.plan : ""}</span>`;
    b.querySelector(".star").addEventListener("click", (e) => { e.stopPropagation(); toggleStar(w); });
    b.onclick = () => selectWorkout(w);
    box.appendChild(b);
  });
}
$("#wsearch").addEventListener("input", e => { state.wsearch = e.target.value; renderWlist(); });

async function selectWorkout(w) {
  try {
    const d = await api("/api/select", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, category: w.category, index: w.index, ftp: state.ftp }),
    });
    show("#s4");
    applyDesign(d); renderWlist();
    $("#s4").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    show("#s4");
    $("#designMeta").innerHTML = `<p class='err-msg'>${e.message}</p>` +
      (/re-upload/i.test(e.message) ? "<p class='muted small'>Scroll up to Step 1 and drop the GPX again.</p>" : "");
  }
}

// ---- no-route (time-based) workout ----
$("#blankBtn").onclick = async () => {
  try {
    const d = await api("/api/blank", { method: "POST" });
    state.routeId = d.route_id;
    state.ftp = parseInt($("#ftp").value) || state.ftp || 300;
    $("#recommend").textContent = "No-route mode — pick a workout to start from, or edit the default segments below.";
    show("#s4");   // visible BEFORE rendering so the timeline measures a real width
    applyDesign(d);
    await loadWorkouts(d.objective || "threshold");
    $("#s4").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { alert(e.message); }
};

$("#addSeg").onclick = () => {
  const segs = state.segs, dur = 5.0, r = v => Math.round(v * 10) / 10;
  const at = (segs.length && segs[segs.length - 1].kind === "cooldown") ? segs.length - 1 : segs.length;
  const start = at > 0 ? segs[at - 1].b : 0;
  for (let i = at; i < segs.length; i++) { segs[i].a = r(segs[i].a + dur); segs[i].b = r(segs[i].b + dur); }
  segs.splice(at, 0, { name: "Effort", a: r(start), b: r(start + dur), pct: "98-102", kind: "work" });
  renderSegTable(); scheduleSegPush();
};

// ---- native segment editor (nudge / kind / pct / name / delete) ----
const KINDCOL = { warmup: "#8a8a82", work: "#c0392b", rest: "#3a7bd5", tt: "#b5482a", cooldown: "#2e7d46" };
const KINDS = ["warmup", "work", "rest", "tt", "cooldown"];

// ---- interactive timeline: bands + elevation backdrop + draggable boundaries.
// Boundary bi sits between segs[bi-1] and segs[bi] (bi = 1..n-1); in blank mode
// the workout's END (bi = n) is draggable too. Snaps to STEP, honours MINSEG.
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let tlDrag = null;   // {bi, total} while dragging (total frozen so the scale is stable)

function tlTotal() {
  if (state.mode === "blank") return state.segs.length ? state.segs[state.segs.length - 1].b : 60;
  return state.rkm || 1;
}

function renderTimeline() {
  const box = $("#timeline");
  if (!state.segs.length) { box.innerHTML = ""; return; }
  const total = tlDrag ? tlDrag.total : tlTotal();
  const W = box.clientWidth || 800;
  const TOP = 6, BH = state.mode === "blank" ? 42 : 60, AX = 16, H = TOP + BH + AX;
  const x = v => v / total * W;
  const d = window._design || {};
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // elevation backdrop (route mode, when the GPX has elevation)
  const prof = d.profile;
  if (state.mode !== "blank" && prof && prof.length > 2) {
    const eles = prof.map(p => p[1]);
    const lo = Math.min(...eles), span = Math.max(Math.max(...eles) - lo, 10);
    const py = e => TOP + BH - (e - lo) / span * (BH - 4);
    let path = `M${x(prof[0][0]).toFixed(1)},${TOP + BH}`;
    prof.forEach(p => { path += ` L${x(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`; });
    path += ` L${x(prof[prof.length - 1][0]).toFixed(1)},${TOP + BH} Z`;
    svg += `<path d="${path}" class="tl-elev"/>`;
  }

  // segment bands (work efforts pop; structural sections stay translucent)
  state.segs.forEach(s => {
    const work = s.kind === "work" || s.kind === "tt";
    svg += `<rect x="${x(s.a).toFixed(1)}" y="${TOP}" width="${Math.max(x(s.b) - x(s.a), 0).toFixed(1)}"` +
      ` height="${BH}" fill="${KINDCOL[s.kind] || "#888"}" opacity="${work ? ".78" : ".32"}">` +
      `<title>${escXml(s.name)} — ${fmtKm(s.a)}–${fmtKm(s.b)} @ ${escXml(s.pct)}%</title></rect>`;
  });

  // stop / junction ticks under the bands (route mode)
  if (state.mode !== "blank") {
    (d.haz_km || []).forEach(k => {
      svg += `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${TOP + BH}" y2="${TOP + BH + 4}" class="tl-haz"><title>junction km ${k}</title></line>`;
    });
    (d.stops_km || []).forEach(k => {
      svg += `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${TOP + BH}" y2="${TOP + BH + 6}" class="tl-stop"><title>stop hotspot km ${k}</title></line>`;
    });
  }

  // axis labels (km or minutes)
  const step = total > 240 ? 60 : total > 150 ? 25 : total > 80 ? 20 : total > 40 ? 10 : 5;
  for (let k = step; k < total - step * 0.4; k += step)
    svg += `<text x="${x(k).toFixed(1)}" y="${H - 3}" class="tl-lab">${k}</text>`;
  svg += `<text x="${W - 2}" y="${H - 3}" class="tl-lab" text-anchor="end">${fmtKm(total)} ${state.unit === "min" ? "min" : "km"}</text>`;

  // boundary handles
  const n = state.segs.length;
  const maxBi = state.mode === "blank" ? n : n - 1;
  for (let bi = 1; bi <= maxBi; bi++) {
    const v = bi < n ? state.segs[bi].a : state.segs[n - 1].b;
    svg += `<g class="tl-handle" data-bi="${bi}">` +
      `<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${TOP - 3}" y2="${TOP + BH + 3}"/>` +
      `<rect x="${(x(v) - 7).toFixed(1)}" y="${TOP - 3}" width="14" height="${BH + 6}" fill="transparent"/></g>`;
  }
  svg += "</svg>";
  box.innerHTML = svg;

  box.querySelectorAll(".tl-handle").forEach(h =>
    h.addEventListener("pointerdown", e => {
      e.preventDefault();
      tlDrag = { bi: +h.dataset.bi, total: tlTotal() };
    }));
}

let tlRaf = false;
window.addEventListener("pointermove", e => {
  if (!tlDrag || tlRaf) return;
  const svgEl = $("#timeline svg");
  if (!svgEl) { tlDrag = null; return; }
  const r = svgEl.getBoundingClientRect();
  const segs = state.segs, n = segs.length, bi = tlDrag.bi;
  let v = (e.clientX - r.left) / r.width * tlDrag.total;
  v = Math.round(v / STEP) * STEP;
  const bnd = [segs[0].a, ...segs.map(s => s.b)];
  const lo = bnd[bi - 1] + MINSEG;
  const hi = bi < n ? bnd[bi + 1] - MINSEG : state.rkm;   // blank end: up to headroom
  v = Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10;
  segs[bi - 1].b = v;
  if (bi < n) segs[bi].a = v;
  tlRaf = true;
  requestAnimationFrame(() => { tlRaf = false; renderSegTable(); });
});
window.addEventListener("pointerup", () => {
  if (!tlDrag) return;
  tlDrag = null;
  renderSegTable(); scheduleSegPush();
});
window.addEventListener("resize", () => { if (state.segs.length) renderTimeline(); });
const fmtKm = (v) => (Math.round(v * 10) / 10).toString();
function wattsFor(pct) {
  const ftp = state.ftp || 300;
  const parts = String(pct).replace("%", "").split("-").map(x => parseFloat(x));
  if (parts.some(isNaN)) return "";
  const w = parts.map(p => Math.round(p / 100 * ftp));
  return (w.length > 1 ? `${w[0]}–${w[1]}` : `${w[0]}`) + " W";
}
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");

function renderSegTable() {
  const tb = $("#segtable tbody"); tb.innerHTML = "";
  state.segs.forEach((s, i) => {
    const span = s.b - s.a, written = span + (s.buf ? state.bufferKm : 0), ride = span / state.refSpeed * 60;
    const kopts = KINDS.map(k => `<option value="${k}"${k === s.kind ? " selected" : ""}>${k}</option>`).join("");
    const tr = el("tr");
    tr.innerHTML =
      `<td><span class='kdot' style='background:${KINDCOL[s.kind] || "#888"}'></span>` +
        `<select class='kd' data-i='${i}'>${kopts}</select> <input class='nm' data-i='${i}' value='${escAttr(s.name)}'></td>` +
      `<td class='num col-km'>${fmtKm(s.a)}–${fmtKm(s.b)}</td>` +
      `<td class='col-move'><span class='nudge'>` +
        `<button data-i='${i}' data-op='ml' title='0.5 km earlier'>&#9664;</button>` +
        `<button class='mr' data-i='${i}' data-op='mr' title='0.5 km later'>&#9654;</button>` +
        `<button data-i='${i}' data-op='rs' title='0.5 km shorter'>&minus;</button>` +
        `<button data-i='${i}' data-op='rl' title='0.5 km longer'>&plus;</button></span></td>` +
      `<td class='num seg-sec'>${Math.round(ride)}′</td>` +
      `<td class='num seg-sec'>${fmtKm(written)} km${s.buf ? " *" : ""}</td>` +
      `<td><input class='pct' data-i='${i}' value='${escAttr(s.pct)}'>% <span class='watts'>${wattsFor(s.pct)}</span></td>` +
      `<td class='road road-col' data-i='${i}'>—</td>` +
      `<td><button class='del' data-i='${i}' title='remove'>&#10005;</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".nudge button").forEach(b => b.onclick = e => nudgeSeg(+e.currentTarget.dataset.i, e.currentTarget.dataset.op));
  tb.querySelectorAll("select.kd").forEach(x => x.onchange = e => { state.segs[+e.target.dataset.i].kind = e.target.value; renderSegTable(); scheduleSegPush(); });
  tb.querySelectorAll("input.nm").forEach(x => x.onchange = e => { state.segs[+e.target.dataset.i].name = e.target.value; scheduleSegPush(); });
  tb.querySelectorAll("input.pct").forEach(x => x.onchange = e => { state.segs[+e.target.dataset.i].pct = e.target.value.replace("%", "").trim(); renderSegTable(); scheduleSegPush(); });
  tb.querySelectorAll("button.del").forEach(x => x.onclick = e => deleteSeg(+e.currentTarget.dataset.i));
  markRoad();
  renderTimeline();
  if (state.mode !== "blank" && WDMap.hasData()) WDMap.setSegs(state.segs);   // repaint map bands
}
function markRoad() {
  if (state.mode === "blank") return;
  // issues carry the segment index ("seg") — exact row match, no name matching
  const iss = ((window._design || {}).issues || []).filter(i => i.seg != null && /stop|junction/i.test(i.msg));
  $("#segtable tbody").querySelectorAll("td.road").forEach(td => {
    const i = +td.dataset.i, s = state.segs[i];
    if (!s || (s.kind !== "work" && s.kind !== "tt")) { td.textContent = "—"; td.className = "road"; return; }
    const bad = iss.find(e => e.seg === i);
    if (bad) {
      td.textContent = bad.level === "error" ? "⚠ stop" : "⚠ crosses";
      td.className = "road warn"; td.title = bad.msg;
    } else { td.textContent = "✓ clean"; td.className = "road ok"; td.title = ""; }
  });
}
function nudgeSeg(i, op) {
  const segs = state.segs, n = segs.length, RKM = state.rkm;
  const bnd = [segs[0].a, ...segs.map(s => s.b)];
  const snap = k => Math.round(k / STEP) * STEP;
  if (op === "ml" || op === "mr") {
    const d = op === "mr" ? STEP : -STEP, w = bnd[i + 1] - bnd[i];
    const lo = i > 0 ? bnd[i - 1] + MINSEG : 0, hi = (i < n - 1 ? bnd[i + 2] - MINSEG : RKM) - w;
    const na = Math.max(lo, Math.min(hi, snap(bnd[i] + d))); bnd[i] = na; bnd[i + 1] = na + w;
  } else {
    const d = op === "rl" ? STEP : -STEP;
    const lo = bnd[i] + MINSEG, hi = (i < n - 1 ? bnd[i + 2] - MINSEG : RKM);
    bnd[i + 1] = Math.max(lo, Math.min(hi, snap(bnd[i + 1] + d)));
  }
  segs.forEach((s, k) => { s.a = Math.round(bnd[k] * 10) / 10; s.b = Math.round(bnd[k + 1] * 10) / 10; });
  renderSegTable(); scheduleSegPush();
}
function deleteSeg(i) {
  const segs = state.segs;
  if (segs.length <= 2) return;
  if (i > 0) segs[i - 1].b = segs[i].b; else segs[1].a = segs[0].a;
  segs.splice(i, 1);
  renderSegTable(); scheduleSegPush();
}
function scheduleSegPush() { clearTimeout(segPushTimer); segPushTimer = setTimeout(pushSegments, 500); }
let segSeq = 0;   // discard out-of-order responses (rapid nudges overlap)
async function pushSegments() {
  const seq = ++segSeq;
  // map bands already repainted client-side (renderSegTable); server confirms
  // validation / load / syntax.
  try {
    const d = await api("/api/segments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, segs: state.segs }),
    });
    if (seq !== segSeq) return;   // a newer edit is already in flight
    window._design = { ...window._design, ...d };
    renderMeta(d); renderSyntaxIssues(d); markRoad();
  } catch (e) {
    if (seq !== segSeq) return;
    $("#issues").innerHTML = `<div class='issue error'>${e.message}</div>`;
  }
}

// ---- past-ride speed overlay ----
$("#findRides").onclick = async () => {
  const box = $("#rideList");
  box.innerHTML = "<div class='wempty'>Scanning your ride history… (the first run indexes every ride — can take ~20 s)</div>";
  try {
    const r = await api("/api/rides/matches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId }),
    });
    renderRideList(r.matches || []);
  } catch (e) { box.innerHTML = `<div class='wempty err-msg'>${e.message}</div>`; }
};

function renderRideList(ms) {
  state.rideMatches = ms;
  const box = $("#rideList"); box.innerHTML = "";
  if (!ms.length) {
    box.innerHTML = "<div class='wempty'>No past rides cover most of this route. " +
      "Run “Refresh ride history” in Maintenance if recent rides are missing.</div>";
    return;
  }
  ms.forEach(m => {
    const on = state.rideFile === m.file;
    const b = el("button", "witem" + (on ? " on" : ""));
    b.innerHTML = `<span class='cat'>${m.coverage_pct}% of route</span><b>${m.date || m.file}</b>` +
      `<span class='st'>${m.distance_km} km · avg ${m.avg_kmh ?? "–"} · max ${m.max_kmh ?? "–"} km/h` +
      `${m.on_route_pct < 90 ? " · " + m.on_route_pct + "% of ride on route" : ""}</span>`;
    b.onclick = () => loadRide(m);
    box.appendChild(b);
  });
}

async function loadRide(m) {
  const info = $("#rideInfo");
  info.textContent = "loading speed track…";
  try {
    const r = await api("/api/rides/track", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, file: m.file }),
    });
    state.rideTrack = r.track; state.rideFile = m.file;
    $("#clearRide").classList.remove("hidden");
    postRide(); updateRideInfo(); renderRideList(state.rideMatches || []);
  } catch (e) { info.innerHTML = `<span class='err-msg'>${e.message}</span>`; }
}

function postRide() {
  if (state.mode === "blank" || !WDMap.hasData()) return;
  WDMap.setRide(state.rideTrack || null, parseFloat($("#spdThresh").value) || 33);
}

function updateRideInfo() {
  const info = $("#rideInfo");
  if (!state.rideTrack) { info.textContent = ""; return; }
  const thresh = parseFloat($("#spdThresh").value) || 33;
  const spds = state.rideTrack.map(p => p[2]).filter(v => v != null);
  if (!spds.length) { info.textContent = "this ride carries no speed data"; return; }
  const above = spds.filter(v => v > thresh).length;
  const avg = spds.reduce((a, b) => a + b, 0) / spds.length;
  info.textContent = `${Math.round(above / spds.length * 100)}% of the ride above ${thresh} km/h · ` +
    `avg ${avg.toFixed(1)} km/h — pink on the map = faster than ${thresh}, purple = slower`;
}

$("#spdThresh").addEventListener("change", () => { postRide(); updateRideInfo(); });
$("#clearRide").onclick = () => {
  state.rideTrack = null; state.rideFile = null;
  $("#clearRide").classList.add("hidden");
  postRide(); updateRideInfo(); renderRideList(state.rideMatches || []);
};

// ---- map: legend, zoom controls, hazard veto, Street View modal ----
const LEGEND = [
  { sw: `<span class='sw ln' style='background:#2e9e5b'></span>`, t: "clean", key: "effort" },
  { sw: `<span class='sw ln' style='background:#d99a2b'></span>`, t: "caution", key: "effort" },
  { sw: `<span class='sw ln' style='background:#d1495b'></span>`, t: "avoid", key: "effort" },
  { sep: true },
  { sw: `<span class='sw ln' style='background:#3b6fd4'></span>`, t: "efforts", key: "bands" },
  { sw: `<span class='sw ln' style='background:#e91e63'></span>`, t: "ride overlay", key: "ride" },
  { sep: true },
  { sw: `<span class='sw' style='background:#c0392b;transform:rotate(45deg)'></span>`, t: "signals", key: "signals" },
  { sw: `<span class='sw tri'></span>`, t: "give-way", key: "giveway" },
  { sw: `<span class='sw ring'></span>`, t: "stops", key: "stops" },
  { sw: `<span class='sw ln' style='background:#c9c9c4'></span>`, t: "streets", key: "streets" },
];
const layerVis = { streets: true, effort: true, bands: true, signals: true, giveway: true, priority: true, stops: true, ride: true };
function buildLegend() {
  const box = $("#legend"); box.innerHTML = "";
  LEGEND.forEach(item => {
    if (item.sep) { box.appendChild(el("span", "sep")); return; }
    const lab = el("label", "lg" + (layerVis[item.key] ? "" : " off"), `${item.sw}<span>${item.t}</span>`);
    lab.onclick = () => {
      layerVis[item.key] = !layerVis[item.key];
      if (item.key === "signals") layerVis.priority = layerVis.signals;   // priority-from-right rides with signals
      lab.classList.toggle("off", !layerVis[item.key]);
      WDMap.setLayers(layerVis);
    };
    box.appendChild(lab);
  });
}
$("#zin").onclick = () => WDMap.zoom(0.7);
$("#zout").onclick = () => WDMap.zoom(1 / 0.7);
$("#zreset").onclick = () => WDMap.resetView();

async function applyVeto(km) {
  try {
    const d = await api("/api/veto", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, km, persist: $("#persistCorr").checked }),
    });
    state.mapDirty = true;   // colours + markers change → reload base map
    applyDesign(d);
  } catch (e) { $("#issues").innerHTML = `<div class='issue error'>${e.message}</div>`; }
}

// Street View lightbox
const svEmbed = (pos) => `https://maps.google.com/maps?q=&layer=c&cbll=${pos[0]},${pos[1]}&cbp=11,0,0,0,0&output=svembed`;
const svExternal = (pos) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${pos[0]},${pos[1]}`;
function openStreetView(pos, label) {
  $("#svFrame").src = svEmbed(pos);
  $("#svLoc").textContent = label ? "— " + label : "";
  $("#svOpen").href = svExternal(pos);
  $("#svModal").classList.remove("hidden");
}
function closeStreetView() { $("#svModal").classList.add("hidden"); $("#svFrame").src = "about:blank"; }
$("#svClose").onclick = closeStreetView;
$("#svBack").onclick = closeStreetView;
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeStreetView(); WDMap.closePopover(); } });

$("#toDate").onclick = () => { show("#s5"); $("#s5").scrollIntoView({ behavior: "smooth" }); };

// ---- Step 5: push ----
$("#push").onclick = async () => {
  const date = $("#date").value;
  const box = $("#pushResult"), btn = $("#push");
  if (!date) { box.innerHTML = "<p class='err-msg'>pick a date</p>"; return; }
  btn.disabled = true;   // a double-click must not create two calendar events
  box.innerHTML = "<p class='muted'>creating…</p>";
  try {
    const r = await api("/api/push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route_id: state.routeId, date }),
    });
    let h = `<p class='ok-msg'>✓ Created <b>${r.title}</b> on ${r.date}.</p>`;
    if (r.event && r.event.parsed_load != null)
      h += `<p class='muted small'>intervals.icu parsed load ${r.event.parsed_load} (estimated ${r.estimated_load}).</p>`;
    if (r.conflicts && r.conflicts.length)
      h += `<p class='muted small'>Nearby: ${r.conflicts.map(c => c.date + " " + (c.name || c.category)).join(", ")}</p>`;
    box.innerHTML = h;
  } catch (e) { box.innerHTML = `<p class='err-msg'>${e.message}</p>`; }
  finally { btn.disabled = false; }
};

// ---- Maintenance ----
$("#maintToggle").onclick = () => $("#maintBody").classList.toggle("hidden");
let jobPoll = null;
document.querySelectorAll("button.maint").forEach(b => b.onclick = async () => {
  const kind = b.dataset.kind;
  try {
    const r = kind === "history"
      ? await api("/api/maint/history", { method: "POST" })
      : await api("/api/maint/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
    pollJobs(r.job_id);
  } catch (e) { $("#jobLog").textContent = e.message; }
});
$("#syncSkill").onclick = async () => {
  try {
    const r = await api("/api/maint/sync", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_caches: $("#syncCaches").checked }),
    });
    pollJobs(r.job_id);
  } catch (e) { $("#jobLog").textContent = e.message; }
};
function pollJobs(jid) {
  clearInterval(jobPoll);
  jobPoll = setInterval(async () => {
    const { jobs } = await api("/api/maint/jobs");
    const j = jobs.find(x => x.id === jid) || jobs[0];
    if (!j) return;
    $("#jobLog").textContent = `[${j.status}] ${j.label}\n` + j.log.slice(-40).join("\n") + (j.error ? "\n! " + j.error : "");
    $("#jobLog").scrollTop = $("#jobLog").scrollHeight;
    if (j.status !== "running") clearInterval(jobPoll);
  }, 1200);
}
