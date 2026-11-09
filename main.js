/* IconMaker — main.js: the application shell (IM.App).
 * Boot, view and zoom, rendering, history (with grouped transactions),
 * selection and style state, the layers and style panels, keyboard shortcuts,
 * file and export buttons, and the help dialog. Loaded last.
 */
(function () {
  "use strict";

  var IM = (window.IM = window.IM || {});
  var M = IM.Model, R = IM.Renderer;
  var NS = "http://www.w3.org/2000/svg";
  var SIZES = [16, 32, 64, 128];
  var DEFAULT_SIZE = 32;
  var MAX_ZOOM = 48;
  var ZOOM_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48];
  var EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var LOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M5 10h14v11H5z"/></svg>';

  /* ---------- small DOM helpers ---------- */

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clearEl(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function mk(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /* ---------- application state ---------- */

  var app = {
    doc: null,
    view: { zoom: 8, panX: 0, panY: 0 },
    fitView: null,                  // the view fit() last produced; see onResize
    state: {
      tool: "select",
      snap: true,
      grid: true,
      space: false,
      selPathId: null,
      selPathIds: [],
      selPointIndex: -1,
      styleTarget: "fill",          // "fill" | "stroke": which colour the eyedropper samples into
      fillKind: "color",            // "color" | "gradient" | "none"
      fillColor: "#000000",
      fillOpacity: 1,
      strokeColor: "#000000",
      strokeWidth: 2,               // default thickness for lines, pen and pencil
      shapeWidth: 0,                // default border thickness for rectangles and ovals
      strokeOpacity: 1,
      dash: "none",                 // "none" | "dash" | "dot" | "dashdot"
      gradient: { stops: [
        { offset: 0, color: "#000000", opacity: 1 },
        { offset: 1, color: "#b3b3b3", opacity: 1 }
      ] },
      gradSel: 0,
      clip: null,
      penDraft: null,
      ghost: null,
      penPreviewSeg: null,
      marquee: null
    },
    canvas: null,
    layersPanel: null,
    miniSvgs: [],
    history: null,
    tx: null,
    dirty: true,                    // layers and style panels need a rebuild
    renameEditing: false,
    dragLayerId: null
  };
  IM.App = app;

  /* ---------- document queries ---------- */

  function activeLayer() { return M.layer(app.doc, app.doc.activeLayerId); }
  function activeLayerIndex() { return M.layerIndex(app.doc, app.doc.activeLayerId); }

  function selectedPaths() {
    var L = activeLayer(), out = [];
    if (!L) return out;
    for (var i = 0; i < L.paths.length; i++) {
      if (app.state.selPathIds.indexOf(L.paths[i].id) >= 0) out.push(L.paths[i]);
    }
    return out;
  }

  function primaryPath() {
    return app.state.selPathId ? M.pathIn(app.doc, app.doc.activeLayerId, app.state.selPathId) : null;
  }

  function hasDrawing() {
    for (var i = 0; i < app.doc.layers.length; i++) {
      if (app.doc.layers[i].paths.length) return true;
    }
    return false;
  }

  function markDirty() { app.dirty = true; }

  /* ---------- selection ---------- */

  // Style controls show the selected shape's style; new shapes copy it.
  function syncStateFromSelection() {
    var p = primaryPath();
    if (!p) return;
    var st = app.state;
    st.fillKind = p.fill.kind;
    st.fillColor = p.fill.color;
    st.fillOpacity = p.fill.opacity;
    if (p.fill.gradient && p.fill.gradient.stops.length >= 2) st.gradient = { stops: M.clone(p.fill.gradient.stops) };
    st.strokeColor = p.stroke.color;
    // thickness is deliberately not copied: the panel reads it from the
    // selected shape, and the line/shape defaults stay what the user chose
    st.strokeOpacity = p.stroke.opacity;
    st.dash = p.dash && p.dash.pattern ? p.dash.pattern : "none";
    st.gradSel = clamp(st.gradSel, 0, st.gradient.stops.length - 1);
  }

  function select(ids, primary) {
    var st = app.state;
    st.selPathIds = ids.slice();
    st.selPathId = primary && st.selPathIds.indexOf(primary) >= 0 ? primary : (st.selPathIds[0] || null);
    st.selPointIndex = -1;
    syncStateFromSelection();
    markDirty();
  }

  function pruneSelection() {
    var L = activeLayer(), keep = [];
    if (L) {
      for (var i = 0; i < L.paths.length; i++) {
        if (app.state.selPathIds.indexOf(L.paths[i].id) >= 0) keep.push(L.paths[i].id);
      }
    }
    app.state.selPathIds = keep;
    if (app.state.selPathId && keep.indexOf(app.state.selPathId) < 0) {
      app.state.selPathId = keep[0] || null;
    }
  }

  function setActiveLayer(id) {
    if (!M.layer(app.doc, id) || app.doc.activeLayerId === id) return;
    app.doc.activeLayerId = id;
    select([], null);
  }

  function ensureActiveLayer() {
    if (!M.layer(app.doc, app.doc.activeLayerId)) app.doc.activeLayerId = app.doc.layers[0].id;
  }

  /* ---------- history ---------- */

  function normalizeOp(op) {
    if (op.type === "add" && op.index === undefined) {
      var L = M.layer(app.doc, op.layerId);
      op.index = L ? L.paths.length : 0;
    }
    if (op.path) op.path = M.clone(op.path);
    if (op.layer) op.layer = M.clone(op.layer);
    return op;
  }

  // Applies `op` (unless opts.applied: the effect is already on the document)
  // and records it. Inside a transaction, the op joins the group instead.
  function pushHistory(label, op, opts) {
    opts = opts || {};
    normalizeOp(op);
    if (!opts.applied) M.applyOp(app.doc, op, true);
    if (app.tx) app.tx.ops.push(op);
    else app.history.push(op, opts.key);
    markDirty();
    renderAll();
    syncHistoryButtons();
  }

  // Everything pushed between beginTx and endTx undoes as one step.
  function beginTx() {
    if (!app.tx) app.tx = { ops: [] };
  }

  function endTx() {
    var tx = app.tx;
    app.tx = null;
    if (!tx || tx.ops.length === 0) return;
    app.history.push(tx.ops.length === 1 ? tx.ops[0] : { type: "batch", ops: tx.ops });
    markDirty();
    syncHistoryButtons();
  }

  function afterHistoryChange() {
    ensureActiveLayer();
    pruneSelection();
    markDirty();
    renderAll();
    syncHistoryButtons();
  }

  function undo() {
    endTx();
    if (!app.history.undo()) {
      app.toast("Nothing to undo");
      return;
    }
    afterHistoryChange();
  }

  function redo() {
    endTx();
    if (!app.history.redo()) {
      app.toast("Nothing to redo");
      return;
    }
    afterHistoryChange();
  }

  function resetHistory(doc) {
    app.history = new M.History(doc);
    IM.Snap.setDocument(doc);
    syncHistoryButtons();
  }

  function syncHistoryButtons() {
    var u = qs("#undo"), r = qs("#redo");
    if (app.history) {
      u.disabled = !app.history.canUndo();
      r.disabled = !app.history.canRedo();
    }
  }

  /* ---------- view ---------- */

  function canvasRect() { return app.canvas.svg.getBoundingClientRect(); }

  // Fits the artboard to about 80% of the canvas, centred. It shrinks only if the zoom bar or
  // preview card would cover it, and then centres it in the free strip beside or above the card.
  function fit() {
    var r = canvasRect(), size = app.doc.size, gap = 16;
    function box(sel) {
      var b = qs(sel).getBoundingClientRect();
      if (b.width === 0) return null;
      return { x0: b.left - r.left - gap, y0: b.top - r.top - gap, x1: b.right - r.left + gap, y1: b.bottom - r.top + gap };
    }
    var card = box("#preview-card");
    var obstacles = [box("#zoombar"), card].filter(Boolean);
    var regions = [{ w: r.width, h: r.height }];
    if (card) regions.push({ w: card.x0, h: r.height }, { w: r.width, h: card.y0 });

    function clear(x, y, s) {
      return obstacles.every(function (o) {
        return x + s <= o.x0 || x >= o.x1 || y + s <= o.y0 || y >= o.y1;
      });
    }
    function place(z, x, y) {
      app.view.zoom = z;
      app.view.panX = x;
      app.view.panY = y;
      app.fitView = { zoom: z, panX: x, panY: y };
    }

    var zMax = clamp(Math.floor(Math.min(r.width, r.height) * 0.8 / size), 1, MAX_ZOOM);
    for (var z = zMax; z >= 1; z--) {
      var s = size * z;
      for (var i = 0; i < regions.length; i++) {
        var g = regions[i];
        if (g.w <= 0 || g.h <= 0) continue;
        var x = (g.w - s) / 2, y = (g.h - s) / 2;
        if (clear(x, y, s)) return place(z, x, y);
      }
    }
    place(1, (r.width - size) / 2, (r.height - size) / 2);
  }

  function zoomAround(mx, my, nz) {
    var v = app.view;
    nz = clamp(nz, 1, MAX_ZOOM);
    var dx = (mx - v.panX) / v.zoom, dy = (my - v.panY) / v.zoom;
    v.panX = mx - dx * nz;
    v.panY = my - dy * nz;
    v.zoom = nz;
  }

  function stepZoom(dir) {
    var cur = app.view.zoom, next = cur, i;
    if (dir > 0) {
      for (i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] > cur) { next = ZOOM_STEPS[i]; break; }
    } else {
      for (i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < cur) { next = ZOOM_STEPS[i]; break; }
    }
    if (next === cur) return;
    var r = canvasRect();
    zoomAround(r.width / 2, r.height / 2, next);
    renderAll();
  }

  /* ---------- rendering ---------- */

  var renderQueued = false;

  // For high-frequency updates (pointer moves): at most one render per frame.
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(function () {
      renderQueued = false;
      renderAll();
    });
  }

  function renderAll() {
    R.renderDoc(app.canvas, app.doc, app.view);
    app.canvas.gridG.setAttribute("display", app.state.grid ? "inline" : "none");
    IM.Overlay.render(app);
    renderPreviewCard();
    syncShapeButtons();
    if (app.dirty && !app.renameEditing) {
      app.dirty = false;
      refreshPanels();
    }
    updateHint();
    updateZoomLabel();
    IM.io.autosave(app.doc);
  }

  // Draws the icon at each standard size, one image pixel per screen pixel, so
  // you can judge it as it will really appear. Independent of the canvas size.
  function renderPreviewCard() {
    for (var i = 0; i < app.miniSvgs.length; i++) {
      var m = app.miniSvgs[i];
      R.renderPreview(m.svg, M.scaledCopy(app.doc, m.size), 1);
      m.svg.style.width = m.size + "px";
      m.svg.style.height = m.size + "px";
    }
  }

  // The tip at the top of the drawing area. People can close it with the X;
  // the same text lives in the Help window, which also turns the tip back on.
  var HINTS_KEY = "iconmaker.hints";

  function loadHintsPref() {
    try { return localStorage.getItem(HINTS_KEY) !== "off"; } catch (err) { return true; }
  }

  function setHints(on) {
    app.state.hints = on;
    try { localStorage.setItem(HINTS_KEY, on ? "on" : "off"); } catch (err) { /* storage off: fine */ }
    qs("#help-hints").checked = on;
    updateHint();
  }

  function updateHint() {
    var tool = IM.Tools[app.state.tool];
    var text = tool && tool.hint ? tool.hint(app) : "";
    qs("#hint-text").textContent = text;
    qs("#hint").classList.toggle("hidden", !(app.state.hints && text));
  }

  function updateZoomLabel() {
    qs("#zoom-label").textContent = Math.round(app.view.zoom * 100) + "%";
  }

  function refreshPanels() {
    refreshLayers();
    refreshStyle();
    updateSizeChips();
    syncHistoryButtons();
  }

  function updateSizeChips() {
    qsa("#size-group .chip").forEach(function (c) {
      c.classList.toggle("sel", +c.getAttribute("data-size") === app.doc.size);
    });
  }

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(msg) {
    var t = qs("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  /* ---------- tools and modes ---------- */

  function setTool(name) {
    var tool = IM.Tools[name];
    if (!tool || tool.id !== name) return;
    var prev = app.state.tool;
    if (prev === name) return;
    endTx();
    var old = IM.Tools[prev];
    if (old && old.deactivate) old.deactivate(app);
    app.state.tool = name;
    app.state.selPointIndex = -1;
    qsa("#tools .tool").forEach(function (btn) {
      var on = btn.getAttribute("data-tool") === name;
      btn.classList.toggle("sel", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    app.canvas.svg.classList.remove("tool-" + prev);
    app.canvas.svg.classList.add("tool-" + name);
    if (tool.activate) tool.activate(app);
    markDirty();
    renderAll();
  }

  function toggleSnap() {
    app.state.snap = !app.state.snap;
    updateToggles();
    toast(app.state.snap ? "Snapping on" : "Snapping off");
  }

  function toggleGrid() {
    app.state.grid = !app.state.grid;
    updateToggles();
    renderAll();
  }

  function updateToggles() {
    var s = qs("#snap-toggle"), g = qs("#grid-toggle");
    s.classList.toggle("on", app.state.snap);
    s.setAttribute("aria-pressed", app.state.snap ? "true" : "false");
    g.classList.toggle("on", app.state.grid);
    g.setAttribute("aria-pressed", app.state.grid ? "true" : "false");
  }

  function setSize(s) {
    if (s === app.doc.size) return;
    pushHistory("Change size", { type: "size", from: app.doc.size, to: s });
    fit();
    renderAll();
    toast("Icon size " + s + " × " + s + " px");
  }

  /* ---------- pointer input on the artboard ---------- */

  // Converts a pointer event to document units and tool-friendly fields.
  function norm(ev, type) {
    var r = canvasRect(), v = app.view;
    var e = {
      type: type,
      x: (ev.clientX - r.left - v.panX) / v.zoom,
      y: (ev.clientY - r.top - v.panY) / v.zoom,
      clientX: ev.clientX,
      clientY: ev.clientY,
      button: ev.button || 0,
      buttons: ev.buttons || 0,
      shiftKey: !!ev.shiftKey,
      altKey: !!ev.altKey,
      ctrlKey: !!ev.ctrlKey,
      space: !!app.state.space
    };
    return e;
  }

  function dispatch(type, e) {
    var tool = IM.Tools[app.state.tool];
    if (!tool) return;
    var fn = type === "dblclick" ? tool.onDblClick
      : tool["on" + type.charAt(0).toUpperCase() + type.slice(1)];
    if (fn) fn.call(tool, app, e);
  }

  var dragging = false, panning = false, panLast = null;

  function wireCanvas() {
    var svg = app.canvas.svg;

    svg.addEventListener("pointerdown", function (ev) {
      if (ev.button === 2) return;
      try { svg.setPointerCapture(ev.pointerId); } catch (err) { /* not supported: ignore */ }
      if (app.state.space || ev.button === 1) {
        panning = true;
        panLast = { x: ev.clientX, y: ev.clientY };
        ev.preventDefault();
        return;
      }
      dragging = true;
      dispatch("down", norm(ev, "down"));
    });

    svg.addEventListener("pointermove", function (ev) {
      if (panning) {
        app.view.panX += ev.clientX - panLast.x;
        app.view.panY += ev.clientY - panLast.y;
        panLast = { x: ev.clientX, y: ev.clientY };
        requestRender();
        return;
      }
      dispatch("move", norm(ev, "move"));
    });

    function finishUp(ev) {
      if (panning) {
        panning = false;
        panLast = null;
        return;
      }
      if (!dragging) return;
      dragging = false;
      try { svg.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
      dispatch("up", norm(ev, "up"));
    }
    svg.addEventListener("pointerup", finishUp);
    svg.addEventListener("pointercancel", finishUp);

    svg.addEventListener("pointerleave", function () {
      var tool = IM.Tools[app.state.tool];
      if (tool && tool.onLeave) tool.onLeave(app);
    });

    svg.addEventListener("dblclick", function (ev) {
      dispatch("dblclick", norm(ev, "dblclick"));
    });

    svg.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = canvasRect();
      if (ev.ctrlKey) {
        zoomAround(ev.clientX - r.left, ev.clientY - r.top, app.view.zoom * Math.exp(-ev.deltaY * 0.0025));
      } else {
        app.view.panX -= ev.deltaX;
        app.view.panY -= ev.deltaY;
      }
      requestRender();
    }, { passive: false });

    // Releasing outside the artboard still ends a drag.
    window.addEventListener("pointerup", function (ev) {
      if (ev.target === svg) return;
      finishUp(ev);
    });
  }

  /* ---------- keyboard ---------- */

  function isEditable(t) {
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }

  function nudgeSelection(dx, dy) {
    var ids = app.state.selPathIds.slice();
    var L = activeLayer();
    if (!ids.length || !L) return;
    if (L.locked) {
      toast("This layer is locked. Click its lock to unlock it.");
      return;
    }
    pushHistory("Move", { type: "move", layerId: L.id, ids: ids, dx: dx, dy: dy }, { key: "nudge" });
  }

  function deleteSelection() {
    var paths = selectedPaths();
    if (!paths.length) return;
    var L = activeLayer();
    if (L.locked) {
      toast("This layer is locked. Click its lock to unlock it.");
      return;
    }
    beginTx();
    for (var i = L.paths.length - 1; i >= 0; i--) {
      if (app.state.selPathIds.indexOf(L.paths[i].id) >= 0) {
        pushHistory("Delete", { type: "delete", layerId: L.id, index: i, path: M.clone(L.paths[i]) });
      }
    }
    endTx();
    select([], null);
    renderAll();
  }

  function copySelection() {
    var paths = selectedPaths();
    if (!paths.length) {
      toast("Select a shape to copy first.");
      return;
    }
    app.state.clip = paths.map(function (p) { return M.clone(p); });
    toast(paths.length === 1 ? "Copied" : "Copied " + paths.length + " shapes");
  }

  // Adds copies of `list` (path objects) to the active layer, offset a little.
  function addCopies(list) {
    var L = activeLayer(), ids = [];
    if (!L) return ids;
    if (!L.visible) {
      toast("This layer is hidden. Click its eye to show it.");
      return ids;
    }
    if (L.locked) {
      toast("This layer is locked. Click its lock to unlock it.");
      return ids;
    }
    beginTx();
    for (var i = 0; i < list.length; i++) {
      var q = M.clone(list[i]);
      q.id = M.uid();
      M.movePath(q, 2, 2);
      pushHistory("Paste", { type: "add", layerId: L.id, path: q });
      ids.push(q.id);
    }
    endTx();
    select(ids, ids[ids.length - 1]);
    renderAll();
    return ids;
  }

  function pasteSelection() {
    if (!app.state.clip || !app.state.clip.length) {
      toast("Nothing copied yet.");
      return;
    }
    addCopies(app.state.clip);
  }

  function duplicateSelection() {
    var paths = selectedPaths();
    if (!paths.length) {
      toast("Select a shape to duplicate first.");
      return;
    }
    addCopies(paths);
  }

  function selectAll() {
    var L = activeLayer();
    if (!L || !L.paths.length) return;
    var ids = L.paths.map(function (p) { return p.id; });
    select(ids, ids[ids.length - 1]);
    renderAll();
  }

  // Every path in the active layer that shares a group with one of `ids`.
  function expandGroups(ids) {
    var L = activeLayer(), out = ids.slice(), gids = [], i, p;
    if (!L) return out;
    for (i = 0; i < L.paths.length; i++) {
      p = L.paths[i];
      if (ids.indexOf(p.id) >= 0 && p.groupId && gids.indexOf(p.groupId) < 0) gids.push(p.groupId);
    }
    if (!gids.length) return out;
    for (i = 0; i < L.paths.length; i++) {
      p = L.paths[i];
      if (p.groupId && gids.indexOf(p.groupId) >= 0 && out.indexOf(p.id) < 0) out.push(p.id);
    }
    return out;
  }

  function groupSelection() {
    var sel = selectedPaths(), L = activeLayer();
    if (sel.length < 2) {
      toast("Select two or more shapes to group.");
      return;
    }
    var gid = M.uid();
    var changes = sel.map(function (p) {
      return { layerId: L.id, id: p.id, from: p.groupId || null, to: gid };
    });
    pushHistory("Group", { type: "group", changes: changes });
    renderAll();
    toast("Grouped " + sel.length + " shapes. They now move and resize together.");
  }

  function ungroupSelection() {
    var sel = selectedPaths(), L = activeLayer(), gids = [], changes = [];
    sel.forEach(function (p) { if (p.groupId && gids.indexOf(p.groupId) < 0) gids.push(p.groupId); });
    if (!gids.length) {
      toast("Nothing to ungroup. Select a grouped shape first.");
      return;
    }
    L.paths.forEach(function (p) {
      if (p.groupId && gids.indexOf(p.groupId) >= 0) {
        changes.push({ layerId: L.id, id: p.id, from: p.groupId, to: null });
      }
    });
    pushHistory("Ungroup", { type: "group", changes: changes });
    renderAll();
  }

  // Boolean merges. kind: "union" | "subtract" | "intersect" | "exclude".
  var MERGE_LABELS = { union: "Union", subtract: "Subtract", intersect: "Intersect", exclude: "Exclude" };
  function mergeSelection(kind) {
    var sel = selectedPaths(), L = activeLayer();
    var problem = IM.Merge.problemOf(sel);
    if (problem) {
      toast(problem + ".");
      return;
    }
    var result = IM.Merge.run(kind, sel, M.uid());
    if (result.empty) {
      toast(kind === "intersect" ? "No overlap: the shapes do not share any area." : "Nothing is left after " + MERGE_LABELS[kind].toLowerCase() + ".");
      return;
    }
    if (result.tooLarge) {
      toast("The merged shape would have too many points.");
      return;
    }
    var ids = sel.map(function (p) { return p.id; });
    pushHistory(MERGE_LABELS[kind], IM.Merge.replaceOp(L, ids, result.path));
    select([result.path.id], result.path.id);
    renderAll();
  }

  // Enables the Shapes buttons that make sense for the current selection.
  function syncShapeButtons() {
    var sel = selectedPaths(), hasGroup = sel.some(function (p) { return !!p.groupId; });
    var mergeOk = !IM.Merge.problemOf(sel);
    qs("#shape-group").disabled = sel.length < 2;
    qs("#shape-ungroup").disabled = !hasGroup;
    ["union", "subtract", "intersect", "exclude"].forEach(function (k) {
      qs("#shape-" + k).disabled = !mergeOk;
    });
  }

  // Moves the selected shape one step (or to the front/back) within its layer.
  function changeOrder(dir, toEnd) {
    var p = primaryPath(), L = activeLayer();
    if (!p || !L) {
      toast("Select a shape first.");
      return;
    }
    var from = M.indexOfId(L.paths, p.id), n = L.paths.length;
    var to = toEnd ? (dir > 0 ? n - 1 : 0) : clamp(from + dir, 0, n - 1);
    if (to === from) return;
    pushHistory("Change order", { type: "zorder", layerId: L.id, from: from, to: to });
  }

  // Moves the selected shapes to the layer above (dir 1) or below (dir -1).
  function moveSelectionToLayer(dir) {
    var paths = selectedPaths(), src = activeLayer();
    if (!paths.length || !src) {
      toast("Select a shape first.");
      return;
    }
    var target = app.doc.layers[activeLayerIndex() + dir];
    if (!target) {
      toast(dir > 0 ? "Already on the top layer." : "Already on the bottom layer.");
      return;
    }
    if (target.locked || src.locked) {
      toast("Unlock the layers first.");
      return;
    }
    var ids = paths.map(function (p) { return p.id; });
    beginTx();
    for (var i = 0; i < ids.length; i++) {
      pushHistory("Move to layer", {
        type: "path-layer", fromLayerId: src.id, toLayerId: target.id, id: ids[i],
        fromIndex: M.indexOfId(src.paths, ids[i]), index: target.paths.length
      });
    }
    endTx();
    setActiveLayer(target.id);
    select(ids, ids[ids.length - 1]);
    renderAll();
    toast("Moved to " + target.name);
  }

  function onKeyDown(ev) {
    if (isEditable(ev.target)) return;
    var dialog = qs("#help");
    if (dialog && dialog.open) return;
    var k = ev.key;

    if (k === " ") {
      ev.preventDefault();
      if (ev.target && ev.target.tagName === "BUTTON") ev.target.blur();
      if (!app.state.space) {
        app.state.space = true;
        app.canvas.svg.classList.add("space");
      }
      return;
    }

    if (ev.ctrlKey || ev.metaKey) {
      var lk = k.toLowerCase(), handled = true;
      if (lk === "z") { if (ev.shiftKey) redo(); else undo(); }
      else if (lk === "y") redo();
      else if (lk === "c") copySelection();
      else if (lk === "v") pasteSelection();
      else if (lk === "d") duplicateSelection();
      else if (lk === "a") selectAll();
      else if (lk === "g") { if (ev.shiftKey) ungroupSelection(); else groupSelection(); }
      else if (lk === "s") saveProject();
      else if (lk === "o") openProject();
      else handled = false;
      if (handled) ev.preventDefault();
      return;
    }

    // The active tool gets first claim on keys (pen, node editing, ...).
    var tool = IM.Tools[app.state.tool];
    if (tool && tool.onKey && tool.onKey(app, { type: "key", key: k, shiftKey: ev.shiftKey, altKey: ev.altKey })) {
      ev.preventDefault();
      return;
    }

    if (k === "Escape") {
      ev.preventDefault();
      if (app.state.selPathIds.length) select([], null);
      renderAll();
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      ev.preventDefault();
      deleteSelection();
      return;
    }
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      if (!app.state.selPathIds.length) return;
      ev.preventDefault();
      var step = ev.shiftKey ? 5 : 1;
      nudgeSelection(k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0,
        k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0);
      return;
    }
    if (k === "?") {
      ev.preventDefault();
      openHelp();
      return;
    }
    if (k.length !== 1) return;

    var lower = k.toLowerCase();
    if (IM.Tools.keys[lower]) { setTool(IM.Tools.keys[lower]); return; }
    if (lower === "s") { toggleSnap(); return; }
    if (k === "`") { toggleGrid(); return; }
    if (k === "0") { fit(); renderAll(); return; }
    if (k === "+" || k === "=") { stepZoom(1); return; }
    if (k === "-" || k === "_") { stepZoom(-1); return; }
    if (k >= "1" && k <= "4") { setSize(SIZES[+k - 1]); return; }
    if (k === "]" || k === "[") { changeOrder(k === "]" ? 1 : -1, ev.shiftKey); return; }
    if (k === "}" || k === "{") { moveSelectionToLayer(k === "}" ? 1 : -1); return; }
  }

  function onKeyUp(ev) {
    if (ev.key === " ") {
      app.state.space = false;
      app.canvas.svg.classList.remove("space");
    }
  }

  /* ---------- layers panel ---------- */

  function refreshLayers() {
    if (app.renameEditing) return;
    var list = app.layersPanel;
    clearEl(list);
    for (var r = app.doc.layers.length - 1; r >= 0; r--) {
      list.appendChild(makeLayerRow(app.doc.layers[r], r));
    }
    qs("#layer-del").disabled = app.doc.layers.length <= 1;
  }

  function makeLayerRow(L, idx) {
    var row = mk("div", "layer-item");
    row.setAttribute("data-layer-id", L.id);
    row.setAttribute("draggable", "true");
    if (L.id === app.doc.activeLayerId) row.classList.add("active");

    var eye = mk("button", "eye" + (L.visible ? " on" : ""));
    eye.innerHTML = EYE_SVG;
    eye.setAttribute("aria-label", L.visible ? "Hide " + L.name : "Show " + L.name);
    eye.title = L.visible ? "Hide layer" : "Show layer";
    var lock = mk("button", "lock" + (L.locked ? " on" : ""));
    lock.innerHTML = LOCK_SVG;
    lock.setAttribute("aria-label", L.locked ? "Unlock " + L.name : "Lock " + L.name);
    lock.title = L.locked ? "Unlock layer" : "Lock layer";

    var thumb = mk("div", "thumb");
    var tsvg = document.createElementNS(NS, "svg");
    thumb.appendChild(tsvg);
    R.renderPreview(tsvg, { version: 1, size: app.doc.size, activeLayerId: L.id, layers: [L] }, 24 / app.doc.size);

    var name = mk("span", "name");
    name.textContent = L.name;
    name.title = "Double-click to rename";

    var opacity = mk("input", "lopacity");
    opacity.type = "range";
    opacity.min = 0; opacity.max = 1; opacity.step = 0.05;
    opacity.value = L.opacity;
    opacity.setAttribute("aria-label", "Opacity of " + L.name);
    opacity.title = "Layer opacity";

    row.addEventListener("click", function () {
      setActiveLayer(L.id);
      renderAll();
    });

    eye.addEventListener("click", function (ev) {
      ev.stopPropagation();
      pushHistory("Toggle visibility", { type: "layer-style", layerId: L.id, field: "visible", from: L.visible, to: !L.visible });
    });

    lock.addEventListener("click", function (ev) {
      ev.stopPropagation();
      pushHistory("Toggle lock", { type: "layer-style", layerId: L.id, field: "locked", from: L.locked, to: !L.locked });
    });

    // opacity: live while dragging, one undo step on release
    var opBefore = null;
    function beginOpacity() { if (opBefore === null) opBefore = L.opacity; }
    function endOpacity() {
      if (opBefore === null) return;
      var from = opBefore;
      opBefore = null;
      if (from !== L.opacity) {
        pushHistory("Layer opacity", { type: "layer-style", layerId: L.id, field: "opacity", from: from, to: L.opacity }, { applied: true });
      }
    }
    opacity.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); beginOpacity(); });
    opacity.addEventListener("click", function (ev) { ev.stopPropagation(); });
    opacity.addEventListener("input", function () {
      beginOpacity();
      L.opacity = parseFloat(opacity.value);
      requestRender();
    });
    opacity.addEventListener("change", endOpacity);
    opacity.addEventListener("blur", endOpacity);

    name.addEventListener("dblclick", function (ev) {
      ev.stopPropagation();
      var input = mk("input");
      input.type = "text";
      input.value = L.name;
      input.maxLength = 60;
      input.setAttribute("aria-label", "Layer name");
      app.renameEditing = true;
      row.replaceChild(input, name);
      input.focus();
      input.select();
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        app.renameEditing = false;
        var v = input.value.trim();
        if (save && v && v !== L.name) {
          pushHistory("Rename layer", { type: "layer-style", layerId: L.id, field: "name", from: L.name, to: v });
        } else {
          markDirty();
          renderAll();
        }
      }
      input.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", function () { finish(true); });
    });

    row.addEventListener("dragstart", function (ev) {
      app.dragLayerId = L.id;
      row.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", L.id); } catch (err) { /* some browsers */ }
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("dragging");
      app.dragLayerId = null;
    });
    row.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", function (ev) {
      ev.preventDefault();
      var from = M.layerIndex(app.doc, app.dragLayerId);
      app.dragLayerId = null;
      if (from < 0 || from === idx) return;
      pushHistory("Reorder layers", { type: "layer-move", from: from, to: idx });
    });

    row.appendChild(eye);
    row.appendChild(lock);
    row.appendChild(thumb);
    row.appendChild(name);
    row.appendChild(opacity);
    return row;
  }

  function addLayer() {
    var layer = M.makeLayer("Layer " + (app.doc.layers.length + 1));
    var at = activeLayerIndex() + 1;
    pushHistory("Add layer", { type: "layer-add", index: at, layer: layer });
    setActiveLayer(layer.id);
    renderAll();
  }

  function duplicateLayer() {
    var src = activeLayer();
    if (!src) return;
    var copy = M.clone(src);
    copy.id = M.uid();
    copy.name = src.name + " copy";
    for (var i = 0; i < copy.paths.length; i++) copy.paths[i].id = M.uid();
    pushHistory("Duplicate layer", { type: "layer-add", index: activeLayerIndex() + 1, layer: copy });
    setActiveLayer(copy.id);
    renderAll();
  }

  function deleteLayer() {
    if (app.doc.layers.length <= 1) {
      toast("An icon needs at least one layer.");
      return;
    }
    var idx = activeLayerIndex();
    var L = app.doc.layers[idx];
    var neighbour = app.doc.layers[idx - 1] || app.doc.layers[idx + 1];
    app.doc.activeLayerId = neighbour.id;
    pushHistory("Delete layer", { type: "layer-delete", index: idx, layer: M.clone(L) });
    select([], null);
    renderAll();
  }

  /* ---------- style panel: state and changes ---------- */

  var gesture = null;   // style changes that are one continuous gesture

  // Starts a gesture: remembers the style of the selection before the change.
  function gestureBegin() {
    if (gesture) return;
    gesture = {
      before: selectedPaths().map(function (p) {
        return {
          layerId: app.doc.activeLayerId, id: p.id,
          fill: M.clone(p.fill), stroke: M.clone(p.stroke), dash: M.clone(p.dash)
        };
      })
    };
  }

  // Ends a gesture, recording only the style fields that really changed.
  function gestureEnd(label) {
    var g = gesture;
    gesture = null;
    if (!g) return;
    var ops = [];
    g.before.forEach(function (b) {
      var p = M.pathIn(app.doc, b.layerId, b.id);
      if (!p) return;
      ["fill", "stroke", "dash"].forEach(function (field) {
        if (JSON.stringify(b[field]) !== JSON.stringify(p[field])) {
          ops.push({ type: "style", layerId: b.layerId, id: b.id, field: field, from: b[field], to: M.clone(p[field]) });
        }
      });
    });
    if (ops.length) pushHistory(label || "Style", ops.length === 1 ? ops[0] : { type: "batch", ops: ops }, { applied: true });
    else { markDirty(); renderAll(); }
  }

  function styleChange(label, fn) {
    gestureBegin();
    fn();
    gestureEnd(label);
  }

  function forSelected(fn) {
    var paths = selectedPaths();
    for (var i = 0; i < paths.length; i++) fn(paths[i]);
  }

  function ensureGradient(p) {
    if (!p.fill.gradient) p.fill.gradient = IM.Tools.gradientFor(p, app.state.gradient.stops);
  }

  // Replaces the gradient stops in the style state and on the selection.
  function setStops(stops) {
    app.state.gradient.stops = stops;
    forSelected(function (p) {
      ensureGradient(p);
      p.fill.gradient.stops = M.clone(stops);
    });
  }

  function setFillKind(kind) {
    app.state.fillKind = kind;
    forSelected(function (p) {
      if (kind === "gradient") ensureGradient(p);
      p.fill.kind = kind;
    });
  }

  function setFillColor(c) {
    var st = app.state;
    if (st.fillKind === "gradient") {
      var stops = M.clone(st.gradient.stops);
      stops[st.gradSel].color = c;
      setStops(stops);
      return;
    }
    st.fillColor = c;
    if (st.fillKind === "none") st.fillKind = "color";
    forSelected(function (p) {
      p.fill.color = c;
      if (p.fill.kind === "none") p.fill.kind = "color";
    });
  }

  function setFillOpacity(a) {
    app.state.fillOpacity = a;
    forSelected(function (p) { p.fill.opacity = a; });
  }

  function setStrokeColor(c) {
    app.state.strokeColor = c;
    forSelected(function (p) { p.stroke.color = c; });
  }

  function setStrokeOpacity(a) {
    app.state.strokeOpacity = a;
    forSelected(function (p) { p.stroke.opacity = a; });
  }

  // True when new shapes (not lines) are what the thickness control describes.
  function shapeContext() {
    var p = primaryPath();
    if (p) return p.closed;
    var t = app.state.tool;
    return t === "rect" || t === "ellipse";
  }

  // The thickness shown in the panel: the selected shape's, else the default
  // for the active tool.
  function displayedStrokeWidth() {
    var p = primaryPath();
    if (p) return p.stroke.width;
    return shapeContext() ? app.state.shapeWidth : app.state.strokeWidth;
  }

  function setStrokeWidth(w) {
    if (shapeContext()) app.state.shapeWidth = w;
    else app.state.strokeWidth = w;
    forSelected(function (p) { p.stroke.width = w; });
  }

  function setDash(d) {
    app.state.dash = d;
    forSelected(function (p) { p.dash = d === "none" ? null : { pattern: d }; });
  }

  function gradCss(stops) {
    var parts = stops.map(function (s) { return s.color + " " + Math.round(s.offset * 100) + "%"; });
    return "linear-gradient(90deg, " + parts.join(", ") + ")";
  }

  function refreshStyle() {
    var st = app.state;
    qs("#fill-color").value = st.fillKind === "gradient" ? st.gradient.stops[st.gradSel].color : st.fillColor;
    qs("#stroke-color").value = st.strokeColor;
    qs("#grad-bar").classList.toggle("hidden", st.fillKind !== "gradient");
    qsa("[data-fill-kind]").forEach(function (b) {
      var on = b.getAttribute("data-fill-kind") === st.fillKind;
      b.classList.toggle("sel", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    // sliders and their number boxes (opacity in %, thickness in px) show one value
    var width = displayedStrokeWidth();
    qs("#fill-opacity").value = st.fillOpacity;
    qs("#fill-opacity-n").value = Math.round(st.fillOpacity * 100);
    qs("#stroke-opacity").value = st.strokeOpacity;
    qs("#stroke-opacity-n").value = Math.round(st.strokeOpacity * 100);
    qs("#stroke-width").value = width;
    qs("#stroke-width-n").value = Math.round(width * 100) / 100;
    qsa("[data-dash]").forEach(function (b) {
      var on = b.getAttribute("data-dash") === st.dash;
      b.classList.toggle("sel", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    renderGradBar();
  }

  function renderGradBar() {
    var bar = qs("#grad-bar");
    var st = app.state, stops = st.gradient.stops;
    bar.style.background = gradCss(stops);
    var handles = bar.querySelectorAll(".stop");
    for (var i = 0; i < handles.length; i++) {
      handles[i].style.left = (stops[i].offset * 100) + "%";
      handles[i].style.background = stops[i].color;
      handles[i].classList.toggle("sel", i === st.gradSel);
    }
  }

  function buildGradBar() {
    var bar = qs("#grad-bar");
    for (var s = 0; s < 2; s++) {
      (function (index) {
        var handle = mk("div", "stop");
        handle.setAttribute("role", "slider");
        handle.setAttribute("aria-label", index === 0 ? "Start colour stop" : "End colour stop");
        handle.setAttribute("tabindex", "0");
        bar.appendChild(handle);
        handle.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          app.state.gradSel = index;
          gestureBegin();
          var rect = bar.getBoundingClientRect();
          function move(e) {
            var offset = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            var stops = M.clone(app.state.gradient.stops);
            stops[index].offset = offset;
            stops.sort(function (a, b) { return a.offset - b.offset; });
            app.state.gradSel = stops.indexOf(stops.filter(function (x) { return x.offset === offset; })[0]);
            setStops(stops);
            requestRender();
          }
          function up() {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            gestureEnd("Gradient");
            markDirty();
            renderAll();
          }
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
      })(s);
    }
  }

  /* ---------- file and export ---------- */

  function saveProject() {
    IM.io.save(app.doc);
    toast("Saved icon-" + app.doc.size + ".iconmaker.json");
  }

  function openProject() {
    if (hasDrawing() && !window.confirm("Open a saved icon? This replaces the drawing on screen.")) return;
    qs("#open-file").click();
  }

  function setupDoc(doc) {
    app.doc = doc;
    ensureActiveLayer();
    resetHistory(doc);
    app.tx = null;
    app.state.selPathIds = [];
    app.state.selPathId = null;
    app.state.selPointIndex = -1;
    app.state.penDraft = null;
    app.state.ghost = null;
    app.state.penPreviewSeg = null;
    fit();
    markDirty();
    renderAll();
  }

  function newIcon() {
    if (hasDrawing() && !window.confirm("Start a new icon? The drawing on screen will be cleared. Save it first to keep it.")) return;
    setupDoc(M.newDoc(app.doc.size));
    toast("New icon");
  }

  function openHelp() {
    var d = qs("#help");
    if (d.showModal) d.showModal();
    else d.setAttribute("open", "");
    d.scrollTop = 0;     // the browser focuses the last button, which would scroll to the bottom
  }

  /* ---------- wiring ---------- */

  function wireTopbar() {
    qsa("#size-group .chip").forEach(function (c) {
      c.addEventListener("click", function () { setSize(+c.getAttribute("data-size")); });
    });
    qs("#undo").addEventListener("click", undo);
    qs("#redo").addEventListener("click", redo);
    qs("#new").addEventListener("click", newIcon);
    qs("#open").addEventListener("click", openProject);
    qs("#save").addEventListener("click", saveProject);
    qs("#open-file").addEventListener("change", function () {
      var input = this;
      var file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      IM.io.loadFile(file, function (doc) {
        if (!doc) {
          toast("That file is not an IconMaker project.");
          return;
        }
        setupDoc(doc);
        toast("Opened " + file.name);
      });
    });
    qs("#export-svg").addEventListener("click", function () {
      IM.Export.downloadSVG(app.doc, app.doc.size);
      toast("SVG saved");
    });
    qs("#export-png").addEventListener("click", function () {
      IM.Export.downloadPNG(app.doc, app.doc.size, function (ok) {
        toast(ok ? "PNG saved" : "Could not make the PNG");
      });
    });
    qs("#export-all").addEventListener("click", function () {
      toast("Saving PNG files…");
      IM.Export.exportAll(app.doc, function (n) { toast(n + " PNG files saved"); });
    });
    qs("#help-btn").addEventListener("click", openHelp);
    qs("#help-close").addEventListener("click", function () { qs("#help").close(); });
    // a click outside the window (on the dimmed backdrop) closes it
    qs("#help").addEventListener("click", function (ev) {
      var r = this.getBoundingClientRect();
      var outside = ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
      if (ev.target === this && outside) this.close();   // target check: keyboard clicks report (0,0)
    });
    qs("#hint-close").addEventListener("click", function () {
      setHints(false);
      toast("Tips hidden. You can turn them back on in Help (?).");
    });
    qs("#help-hints").addEventListener("change", function () { setHints(this.checked); });
  }

  function wireToolbar() {
    qsa("#tools .tool").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTool(btn.getAttribute("data-tool"));
        if (btn.blur && btn.isConnected) btn.blur();
      });
    });
    qs("#snap-toggle").addEventListener("click", toggleSnap);
    qs("#grid-toggle").addEventListener("click", toggleGrid);
    qs("#zoom-out").addEventListener("click", function () { stepZoom(-1); });
    qs("#zoom-in").addEventListener("click", function () { stepZoom(1); });
    qs("#zoom-fit").addEventListener("click", function () { fit(); renderAll(); });
  }

  function wirePanels() {
    function showTab(which) {
      var layers = which === "layers";
      qs("#panel-layers").classList.toggle("hidden", !layers);
      qs("#panel-style").classList.toggle("hidden", layers);
      qs("#tab-layers").classList.toggle("sel", layers);
      qs("#tab-style").classList.toggle("sel", !layers);
      qs("#tab-layers").setAttribute("aria-selected", layers ? "true" : "false");
      qs("#tab-style").setAttribute("aria-selected", layers ? "false" : "true");
    }
    qs("#tab-layers").addEventListener("click", function () { showTab("layers"); });
    qs("#tab-style").addEventListener("click", function () { showTab("style"); });

    qs("#shape-group").addEventListener("click", groupSelection);
    qs("#shape-ungroup").addEventListener("click", ungroupSelection);
    ["union", "subtract", "intersect", "exclude"].forEach(function (k) {
      qs("#shape-" + k).addEventListener("click", function () { mergeSelection(k); });
    });

    qs("#layer-add").addEventListener("click", addLayer);
    qs("#layer-dup").addEventListener("click", duplicateLayer);
    qs("#layer-del").addEventListener("click", deleteLayer);

    function wireColour(id, target, apply, label) {
      var colour = qs(id);
      colour.addEventListener("focus", function () {
        app.state.styleTarget = target;
        gestureBegin();
      });
      colour.addEventListener("input", function () {
        gestureBegin();
        apply(colour.value);
        requestRender();
      });
      colour.addEventListener("change", function () { gestureEnd(label); });
      colour.addEventListener("blur", function () { gestureEnd(label); });
    }
    wireColour("#fill-color", "fill", setFillColor, "Area colour");
    wireColour("#stroke-color", "stroke", setStrokeColor, "Border colour");
    qsa(".style-sec").forEach(function (sec) {
      sec.addEventListener("pointerdown", function () {
        app.state.styleTarget = sec.getAttribute("data-target");
      });
    });

    // A slider plus a number box edit one value. Both change the drawing live
    // and the whole drag or typing session undoes as one step.
    // `scale` converts the setting to the number shown (opacity 0..1 -> 0..100 %).
    function sliderGesture(sliderId, boxId, label, apply, scale, boxMax) {
      var slider = qs(sliderId), box = qs(boxId);
      var min = parseFloat(slider.min);
      var max = boxMax / scale;
      function show(v) { box.value = Math.round(v * scale * 100) / 100; }
      slider.addEventListener("pointerdown", gestureBegin);
      slider.addEventListener("input", function () {
        gestureBegin();
        var v = parseFloat(slider.value);
        apply(v);
        show(v);
        requestRender();
      });
      slider.addEventListener("change", function () { gestureEnd(label); });
      box.addEventListener("input", function () {
        var typed = parseFloat(box.value);
        if (!isFinite(typed)) return;               // empty or half-typed: wait
        var v = clamp(typed / scale, min, max);
        gestureBegin();
        apply(v);
        slider.value = v;
        requestRender();
      });
      box.addEventListener("change", function () { gestureEnd(label); });
      box.addEventListener("blur", function () { gestureEnd(label); });
      box.addEventListener("keydown", function (ev) {
        ev.stopPropagation();                       // typing must not trigger shortcuts
        if (ev.key === "Enter" || ev.key === "Escape") box.blur();
      });
    }
    sliderGesture("#fill-opacity", "#fill-opacity-n", "Fill opacity", setFillOpacity, 100, 100);
    sliderGesture("#stroke-opacity", "#stroke-opacity-n", "Outline opacity", setStrokeOpacity, 100, 100);
    sliderGesture("#stroke-width", "#stroke-width-n", "Outline width", setStrokeWidth, 1, 64);

    qsa("[data-fill-kind]").forEach(function (b) {
      b.addEventListener("click", function () {
        var kind = b.getAttribute("data-fill-kind");
        styleChange("Fill style", function () { setFillKind(kind); });
        markDirty();
        renderAll();
      });
    });

    qsa("[data-dash]").forEach(function (b) {
      b.addEventListener("click", function () {
        var d = b.getAttribute("data-dash");
        styleChange("Dash style", function () { setDash(d); });
        markDirty();
        renderAll();
      });
    });

    qs("#z-front").addEventListener("click", function () { changeOrder(1, true); });
    qs("#z-fwd").addEventListener("click", function () { changeOrder(1, false); });
    qs("#z-bwd").addEventListener("click", function () { changeOrder(-1, false); });
    qs("#z-back").addEventListener("click", function () { changeOrder(-1, true); });
  }

  /* ---------- boot ---------- */

  function buildCanvas() {
    var svg = qs("#canvas");
    var world = document.createElementNS(NS, "g");
    world.setAttribute("id", "world");
    function group(name) {
      var g = document.createElementNS(NS, "g");
      g.setAttribute("data-g", name);
      world.appendChild(g);
      return g;
    }
    var defsG = group("defs"), artG = group("art"), gridG = group("grid");
    var layersG = group("layers"), overlayG = group("overlay");
    layersG.setAttribute("pointer-events", "none");
    svg.appendChild(world);
    app.canvas = { svg: svg, worldG: world, defsG: defsG, artG: artG, gridG: gridG, layersG: layersG, overlayG: overlayG };
  }

  function buildMini() {
    var host = qs("#preview-mini");
    SIZES.forEach(function (s) {
      var cell = document.createElement("div");
      cell.className = "mini-cell";
      var box = document.createElement("div");
      box.className = "mini-box";
      var sv = document.createElementNS(NS, "svg");
      sv.setAttribute("class", "mini");
      sv.setAttribute("role", "img");
      sv.setAttribute("aria-label", "The icon at " + s + " by " + s + " pixels");
      box.appendChild(sv);
      cell.appendChild(box);
      var label = document.createElement("span");
      label.className = "mini-label";
      label.textContent = s + " px";
      cell.appendChild(label);
      host.appendChild(cell);
      app.miniSvgs.push({ svg: sv, size: s });
    });
  }

  // Re-fit after a window resize, but only if the user has not zoomed or panned since the last fit.
  function onResize() {
    var v = app.view, f = app.fitView;
    if (f && v.zoom === f.zoom && v.panX === f.panX && v.panY === f.panY) fit();
    requestRender();
  }

  // Tooltips (data-tip) live on <body> and are positioned with fixed coordinates,
  // so no panel or scroll area can clip them. They flip to stay inside the window.
  function wireTooltips() {
    var tip = mk("div", "tooltip");
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    var timer = null, current = null;

    function place(target) {
      var r = target.getBoundingClientRect();
      var w = tip.offsetWidth, h = tip.offsetHeight, gap = 9, pad = 8;
      var inTools = !!target.closest("#tools");
      var x, y;
      if (inTools) {
        x = r.right + gap + 1;
        y = r.top + r.height / 2 - h / 2;
      } else {
        x = r.left + r.width / 2 - w / 2;
        y = r.bottom + gap;
        if (y + h > window.innerHeight - pad) y = r.top - h - gap;   // no room below: go above
      }
      tip.style.left = clamp(x, pad, Math.max(pad, window.innerWidth - w - pad)) + "px";
      tip.style.top = clamp(y, pad, Math.max(pad, window.innerHeight - h - pad)) + "px";
    }
    function hide() {
      clearTimeout(timer);
      current = null;
      tip.classList.remove("show");
    }
    function show(target) {
      var text = target.getAttribute("data-tip");
      if (!text) return;
      current = target;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (current !== target || !target.isConnected) return;
        tip.textContent = text;
        tip.style.left = "0px"; tip.style.top = "0px";
        place(target);
        tip.classList.add("show");
      }, 350);
    }
    document.addEventListener("pointerover", function (ev) {
      var t = ev.target.closest ? ev.target.closest("[data-tip]") : null;
      if (t !== current) hide();
      if (t) show(t);
    });
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    document.addEventListener("focusin", function (ev) {
      var t = ev.target.closest ? ev.target.closest("[data-tip]") : null;
      if (t && t.matches(":focus-visible")) show(t);
    });
    document.addEventListener("focusout", hide);
  }

  function boot() {
    buildCanvas();
    app.layersPanel = qs("#layer-list");
    buildMini();
    buildGradBar();
    wireCanvas();
    wireTopbar();
    wireToolbar();
    wirePanels();
    wireTooltips();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onResize);

    app.state.hints = loadHintsPref();
    qs("#help-hints").checked = app.state.hints;

    var restored = IM.io.restore();
    setupDoc(restored || M.newDoc(DEFAULT_SIZE));
    updateToggles();
    setTool("select");
    app.canvas.svg.classList.add("tool-select");
    renderAll();
  }

  /* ---------- API for tools ---------- */

  app.toast = toast;
  app.pushHistory = pushHistory;
  app.beginTx = beginTx;
  app.endTx = endTx;
  app.select = select;
  app.expandGroups = expandGroups;
  app.setActiveLayer = setActiveLayer;
  app.activeLayer = activeLayer;
  app.renderAll = renderAll;
  app.requestRender = requestRender;
  app.setTool = setTool;
  app.setFillColor = function (c) { styleChange("Fill colour", function () { setFillColor(c); }); };
  app.setStrokeColor = function (c) { styleChange("Outline colour", function () { setStrokeColor(c); }); };
  app.fit = fit;
  app.undo = undo;
  app.redo = redo;
  app.groupSelection = groupSelection;
  app.ungroupSelection = ungroupSelection;
  app.mergeSelection = mergeSelection;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
