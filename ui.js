/* IconMaker — ui.js: the parts of the interface around the core editor.
 * Theme, artboard background and pixel preview; the empty state with starter
 * shapes; export, confirm and command-palette dialogs; context and "more"
 * menus; the side-panel drawer; colour hex fields and swatches; position,
 * size, align and distribute controls; the history list; hover outlines;
 * toolbar keyboard navigation and screen-reader announcements.
 * Loaded after main.js and talks to it only through IM.App.
 */
(function () {
  "use strict";

  var IM = window.IM, app = IM.App, M = IM.Model, R = IM.Renderer;
  var NS = "http://www.w3.org/2000/svg";
  var SIZES = [16, 32, 64, 128];

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch (e) { /* storage off: fine */ }
    return null;
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function render() { app.markDirty(); app.renderAll(); }

  /* ---------- screen reader announcements ---------- */

  var announceTimer = null;
  function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      var s = qs("#sr-status");
      s.textContent = "";
      setTimeout(function () { s.textContent = text; }, 30);
    }, 200);
  }

  /* ---------- appearance: theme and accent colour ---------- */

  var THEMES = ["system", "light", "dark"];
  var THEME_NAMES = { system: "match system", light: "light", dark: "dark" };
  var ACCENTS = ["red", "orange", "olive", "green", "teal", "blue", "purple", "pink"];
  var ACCENT_NAMES = { red: "Red", orange: "Orange", olive: "Olive", green: "Green", teal: "Teal", blue: "Blue", purple: "Purple", pink: "Pink" };
  var DEFAULT_ACCENT = "blue";
  var CHECK = "M5 12.5l4.5 4.5L19 7.5";

  function currentTheme() { return document.documentElement.getAttribute("data-theme") || "system"; }
  function currentAccent() {
    var a = document.documentElement.getAttribute("data-accent");
    return ACCENTS.indexOf(a) >= 0 ? a : DEFAULT_ACCENT;
  }
  function setTheme(mode) {
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    store("iconmaker.theme", mode === "system" ? null : mode);
    syncAppearance();
  }
  function setAccent(name) {
    if (name === DEFAULT_ACCENT) document.documentElement.removeAttribute("data-accent");
    else document.documentElement.setAttribute("data-accent", name);
    store("iconmaker.accent", name === DEFAULT_ACCENT ? null : name);
    syncAppearance();
  }

  // the same controls live in the Appearance menu and in the welcome window
  function buildAccentRows() {
    qsa("[data-accent-row]").forEach(function (row) {
      ACCENTS.forEach(function (name) {
        var b = mk("button", "accent-dot");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.setAttribute("aria-label", ACCENT_NAMES[name]);
        b.setAttribute("data-tip", ACCENT_NAMES[name]);
        b.setAttribute("data-accent-opt", name);
        b.style.setProperty("--c", "var(--accent-" + name + ")");
        var svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        var p = document.createElementNS(NS, "path");
        p.setAttribute("d", CHECK);
        svg.appendChild(p);
        b.appendChild(svg);
        row.appendChild(b);
      });
    });
  }

  function syncAppearance() {
    var t = currentTheme(), a = currentAccent();
    qsa("[data-theme-opt]").forEach(function (b) {
      var on = b.getAttribute("data-theme-opt") === t;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.classList.toggle("sel", on);
    });
    qsa("[data-accent-opt]").forEach(function (b) {
      b.setAttribute("aria-checked", b.getAttribute("data-accent-opt") === a ? "true" : "false");
    });
    qsa("[data-accent-name]").forEach(function (e) { e.textContent = ACCENT_NAMES[a]; });
    var b = qs("#theme-btn"), label = "Appearance: " + THEME_NAMES[t] + " theme, " + ACCENT_NAMES[a].toLowerCase() + " accent";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-tip", label);
  }

  function wireAppearance() {
    buildAccentRows();
    qsa("[role='radiogroup']").forEach(function (g) {
      if (!g.querySelector("[data-theme-opt], [data-accent-opt]")) return;
      g.addEventListener("click", function (ev) {
        var b = ev.target.closest("[role='radio']");
        if (!b || !g.contains(b)) return;
        if (b.hasAttribute("data-theme-opt")) setTheme(b.getAttribute("data-theme-opt"));
        else setAccent(b.getAttribute("data-accent-opt"));
      });
    });
    syncAppearance();
  }

  var APPEARANCE_ID = "appearance";
  function openAppearance(anchor) {
    var menu = qs("#appearance");
    if (openMenuEl === menu) { closeMenu(); return; }
    closeMenu();
    anchor = anchor || qs("#theme-btn");
    var r = anchor.getBoundingClientRect();
    menuReturnFocus = anchor;
    if (anchor.id === "theme-btn") anchor.setAttribute("aria-expanded", "true");
    syncAppearance();
    menu.classList.remove("hidden");
    placeMenu(menu, r.right - menu.offsetWidth, r.bottom + 8);
    // land on the theme choice that is on now, not just the first button
    var cur = qs("[data-theme-opt].sel", menu);
    if (cur) cur.focus();
  }

  /* ---------- welcome window (first visit) ---------- */

  var WELCOME_KEY = "iconmaker.welcomed";
  function openWelcome() {
    var d = qs("#welcome-dlg");
    if (d.open) return;
    closeMenu();
    syncAppearance();
    d.showModal();
    qs("#welcome-go").focus();
  }
  function wireWelcome() {
    var d = qs("#welcome-dlg");
    qs("#welcome-go").addEventListener("click", function () { d.close(); });
    d.addEventListener("close", function () { store(WELCOME_KEY, "1"); });
    // arrow keys move between the theme and accent choices
    d.addEventListener("keydown", function (ev) {
      if (ev.key.indexOf("Arrow") !== 0) return;
      var g = ev.target.closest("[role='radiogroup']");
      if (!g) return;
      var items = qsa("[role='radio']", g), i = items.indexOf(ev.target);
      if (i < 0) return;
      ev.preventDefault();
      var step = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    });
    if (!store(WELCOME_KEY)) setTimeout(openWelcome, 350);
  }

  /* ---------- artboard background and pixel preview ---------- */

  var BGS = ["checker", "light", "dark"];
  var BG_NAMES = { checker: "checkerboard", light: "white", dark: "dark" };
  function setBg(bg, quiet) {
    app.state.artboardBg = bg;
    store("iconmaker.bg", bg);
    document.body.setAttribute("data-artboard", bg);   // previews and layer thumbnails follow it
    var b = qs("#bg-toggle"), label = "Artboard background: " + BG_NAMES[bg] + " (Shift+B)";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-tip", label);
    if (!quiet) app.toast("Artboard background: " + BG_NAMES[bg]);
    app.renderAll();
  }
  function cycleBg() { setBg(BGS[(BGS.indexOf(app.state.artboardBg) + 1) % 3]); }

  var pixG = null, pixKey = "", pixSeq = 0, pixUrl = null;
  function togglePixel() {
    app.state.pixelPreview = !app.state.pixelPreview;
    var b = qs("#pixel-toggle");
    b.classList.toggle("on", app.state.pixelPreview);
    b.setAttribute("aria-pressed", app.state.pixelPreview ? "true" : "false");
    pixKey = "";
    app.toast(app.state.pixelPreview ? "Pixel preview on: the real pixels, enlarged" : "Pixel preview off");
    app.renderAll();
  }
  function updatePixel() {
    if (!pixG) return;
    var layersG = app.canvas.layersG;
    if (!app.state.pixelPreview) {
      layersG.removeAttribute("display");
      if (pixG.firstChild) pixG.removeChild(pixG.firstChild);
      return;
    }
    layersG.setAttribute("display", "none");
    var key = app.doc.size + JSON.stringify(app.doc.layers);
    if (key === pixKey) return;
    pixKey = key;
    var seq = ++pixSeq, size = app.doc.size;
    IM.Export.pngBlob(app.doc, size, 1, function (blob) {
      if (seq !== pixSeq || !blob) return;
      if (pixUrl) URL.revokeObjectURL(pixUrl);
      pixUrl = URL.createObjectURL(blob);
      while (pixG.firstChild) pixG.removeChild(pixG.firstChild);
      var img = document.createElementNS(NS, "image");
      img.setAttribute("href", pixUrl);
      img.setAttribute("width", size);
      img.setAttribute("height", size);
      img.setAttribute("style", "image-rendering: pixelated; image-rendering: crisp-edges");
      pixG.appendChild(img);
    });
  }

  /* ---------- starter shapes (empty state, palette) ---------- */

  function roundRect(x0, y0, x1, y1, r) {
    var k = 0.5523 * r, P = M.pt;
    return [
      P(x0 + r, y0, -k, 0, 0, 0), P(x1 - r, y0, 0, 0, k, 0),
      P(x1, y0 + r, 0, -k, 0, 0), P(x1, y1 - r, 0, 0, 0, k),
      P(x1 - r, y1, k, 0, 0, 0), P(x0 + r, y1, 0, 0, -k, 0),
      P(x0, y1 - r, 0, k, 0, 0), P(x0, y0 + r, 0, 0, 0, -k)
    ];
  }

  function starterPoints(kind, S) {
    var m = S * 0.125, i;
    if (kind === "circle") return IM.Tools.shapeGeom("ellipse", m, m, S - m, S - m, false, false, S).points;
    if (kind === "square") return roundRect(m, m, S - m, S - m, S * 0.18);
    if (kind === "star") {
      var pts = [], cx = S / 2, cy = S * 0.53, ro = S * 0.42, ri = ro * 0.45;
      for (i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? ri : ro;
        pts.push(M.pt(round1(cx + r * Math.cos(a)), round1(cy + r * Math.sin(a))));
      }
      return pts;
    }
    // heart: anchor points and handles in 0..1 units
    var h = [
      [0.5, 0.88, 0.4, -0.3, -0.4, -0.3],
      [0.12, 0.34, -0.1, 0.13, 0.04, -0.16],
      [0.5, 0.26, -0.08, -0.13, 0.08, -0.13],
      [0.88, 0.34, -0.04, -0.16, 0.1, 0.13]
    ];
    return h.map(function (q) {
      return M.pt(q[0] * S, q[1] * S, q[2] * S, q[3] * S, q[4] * S, q[5] * S);
    });
  }

  var STARTER_NAMES = { circle: "circle", square: "rounded square", star: "star", heart: "heart" };
  function addStarter(kind) {
    var L = app.activeLayer();
    if (!L) return;
    if (!L.visible || L.locked) {
      app.toast("This layer is " + (L.locked ? "locked" : "hidden") + ". Choose another layer first.");
      return;
    }
    var st = app.state, path = IM.Tools.newDrawingPath(app, starterPoints(kind, app.doc.size), true, true);
    path.fill = { kind: "color", color: st.fillKind === "none" ? "#000000" : st.fillColor, opacity: st.fillOpacity || 1, gradient: null };
    if (st.fillKind === "gradient") {
      path.fill.kind = "gradient";
      path.fill.gradient = IM.Tools.gradientFor(path, st.gradient.stops);
    }
    app.pushHistory("Add " + STARTER_NAMES[kind], { type: "add", layerId: L.id, path: path });
    app.setTool("select");
    app.select([path.id], path.id);
    render();
    app.toast("Added a " + STARTER_NAMES[kind] + ". Drag to move it, or press T to edit its points.");
  }

  function updateEmptyState() {
    var e = qs("#empty-state"), empty = !app.hasDrawing();
    if (!empty) app.state.emptyStateDismissed = true;
    e.classList.toggle("hidden", !empty || app.state.emptyStateDismissed);
  }

  function wireEmptyState() {
    document.addEventListener("pointerdown", function (event) {
      var card = qs("#empty-state");
      if (card.classList.contains("hidden") || card.contains(event.target) || qs("dialog[open]")) return;
      app.state.emptyStateDismissed = true;
      updateEmptyState();
    }, true);
  }

  /* ---------- generic menu (more menu, context menu) ---------- */

  var openMenuEl = null, menuReturnFocus = null;
  function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.classList.add("hidden");
    var btn = openMenuEl.id === "more-menu" ? qs("#more-btn") : openMenuEl.id === APPEARANCE_ID ? qs("#theme-btn") : openMenuEl.id === "object-menu" ? qs("#add-object") : null;
    if (btn) btn.setAttribute("aria-expanded", "false");
    openMenuEl = null;
    if (menuReturnFocus && menuReturnFocus.isConnected) menuReturnFocus.focus();
    menuReturnFocus = null;
  }
  function placeMenu(menu, x, y) {
    menu.classList.remove("hidden");
    var w = menu.offsetWidth, h = menu.offsetHeight, pad = 8;
    menu.style.left = Math.max(pad, Math.min(x, window.innerWidth - w - pad)) + "px";
    menu.style.top = Math.max(pad, Math.min(y, window.innerHeight - h - pad)) + "px";
    openMenuEl = menu;
    var first = menu.querySelector("button:not([aria-disabled='true'])");
    if (first) first.focus();
  }
  function menuKeys(ev) {
    if (!openMenuEl) return;
    var items = qsa("button", openMenuEl), i = items.indexOf(document.activeElement);
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || (openMenuEl.id === APPEARANCE_ID && (ev.key === "ArrowRight" || ev.key === "ArrowLeft"))) {
      ev.preventDefault();
      ev.stopPropagation();
      var d = ev.key === "ArrowDown" || ev.key === "ArrowRight" ? 1 : -1;
      items[(i + d + items.length) % items.length].focus();
    } else if (ev.key === "Tab") closeMenu();
  }

  // items: [{label, kbd, run, disabled, danger}] or "sep"
  function fillMenu(menu, items) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    items.forEach(function (it) {
      if (it === "sep") { menu.appendChild(mk("div", "menu-sep")); return; }
      var b = mk("button", "menu-item" + (it.danger ? " danger" : ""));
      b.setAttribute("role", "menuitem");
      b.appendChild(mk("span", null, it.label));
      if (it.kbd) b.appendChild(mk("kbd", null, it.kbd));
      if (it.disabled) b.setAttribute("aria-disabled", "true");
      b.addEventListener("click", function () {
        if (it.disabled) return;
        closeMenu();
        it.run();
      });
      menu.appendChild(b);
    });
  }

  function contextItems() {
    var sel = app.selectedPaths(), has = sel.length > 0;
    var grouped = sel.some(function (p) { return !!p.groupId; });
    var items = [
      { label: "Copy", kbd: "Ctrl+C", run: app.copySelection, disabled: !has },
      { label: "Paste", kbd: "Ctrl+V", run: app.pasteSelection, disabled: !(app.state.clip && app.state.clip.length) },
      { label: "Duplicate", kbd: "Ctrl+D", run: app.duplicateSelection, disabled: !has },
      "sep",
      { label: "Group", kbd: "Ctrl+G", run: app.groupSelection, disabled: sel.length < 2 },
      { label: "Ungroup", kbd: "Ctrl+Shift+G", run: app.ungroupSelection, disabled: !grouped },
      "sep",
      { label: "Bring to front", kbd: "Shift+]", run: function () { app.changeOrder(1, true); }, disabled: !has },
      { label: "Send to back", kbd: "Shift+[", run: function () { app.changeOrder(-1, true); }, disabled: !has },
      { label: "Flip left to right", run: function () { flip("h"); }, disabled: !has },
      { label: "Flip top to bottom", run: function () { flip("v"); }, disabled: !has },
      "sep",
      { label: "Select all", kbd: "Ctrl+A", run: app.selectAll },
      { label: "Delete", kbd: "Del", run: app.deleteSelection, disabled: !has, danger: true }
    ];
    return items;
  }

  function docPoint(clientX, clientY) {
    var r = app.canvas.svg.getBoundingClientRect(), v = app.view;
    return { x: (clientX - r.left - v.panX) / v.zoom, y: (clientY - r.top - v.panY) / v.zoom };
  }

  function openContextMenu(clientX, clientY) {
    var p = docPoint(clientX, clientY);
    var hit = R.topHit(app.doc, p.x, p.y, 8 / app.view.zoom, app.doc.activeLayerId);
    if (hit && app.state.selPathIds.indexOf(hit.path.id) < 0) {
      app.select(app.expandGroups([hit.path.id]), hit.path.id);
      app.renderAll();
    }
    var menu = qs("#ctx-menu");
    fillMenu(menu, contextItems());
    menuReturnFocus = app.canvas.svg;
    placeMenu(menu, clientX, clientY);
  }

  function wireContextMenu() {
    var svg = app.canvas.svg, timer = null, start = null;
    svg.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      openContextMenu(ev.clientX, ev.clientY);
    });
    // press and hold on a touch screen
    svg.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType !== "touch") return;
      clearTimeout(timer);
      start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
      timer = setTimeout(function () {
        timer = null;
        app.cancelGesture();
        openContextMenu(start.x, start.y);
      }, 550);
    });
    svg.addEventListener("pointermove", function (ev) {
      if (!timer || !start || ev.pointerId !== start.id) return;
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) { clearTimeout(timer); timer = null; }
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
      svg.addEventListener(t, function () { clearTimeout(timer); timer = null; });
    });
    document.addEventListener("pointerdown", function (ev) {
      if (openMenuEl && !openMenuEl.contains(ev.target) && ev.target.closest("#more-btn, #theme-btn") === null) closeMenu();
    }, true);
    document.addEventListener("keydown", menuKeys, true);
  }

  /* ---------- "more" menu (narrow screens) ---------- */

  function runCmd(cmd) {
    if (cmd === "new") app.newIcon();
    else if (cmd === "open") app.openProject();
    else if (cmd === "save") app.saveProject();
    else if (cmd === "palette") openPalette();
    else if (cmd === "theme") openAppearance(qs("#more-btn"));
    else if (cmd === "help") app.openHelp();
  }

  function wireMoreMenu() {
    var btn = qs("#more-btn"), menu = qs("#more-menu");
    btn.addEventListener("click", function () {
      if (openMenuEl === menu) { closeMenu(); return; }
      closeMenu();
      qsa("[data-msize]", menu).forEach(function (c) {
        var on = +c.getAttribute("data-msize") === app.doc.size;
        c.classList.toggle("sel", on);
        c.setAttribute("aria-checked", on ? "true" : "false");
      });
      var r = btn.getBoundingClientRect();
      menuReturnFocus = btn;
      btn.setAttribute("aria-expanded", "true");
      placeMenu(menu, r.right - 220, r.bottom + 8);
    });
    qsa("[data-msize]", menu).forEach(function (c) {
      c.addEventListener("click", function () { closeMenu(); app.setSize(+c.getAttribute("data-msize")); });
    });
    qsa("[data-cmd]", menu).forEach(function (b) {
      b.addEventListener("click", function () { closeMenu(); runCmd(b.getAttribute("data-cmd")); });
    });
  }

  /* ---------- side panel drawer (below 1000 px) ---------- */

  function drawerMode() { return window.matchMedia("(max-width: 999px)").matches; }
  function setDrawer(open) {
    var panel = qs("#panel");
    open = open && drawerMode();
    panel.classList.toggle("open", open);
    qs("#panel-scrim").classList.toggle("hidden", !open);
    qs("#panel-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    qs("#panel-toggle").setAttribute("aria-label", open ? "Hide the side panel" : "Show the side panel");
    if (open) { var t = qs(".tab.sel", panel); if (t) t.focus(); }
  }
  function wireDrawer() {
    qs("#panel-toggle").addEventListener("click", function () { setDrawer(!qs("#panel").classList.contains("open")); });
    qs("#panel-close").addEventListener("click", function () { setDrawer(false); qs("#panel-toggle").focus(); });
    qs("#panel-scrim").addEventListener("click", function () { setDrawer(false); });
    window.addEventListener("resize", function () { if (!drawerMode()) setDrawer(false); });
  }

  /* ---------- real-size preview card ---------- */

  function setPreviewCollapsed(c) {
    var card = qs("#preview-card"), b = qs("#preview-collapse");
    card.classList.toggle("collapsed", c);
    b.setAttribute("aria-expanded", c ? "false" : "true");
    b.setAttribute("aria-label", c ? "Show the real-size preview" : "Hide the real-size preview");
    store("iconmaker.preview", c ? "collapsed" : null);
  }
  function wirePreviewCard() {
    setPreviewCollapsed(store("iconmaker.preview") === "collapsed");
    qs("#preview-collapse").addEventListener("click", function () {
      var v = app.view, f = app.fitView;
      var wasFit = f && v.zoom === f.zoom && v.panX === f.panX && v.panY === f.panY;
      setPreviewCollapsed(!qs("#preview-card").classList.contains("collapsed"));
      if (wasFit) app.fit(true);
    });
  }

  /* ---------- confirm dialog ---------- */

  var confirmCb = null;
  app.confirm = function (opts, cb) {
    var d = qs("#confirm-dlg");
    qs("#confirm-title").textContent = opts.title || "Are you sure?";
    qs("#confirm-body").textContent = opts.body || "";
    qs("#confirm-ok").textContent = opts.ok || "Continue";
    qs('[data-answer="save"]', d).classList.toggle("hidden", !opts.save);
    confirmCb = cb;
    d.returnValue = "cancel";
    d.showModal();
  };
  function wireConfirm() {
    var d = qs("#confirm-dlg");
    qsa("[data-answer]", d).forEach(function (b) {
      b.addEventListener("click", function () { d.close(b.getAttribute("data-answer")); });
    });
    d.addEventListener("close", function () {
      var cb = confirmCb;
      confirmCb = null;
      if (cb) cb(d.returnValue || "cancel");
    });
  }

  /* ---------- export dialog ---------- */

  function exportChoice() {
    var form = qs("#export-form");
    var fmt = qs('input[name="fmt"]:checked', form).value;
    var sizes = qsa('input[name="size"]:checked', form).map(function (i) { return +i.value; });
    var name = (qs("#export-name").value.trim() || "icon").replace(/[^\w\-. ]+/g, "-").replace(/\s+/g, "-");
    return { fmt: fmt, sizes: sizes, name: name };
  }
  function syncExport() {
    var c = exportChoice();
    qs("#fmt-note").textContent = c.fmt === "svg"
      ? "Sharp at any size. Best for websites, apps and design tools."
      : "A picture with a see-through background, at exactly these pixel sizes.";
    var files = c.sizes.map(function (s) { return c.name + "-" + s + "." + c.fmt; });
    qs("#export-files").textContent = files.length
      ? (files.length === 1 ? "Downloads " : "Downloads " + files.length + " files: ") + files.join(", ")
      : "Choose at least one size.";
    qs("#export-go").disabled = !files.length;
    qs("#export-go").textContent = files.length > 1 ? "Download " + files.length + " files" : "Download";
  }
  function openExport() {
    if (!app.hasDrawing()) { app.toast("Draw something first, then export it."); return; }
    var d = qs("#export-dlg"), form = qs("#export-form");
    qsa('input[name="size"]', form).forEach(function (i) { i.checked = +i.value === app.doc.size; });
    var last = store("iconmaker.export");
    if (last === "png" || last === "svg") qs('input[name="fmt"][value="' + last + '"]', form).checked = true;
    var name = store("iconmaker.exportName");
    if (name) qs("#export-name").value = name;
    var box = qs("#export-preview-box");
    while (box.firstChild) box.removeChild(box.firstChild);
    var sv = document.createElementNS(NS, "svg");
    box.appendChild(sv);
    R.renderPreview(sv, app.doc, 1);
    syncExport();
    d.showModal();
  }
  function wireExport() {
    var d = qs("#export-dlg"), form = qs("#export-form");
    qs("#export-btn").addEventListener("click", openExport);
    form.addEventListener("input", syncExport);
    form.addEventListener("change", syncExport);
    qsa("[data-close]", d).forEach(function (b) { b.addEventListener("click", function () { d.close(); }); });
    qs("#export-name").addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var c = exportChoice();
      if (!c.sizes.length) return;
      store("iconmaker.export", c.fmt);
      store("iconmaker.exportName", c.name);
      d.close();
      app.toast("Preparing " + (c.sizes.length > 1 ? c.sizes.length + " files…" : "your file…"));
      IM.Export.exportMany(app.doc, c.fmt, c.sizes, c.name, function (n) {
        if (n === c.sizes.length) app.toast(n === 1 ? "Downloaded " + c.name + "-" + c.sizes[0] + "." + c.fmt : "Downloaded " + n + " files", { success: true });
        else app.toast("Could not make " + (c.sizes.length - n) + " of the files. Please try again.");
      });
    });
  }

  /* ---------- selection helpers: align, distribute, transform ---------- */

  function selLayer() { return app.activeLayer(); }
  function selIds() { return app.selectedPaths().map(function (p) { return p.id; }); }
  function selBox() {
    var ids = selIds();
    return ids.length ? R.selectionBounds(selLayer(), ids, false) : null;
  }
  // Selected shapes as units: a group counts as one shape.
  function selUnits() {
    var L = selLayer(), map = {}, units = [];
    app.selectedPaths().forEach(function (p) {
      var k = p.groupId || p.id;
      if (!map[k]) { map[k] = { ids: [] }; units.push(map[k]); }
      map[k].ids.push(p.id);
    });
    units.forEach(function (u) { u.bb = R.selectionBounds(L, u.ids, false); });
    return units.filter(function (u) { return !!u.bb; });
  }
  function editable() {
    var L = selLayer();
    if (!app.state.selPathIds.length) { app.toast("Select a shape first."); return null; }
    if (L.locked) { app.toast("This layer is locked. Click its lock to unlock it."); return null; }
    return L;
  }
  function moves(label, list) {
    var L = selLayer(), any = false;
    app.beginTx(label);
    list.forEach(function (m) {
      if (Math.abs(m.dx) < 1e-9 && Math.abs(m.dy) < 1e-9) return;
      any = true;
      app.pushHistory(label, { type: "move", layerId: L.id, ids: m.ids, dx: m.dx, dy: m.dy });
    });
    app.endTx();
    render();
    return any;
  }

  var ALIGN_LABELS = { left: "Align left", hcenter: "Align centres", right: "Align right", top: "Align top", vcenter: "Align middles", bottom: "Align bottom" };
  function align(kind) {
    if (!editable()) return;
    var units = selUnits(), S = app.doc.size;
    var ref = units.length === 1 ? { x: 0, y: 0, w: S, h: S } : selBox();
    var list = units.map(function (u) {
      var b = u.bb, dx = 0, dy = 0;
      if (kind === "left") dx = ref.x - b.x;
      else if (kind === "hcenter") dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      else if (kind === "right") dx = ref.x + ref.w - (b.x + b.w);
      else if (kind === "top") dy = ref.y - b.y;
      else if (kind === "vcenter") dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      else if (kind === "bottom") dy = ref.y + ref.h - (b.y + b.h);
      return { ids: u.ids, dx: dx, dy: dy };
    });
    if (!moves(ALIGN_LABELS[kind], list)) app.toast("Already aligned.");
  }

  function distribute(axis) {
    if (!editable()) return;
    var units = selUnits();
    if (units.length < 3) { app.toast("Select 3 or more shapes to space them evenly."); return; }
    var h = axis === "h", pos = h ? "x" : "y", len = h ? "w" : "h";
    units.sort(function (a, b) { return (a.bb[pos] + a.bb[len] / 2) - (b.bb[pos] + b.bb[len] / 2); });
    var first = units[0].bb, last = units[units.length - 1].bb, total = 0;
    units.forEach(function (u) { total += u.bb[len]; });
    var gap = ((last[pos] + last[len]) - first[pos] - total) / (units.length - 1);
    var at = first[pos];
    var list = units.map(function (u) {
      var d = at - u.bb[pos];
      at += u.bb[len] + gap;
      return { ids: u.ids, dx: h ? d : 0, dy: h ? 0 : d };
    });
    if (!moves(h ? "Distribute horizontally" : "Distribute vertically", list)) app.toast("Already evenly spaced.");
  }

  function flip(dir) {
    var L = editable();
    if (!L) return;
    var bb = selBox();
    if (!bb) return;
    app.pushHistory(dir === "h" ? "Flip horizontally" : "Flip vertically", {
      type: "scale", layerId: L.id, ids: selIds(), sx: dir === "h" ? -1 : 1, sy: dir === "h" ? 1 : -1,
      cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2, keepStroke: true
    });
    render();
  }

  function rotateBy(deg) {
    var L = editable();
    if (!L || !deg) return;
    var bb = selBox();
    app.pushHistory("Rotate", { type: "rotate", layerId: L.id, ids: selIds(), angle: deg, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2 });
    render();
  }

  function applyTransformField(which) {
    var input = qs("#xf-" + which), v = parseFloat(input.value);
    var L = editable(), bb = selBox();
    if (!L || !bb || !isFinite(v)) { updateTransformFields(true); return; }
    var ids = selIds(), lock = qs("#xf-lock").getAttribute("aria-pressed") === "true";
    if (which === "x" || which === "y") {
      var d = v - bb[which];
      if (Math.abs(d) > 1e-9) app.pushHistory("Move", { type: "move", layerId: L.id, ids: ids, dx: which === "x" ? d : 0, dy: which === "y" ? d : 0 });
    } else {
      var cur = which === "w" ? bb.w : bb.h;
      if (v <= 0 || cur < 1e-6) { app.toast("A flat line has no " + (which === "w" ? "width" : "height") + " to change."); updateTransformFields(true); return; }
      var k = v / cur, sx = which === "w" ? k : (lock ? k : 1), sy = which === "h" ? k : (lock ? k : 1);
      if (Math.abs(k - 1) > 1e-9) app.pushHistory("Resize", { type: "scale", layerId: L.id, ids: ids, sx: sx, sy: sy, cx: bb.x, cy: bb.y, keepStroke: true });
    }
    render();
  }

  function updateTransformFields(force) {
    var bb = selBox();
    if (!bb) return;
    ["x", "y", "w", "h"].forEach(function (k) {
      var input = qs("#xf-" + k);
      if (!force && document.activeElement === input) return;
      input.value = round1(bb[k]);
    });
  }

  function wireTransform() {
    ["x", "y", "w", "h"].forEach(function (k) {
      var input = qs("#xf-" + k);
      input.addEventListener("change", function () { applyTransformField(k); });
      input.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { updateTransformFields(true); input.blur(); }
      });
    });
    var rot = qs("#xf-rot");
    rot.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        rotateBy(parseFloat(rot.value) || 0);
        rot.value = 0;
      }
      if (ev.key === "Escape") { rot.value = 0; rot.blur(); }
    });
    qs("#xf-rot90").addEventListener("click", function () { rotateBy(90); });
    qs("#xf-flip-h").addEventListener("click", function () { flip("h"); });
    qs("#xf-flip-v").addEventListener("click", function () { flip("v"); });
    qs("#xf-lock").addEventListener("click", function () {
      var b = qs("#xf-lock"), on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    qsa("[data-align]").forEach(function (b) { b.addEventListener("click", function () { align(b.getAttribute("data-align")); }); });
    qsa("[data-distribute]").forEach(function (b) { b.addEventListener("click", function () { distribute(b.getAttribute("data-distribute")); }); });
  }

  /* ---------- selection summary (runs every render) ---------- */

  var lastSelKey = "", lastTool = "";
  function updateSelectionUI() {
    var sel = app.selectedPaths(), n = sel.length, panel = qs("#panel-style");
    panel.classList.toggle("no-sel", n === 0);
    var units = n ? selUnits() : [];
    var summary = qs("#sel-summary"), bb = n ? selBox() : null;
    var key = app.state.tool + "|" + app.state.selPathIds.join(",") + "|" + (bb ? [bb.x, bb.y, bb.w, bb.h].map(round1).join(",") : "");
    if (key !== lastSelKey) {
      lastSelKey = key;
      if (!n) summary.textContent = "Select an object to style it, or use Fill and Outline.";
      else {
        var what = units.length === 1 && n > 1 ? "A group of " + n + " shapes" : n === 1 ? "1 shape" : n + " shapes";
        summary.innerHTML = "";
        summary.appendChild(mk("strong", null, what));
        summary.appendChild(document.createTextNode(" selected · " + round1(bb.w) + " × " + round1(bb.h) + " px"));
      }
      qs("#align-target").textContent = units.length > 1 ? "to each other" : "to the artboard";
      var hint = qs("#combine-hint");
      hint.textContent = n >= 2 ? "" : "select 2 or more shapes";
      qsa("[data-distribute]").forEach(function (b) { b.setAttribute("aria-disabled", units.length < 3 ? "true" : "false"); });
      updateTransformFields(false);
    }
    // announce selection and tool changes for screen readers
    var selKey = app.state.selPathIds.join(",");
    if (app.state.tool !== lastTool) {
      lastTool = app.state.tool;
      var btn = qs('#tools [data-tool="' + lastTool + '"]');
      if (btn) announce(btn.getAttribute("aria-label") + " tool");
      syncToolTabs();
    } else if (selKey !== updateSelectionUI.lastSel) {
      announce(n ? summary.textContent : "Selection cleared");
    }
    updateSelectionUI.lastSel = selKey;
  }

  /* ---------- colours: hex fields, swatches, recent, mixed values ---------- */

  var PALETTE = ["#000000", "#ffffff", "#5f6368", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#3949ab", "#8e24aa", "#d81b60"];
  var recent = [];
  try { recent = JSON.parse(store("iconmaker.recent") || "[]").filter(M.isColor).slice(0, 6); } catch (e) { recent = []; }

  function normHex(v) {
    v = String(v || "").trim().toLowerCase();
    if (v.charAt(0) !== "#") v = "#" + v;
    if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return /^#[0-9a-f]{6}$/.test(v) ? v : null;
  }
  function addRecent(c) {
    c = normHex(c);
    if (!c || PALETTE.indexOf(c) >= 0) return;
    recent = [c].concat(recent.filter(function (x) { return x !== c; })).slice(0, 6);
    store("iconmaker.recent", JSON.stringify(recent));
    buildSwatches();
  }
  function applyColour(target, c) {
    app.state.styleTarget = target;
    if (target === "fill") app.setFillColor(c);
    else app.setStrokeColor(c);
    addRecent(c);
    render();
  }
  function buildSwatches() {
    qsa(".swatches").forEach(function (box) {
      var target = box.getAttribute("data-swatch-target");
      while (box.firstChild) box.removeChild(box.firstChild);
      var list = PALETTE.slice();
      if (recent.length) list = list.concat(["|"], recent);
      if (target === "fill") list.push("none");
      list.forEach(function (c) {
        if (c === "|") { box.appendChild(mk("span", "swatch recent-sep")); return; }
        var b = mk("button", "swatch" + (c === "none" ? " none" : ""));
        if (c !== "none") b.style.background = c;
        var label = c === "none" ? "No area colour" : (recent.indexOf(c) >= 0 ? "Recent colour " : "Colour ") + c;
        b.setAttribute("aria-label", label);
        b.setAttribute("data-tip", c === "none" ? "No area colour" : c);
        b.addEventListener("click", function () {
          if (c === "none") { app.setFillKind("none"); return; }
          applyColour(target, c);
        });
        box.appendChild(b);
      });
    });
  }

  function mixed(paths, get) {
    if (paths.length < 2) return false;
    var a = JSON.stringify(get(paths[0]));
    for (var i = 1; i < paths.length; i++) if (JSON.stringify(get(paths[i])) !== a) return true;
    return false;
  }
  function showMixed(id, isMixed) {
    var e = qs(id);
    e.placeholder = isMixed ? "Mixed" : "";
    if (isMixed && document.activeElement !== e) e.value = "";
  }

  function refreshColourFields() {
    var st = app.state, paths = app.selectedPaths();
    var fillHex = qs("#fill-hex"), strokeHex = qs("#stroke-hex");
    var mFill = mixed(paths, function (p) { return [p.fill.kind, p.fill.color]; });
    var mStroke = mixed(paths, function (p) { return p.stroke.color; });
    if (document.activeElement !== fillHex) fillHex.value = mFill ? "" : qs("#fill-color").value;
    if (document.activeElement !== strokeHex) strokeHex.value = mStroke ? "" : qs("#stroke-color").value;
    fillHex.placeholder = mFill ? "Mixed" : "";
    strokeHex.placeholder = mStroke ? "Mixed" : "";
    qs("#fill-color").classList.toggle("mixed", mFill);
    qs("#stroke-color").classList.toggle("mixed", mStroke);
    showMixed("#fill-opacity-n", mixed(paths, function (p) { return p.fill.opacity; }));
    showMixed("#stroke-opacity-n", mixed(paths, function (p) { return p.stroke.opacity; }));
    showMixed("#stroke-width-n", mixed(paths, function (p) { return p.stroke.width; }));
    if (st.fillKind === "none" && !mFill) fillHex.placeholder = "None";
  }

  function wireColours() {
    [["#fill-hex", "fill"], ["#stroke-hex", "stroke"]].forEach(function (pair) {
      var input = qs(pair[0]), target = pair[1];
      function commit() {
        if (!input.value.trim()) { input.classList.remove("invalid"); refreshColourFields(); return; }
        var c = normHex(input.value);
        if (!c) {
          input.classList.add("invalid");
          app.toast("Use a hex colour like #2f8cff or #fff.");
          return;
        }
        input.classList.remove("invalid");
        input.value = c;
        applyColour(target, c);
      }
      input.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") { commit(); input.select(); }
        if (ev.key === "Escape") { input.classList.remove("invalid"); refreshColourFields(); input.blur(); }
      });
      input.addEventListener("blur", commit);
      input.addEventListener("input", function () { input.classList.remove("invalid"); });
    });
    ["#fill-color", "#stroke-color"].forEach(function (id) {
      qs(id).addEventListener("change", function () { addRecent(qs(id).value); refreshColourFields(); });
      qs(id).addEventListener("input", function () {
        var hex = qs(id === "#fill-color" ? "#fill-hex" : "#stroke-hex");
        hex.value = qs(id).value;
      });
    });
    buildSwatches();
  }

  /* ---------- history list ---------- */

  var OP_NAMES = {
    add: "Add shape", "delete": "Delete", move: "Move", scale: "Resize", rotate: "Rotate", style: "Style",
    geom: "Edit points", "node-move": "Move point", "node-handle": "Bend curve", zorder: "Change order",
    "layer-add": "Add layer", "layer-delete": "Delete layer", "layer-move": "Reorder layers",
    "layer-style": "Layer change", size: "Change size", "path-layer": "Move to layer", group: "Group",
    replace: "Combine shapes", batch: "Several changes"
  };
  function opLabel(op) { return op.label || OP_NAMES[op.type] || "Change"; }

  function refreshHistory() {
    if (app.panelTab !== "history") return;
    var list = qs("#history-list"), h = app.history;
    while (list.firstChild) list.removeChild(list.firstChild);
    var start = Math.max(0, h.stack.length - 150);
    function row(i, label) {
      var li = mk("li", i === h.ptr ? "current" : i > h.ptr ? "future" : "");
      var b = mk("button");
      b.appendChild(mk("span", "n", i < 0 ? "" : String(i + 1)));
      b.appendChild(mk("span", "lbl", label));
      if (i === h.ptr) b.setAttribute("aria-current", "step");
      b.setAttribute("aria-label", (i < 0 ? "The start" : "Step " + (i + 1) + ": " + label) + (i === h.ptr ? ", current" : i > h.ptr ? ", undone" : ""));
      b.addEventListener("click", function () { app.historyJump(i); });
      li.appendChild(b);
      list.appendChild(li);
    }
    if (start === 0) row(-1, "Start");
    for (var i = start; i < h.stack.length; i++) row(i, opLabel(h.stack[i]));
    var cur = qs(".current", list);
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }

  function wireObjectMenu() {
    var btn = qs("#add-object"), menu = qs("#object-menu");
    btn.addEventListener("click", function () {
      if (openMenuEl === menu) { closeMenu(); return; }
      closeMenu();
      var items = Object.keys(IM.Tools.shapeNames).map(function (kind) {
        return {
          label: IM.Tools.shapeNames[kind],
          kbd: kind === "rect" ? "R" : kind === "ellipse" ? "E" : "",
          run: function () { app.setTool(kind); app.canvas.svg.focus(); }
        };
      });
      fillMenu(menu, items);
      // Use the same editable geometry as the drawing tools for menu icons.
      qsa("button", menu).forEach(function (item, i) {
        var kind = Object.keys(IM.Tools.shapeNames)[i];
        var geometry = IM.Tools.shapeGeom(kind, 3, 3, 21, 21, false, false, 32);
        var path = M.makePath(true);
        path.points = geometry.points;
        var icon = document.createElementNS(NS, "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        var outline = document.createElementNS(NS, "path");
        outline.setAttribute("d", R.pathD(path));
        icon.appendChild(outline);
        item.insertBefore(icon, item.firstChild);
      });
      var r = btn.getBoundingClientRect();
      menuReturnFocus = btn;
      btn.setAttribute("aria-expanded", "true");
      placeMenu(menu, r.right + 8, Math.min(r.top, window.innerHeight - menu.scrollHeight - 8));
    });
  }

  /* ---------- tool bar keyboard navigation ---------- */

  function syncToolTabs() {
    qsa("#tools .tool").forEach(function (b) { b.tabIndex = b.classList.contains("sel") ? 0 : -1; });
  }
  function wireToolNav() {
    var bar = qs("#tools");
    bar.addEventListener("keydown", function (ev) {
      var tools = qsa(".tool", bar), i = tools.indexOf(document.activeElement);
      if (i < 0) return;
      var k = ev.key, n = -1;
      if (k === "ArrowDown" || k === "ArrowRight") n = (i + 1) % tools.length;
      else if (k === "ArrowUp" || k === "ArrowLeft") n = (i - 1 + tools.length) % tools.length;
      else if (k === "Home") n = 0;
      else if (k === "End") n = tools.length - 1;
      if (n < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      tools.forEach(function (t, j) { t.tabIndex = j === n ? 0 : -1; });
      tools[n].focus();
    });
    syncToolTabs();
  }

  /* ---------- hover outline ---------- */

  function wireHover() {
    var svg = app.canvas.svg;
    svg.addEventListener("pointermove", function (ev) {
      if (ev.pointerType !== "mouse" || ev.buttons || app.state.tool !== "select" || app.state.space || app.state.ctrl) {
        if (app.state.hoverId && ev.buttons) { app.state.hoverId = null; }
        return;
      }
      var p = docPoint(ev.clientX, ev.clientY);
      var hit = R.topHit(app.doc, p.x, p.y, 8 / app.view.zoom, app.doc.activeLayerId);
      var id = hit ? hit.path.id : null;
      if (id !== app.state.hoverId) {
        app.state.hoverId = id;
        app.requestRender();
      }
    });
    svg.addEventListener("pointerleave", function () {
      if (app.state.hoverId) { app.state.hoverId = null; app.requestRender(); }
    });
  }

  /* ---------- command palette ---------- */

  function commands() {
    var list = [];
    function add(group, label, run, kbd, words) { list.push({ group: group, label: label, run: run, kbd: kbd || "", words: words || "" }); }
    qsa("#tools .tool[data-tool]").forEach(function (b) {
      var t = b.getAttribute("data-tool"), k = b.getAttribute("aria-keyshortcuts");
      add("Tool", b.getAttribute("aria-label"), function () { app.setTool(t); }, k, "tool draw " + t);
    });
    Object.keys(IM.Tools.shapeNames).forEach(function (kind) {
      add("Tool", "Draw " + IM.Tools.shapeNames[kind], function () { app.setTool(kind); }, kind === "rect" ? "R" : kind === "ellipse" ? "E" : "", "object shape draw " + kind);
    });
    add("File", "New icon", app.newIcon, "", "clear start blank");
    add("File", "Open a saved icon…", app.openProject, "Ctrl+O", "load");
    add("File", "Save icon file", app.saveProject, "Ctrl+S", "keep project json");
    add("File", "Export SVG or PNG…", openExport, "Ctrl+E", "download save png svg image");
    add("Edit", "Undo", app.undo, "Ctrl+Z");
    add("Edit", "Redo", app.redo, "Ctrl+Shift+Z");
    add("Edit", "Copy", app.copySelection, "Ctrl+C");
    add("Edit", "Paste", app.pasteSelection, "Ctrl+V");
    add("Edit", "Duplicate", app.duplicateSelection, "Ctrl+D", "clone copy");
    add("Edit", "Delete selection", app.deleteSelection, "Del", "remove");
    add("Edit", "Select all", app.selectAll, "Ctrl+A");
    add("Shape", "Group", app.groupSelection, "Ctrl+G");
    add("Shape", "Ungroup", app.ungroupSelection, "Ctrl+Shift+G");
    ["union", "subtract", "intersect", "exclude"].forEach(function (k) {
      add("Shape", k.charAt(0).toUpperCase() + k.slice(1), function () { app.mergeSelection(k); }, "", "combine boolean merge");
    });
    add("Arrange", "Bring to front", function () { app.changeOrder(1, true); }, "Shift+]", "order");
    add("Arrange", "Bring forward", function () { app.changeOrder(1, false); }, "]", "order");
    add("Arrange", "Send backward", function () { app.changeOrder(-1, false); }, "[", "order");
    add("Arrange", "Send to back", function () { app.changeOrder(-1, true); }, "Shift+[", "order");
    Object.keys(ALIGN_LABELS).forEach(function (k) { add("Arrange", ALIGN_LABELS[k], function () { align(k); }); });
    add("Arrange", "Distribute horizontally", function () { distribute("h"); }, "", "space evenly");
    add("Arrange", "Distribute vertically", function () { distribute("v"); }, "", "space evenly");
    add("Arrange", "Flip left to right", function () { flip("h"); }, "", "mirror horizontal");
    add("Arrange", "Flip top to bottom", function () { flip("v"); }, "", "mirror vertical");
    add("Arrange", "Rotate 90° clockwise", function () { rotateBy(90); }, "", "turn");
    ["circle", "square", "star", "heart"].forEach(function (k) {
      add("Add", "Add a " + STARTER_NAMES[k], function () { addStarter(k); }, "", "starter template shape");
    });
    add("Layer", "Add a layer", app.addLayer);
    add("Layer", "Duplicate layer", app.duplicateLayer);
    add("Layer", "Delete layer", app.deleteLayer);
    SIZES.forEach(function (s, i) { add("Size", "Icon size " + s + " × " + s, function () { app.setSize(s); }, String(i + 1), "canvas artboard"); });
    add("View", "Zoom in", function () { app.stepZoom(1); }, "+");
    add("View", "Zoom out", function () { app.stepZoom(-1); }, "-");
    add("View", "Fit to screen", function () { app.fit(true); }, "0", "zoom reset");
    add("View", "Snapping on or off", app.toggleSnap, "S", "snap magnet");
    add("View", "Pixel grid on or off", app.toggleGrid, "`", "grid");
    add("View", "Pixel preview on or off", togglePixel, "X", "pixels real");
    BGS.forEach(function (b) { add("View", "Artboard background: " + BG_NAMES[b], function () { setBg(b); }, "", "background white dark checker"); });
    THEMES.forEach(function (t) { add("View", "Theme: " + THEME_NAMES[t], function () { setTheme(t); app.toast("Theme: " + THEME_NAMES[t]); }, "", "dark light mode appearance"); });
    ACCENTS.forEach(function (n) { add("View", "Accent colour: " + ACCENT_NAMES[n], function () { setAccent(n); app.toast("Accent colour: " + ACCENT_NAMES[n].toLowerCase()); }, "", "color theme appearance highlight"); });
    add("View", "Appearance…", function () { openAppearance(qs("#theme-btn").offsetParent ? qs("#theme-btn") : qs("#more-btn")); }, "", "theme accent colour dark light");
    add("Help", "Show the welcome window", openWelcome, "", "intro start hello");
    add("Panel", "Show layers", function () { app.showTab("layers"); setDrawer(true); });
    add("Panel", "Show style", function () { app.showTab("style"); setDrawer(true); });
    add("Panel", "Show history", function () { app.showTab("history"); setDrawer(true); }, "", "undo steps");
    add("Help", "Help and keyboard shortcuts", app.openHelp, "?");
    return list;
  }

  var palItems = [], palIndex = 0;
  function renderPalette() {
    var q = qs("#palette-input").value.trim().toLowerCase(), list = qs("#palette-list");
    var words = q ? q.split(/\s+/) : [];
    palItems = commands().filter(function (c) {
      var hay = (c.label + " " + c.group + " " + c.words).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
    palIndex = Math.min(palIndex, Math.max(0, palItems.length - 1));
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!palItems.length) {
      var e = mk("li", "empty", "No commands match “" + q + "”");
      e.setAttribute("role", "option");
      list.appendChild(e);
      qs("#palette-input").removeAttribute("aria-activedescendant");
      return;
    }
    palItems.forEach(function (c, i) {
      var li = mk("li");
      li.id = "pal-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === palIndex ? "true" : "false");
      li.appendChild(mk("span", null, c.label));
      li.appendChild(mk("span", "grp", c.group));
      if (c.kbd) li.appendChild(mk("kbd", null, c.kbd));
      li.addEventListener("pointermove", function () { if (palIndex !== i) { palIndex = i; markPal(); } });
      li.addEventListener("click", function () { runPal(i); });
      list.appendChild(li);
    });
    markPal();
  }
  function markPal() {
    qsa("#palette-list li").forEach(function (li, i) { li.setAttribute("aria-selected", i === palIndex ? "true" : "false"); });
    var cur = qs("#pal-" + palIndex);
    if (cur) { cur.scrollIntoView({ block: "nearest" }); qs("#palette-input").setAttribute("aria-activedescendant", cur.id); }
  }
  function runPal(i) {
    var c = palItems[i];
    if (!c) return;
    qs("#palette-dlg").close();
    setTimeout(c.run, 0);
  }
  function openPalette() {
    var d = qs("#palette-dlg");
    if (d.open) return;
    qs("#palette-input").value = "";
    palIndex = 0;
    renderPalette();
    d.showModal();
    qs("#palette-input").focus();
  }
  function wirePalette() {
    var d = qs("#palette-dlg"), input = qs("#palette-input");
    qs("#palette-btn").addEventListener("click", openPalette);
    input.addEventListener("input", function () { palIndex = 0; renderPalette(); });
    input.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
      if (ev.key === "ArrowDown") { ev.preventDefault(); palIndex = Math.min(palItems.length - 1, palIndex + 1); markPal(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); palIndex = Math.max(0, palIndex - 1); markPal(); }
      else if (ev.key === "Enter") { ev.preventDefault(); runPal(palIndex); }
      else if (ev.key === "Escape") { ev.preventDefault(); d.close(); }
    });
    d.addEventListener("click", function (ev) { if (ev.target === d) d.close(); });
  }

  /* ---------- keyboard: global shortcuts added by this module ---------- */

  app.keyHook = function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ev.key === "x" || ev.key === "X") { togglePixel(); return true; }
    if (ev.key === "B" && ev.shiftKey) { cycleBg(); return true; }
    return false;
  };

  function wireKeys() {
    // the drawing area shows its focus ring only for keyboard users
    document.addEventListener("keydown", function (ev) { if (ev.key === "Tab") document.body.classList.add("kbd-nav"); }, true);
    document.addEventListener("pointerdown", function () { document.body.classList.remove("kbd-nav"); }, true);
    document.addEventListener("keydown", function (ev) {
      var k = ev.key.toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && (k === "k" || k === "e")) {
        if (qs("dialog[open]")) return;
        ev.preventDefault();
        if (k === "k") openPalette();
        else openExport();
        return;
      }
      if (ev.key === "Escape" && qs("#panel").classList.contains("open") && !qs("dialog[open]") && !openMenuEl) {
        setDrawer(false);
        qs("#panel-toggle").focus();
      }
    });
  }

  /* ---------- version and release notes ---------- */

  function wireReleaseNotes() {
    var button = qs("#release-notes-btn"), dialog = qs("#release-notes-dlg");
    var current = IM.Releases[0];
    qs("#app-version").textContent = "v" + current.version;
    button.setAttribute("aria-label", "Version " + current.version + ". Open release notes");
    IM.Releases.forEach(function (release, i) {
      var section = mk("section", "release-entry");
      var heading = mk("h3", null, "v" + release.version);
      if (i === 0) heading.appendChild(mk("span", "release-current", "Latest"));
      var date = mk("time", null, new Intl.DateTimeFormat("en", {
        day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
      }).format(new Date(release.date + "T00:00:00Z")));
      date.dateTime = release.date;
      section.appendChild(heading);
      section.appendChild(date);
      section.appendChild(mk("p", "release-title", release.title));
      var list = mk("ul");
      release.changes.forEach(function (change) { list.appendChild(mk("li", null, change)); });
      section.appendChild(list);
      qs("#release-notes-list").appendChild(section);
    });
    button.addEventListener("click", function () { closeMenu(); dialog.showModal(); });
    qs("#release-notes-close").addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("click", function (ev) {
      var r = dialog.getBoundingClientRect();
      if (ev.target === dialog && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) dialog.close();
    });
  }

  /* ---------- small settings ---------- */

  function wireSettings() {
    var keys = qs("#help-keys"), showKeys = store("iconmaker.keys") !== "off";
    keys.checked = showKeys;
    document.body.classList.toggle("no-keys", !showKeys);
    keys.addEventListener("change", function () {
      document.body.classList.toggle("no-keys", !keys.checked);
      store("iconmaker.keys", keys.checked ? null : "off");
    });
    qs("#theme-btn").addEventListener("click", function () { openAppearance(qs("#theme-btn")); });
    qs("#bg-toggle").addEventListener("click", cycleBg);
    qs("#pixel-toggle").addEventListener("click", togglePixel);
    qsa("[data-starter]").forEach(function (b) {
      b.addEventListener("click", function () { addStarter(b.getAttribute("data-starter")); });
    });
    wireAppearance();
    var bg = store("iconmaker.bg");
    app.state.artboardBg = BGS.indexOf(bg) >= 0 ? bg : "checker";
  }

  /* ---------- boot ---------- */

  app.onBoot = function () {
    pixG = document.createElementNS(NS, "g");
    pixG.setAttribute("data-g", "pixel");
    pixG.setAttribute("pointer-events", "none");
    app.canvas.worldG.insertBefore(pixG, app.canvas.overlayG);
    setBg(app.state.artboardBg, true);
    wireEmptyState();
    wireContextMenu();
    wireHover();
    wireToolNav();
  };

  app.renderHooks.push(function () {
    updatePixel();
    updateEmptyState();
    updateSelectionUI();
  });
  app.panelHooks.push(function () {
    refreshColourFields();
    refreshHistory();
  });

  wireReleaseNotes();
  wireObjectMenu();
  wireSettings();
  wireMoreMenu();
  wireDrawer();
  wirePreviewCard();
  wireConfirm();
  wireExport();
  wireTransform();
  wireColours();
  wirePalette();
  wireKeys();
  wireWelcome();

  app.openExport = openExport;
  app.openPalette = openPalette;
  app.addStarter = addStarter;
  app.align = align;
  app.distribute = distribute;
  app.flip = flip;
})();
