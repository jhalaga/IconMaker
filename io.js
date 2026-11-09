/* IconMaker — io.js
 * Project files (.iconmaker.json), autosave to localStorage, and validation of
 * anything loaded from disk or storage. Attaches IM.io.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var KEY = "iconmaker.doc";
  var MAX_FILE_BYTES = 8 * 1024 * 1024;
  var MAX_POINTS = 20000;
  var MAX_RINGS = 64;
  var timer = null;

  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function num(v, lo, hi, def) {
    if (typeof v !== "number" || !isFinite(v)) return def;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function color(v, def) {
    return IM.Model.isColor(v) ? v.toLowerCase() : def;
  }

  function pick(v, allowed, def) {
    return allowed.indexOf(v) >= 0 ? v : def;
  }

  function sanitizeGradient(g) {
    if (!g || typeof g !== "object" || !Array.isArray(g.stops) || g.stops.length < 2) return null;
    var stops = [];
    for (var i = 0; i < g.stops.length && i < 16; i++) {
      var s = g.stops[i] || {};
      stops.push({
        offset: num(s.offset, 0, 1, i / (g.stops.length - 1)),
        color: color(s.color, "#000000"),
        opacity: num(s.opacity, 0, 1, 1)
      });
    }
    stops.sort(function (a, b) { return a.offset - b.offset; });
    return {
      x1: num(g.x1, -1e6, 1e6, 0), y1: num(g.y1, -1e6, 1e6, 0),
      x2: num(g.x2, -1e6, 1e6, 32), y2: num(g.y2, -1e6, 1e6, 32),
      stops: stops
    };
  }

  // Returns a clean point list, or null when any point is unusable.
  function sanitizePoints(arr, budget) {
    if (!Array.isArray(arr) || arr.length > budget) return null;
    var points = [];
    for (var j = 0; j < arr.length; j++) {
      var q = arr[j];
      if (!q || typeof q.x !== "number" || typeof q.y !== "number" || !isFinite(q.x) || !isFinite(q.y)) return null;
      points.push({
        x: q.x, y: q.y,
        cLx: num(q.cLx, -1e6, 1e6, 0), cLy: num(q.cLy, -1e6, 1e6, 0),
        cRx: num(q.cRx, -1e6, 1e6, 0), cRy: num(q.cRy, -1e6, 1e6, 0)
      });
    }
    return points;
  }

  // Returns a clean path, or null when the object is not usable.
  function sanitizePath(p, makeId, used) {
    if (!p || typeof p !== "object" || !Array.isArray(p.points)) return null;
    if (p.points.length > MAX_POINTS) return null;
    var points = sanitizePoints(p.points, MAX_POINTS);
    if (!points) return null;
    var rings = [], total = points.length;
    if (Array.isArray(p.rings)) {
      if (p.rings.length > MAX_RINGS) return null;
      for (var r = 0; r < p.rings.length; r++) {
        var ring = sanitizePoints(p.rings[r], MAX_POINTS - total);
        if (!ring) return null;
        total += ring.length;
        if (ring.length > 0) rings.push(ring);
      }
    }
    var f = p.fill || {}, st = p.stroke || {};
    var fill = {
      kind: pick(f.kind, ["none", "color", "gradient"], "none"),
      color: color(f.color, "#5b8def"),
      opacity: num(f.opacity, 0, 1, 1),
      gradient: sanitizeGradient(f.gradient)
    };
    if (fill.kind === "gradient" && !fill.gradient) fill.kind = "color";
    var stroke = {
      color: color(st.color, "#1d1d1f"),
      width: num(st.width, 0, 200, 1),
      opacity: num(st.opacity, 0, 1, 1),
      cap: pick(st.cap, ["butt", "round", "square"], "round"),
      join: pick(st.join, ["miter", "round", "bevel"], "round")
    };
    var dash = p.dash && typeof p.dash === "object"
      ? { pattern: pick(p.dash.pattern, ["dash", "dot", "dashdot"], null) } : null;
    if (dash && !dash.pattern) dash = null;
    var id = typeof p.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.id) && !used[p.id] ? p.id : makeId();
    used[id] = true;
    var out = { id: id, closed: !!p.closed, points: points, fill: fill, stroke: stroke, dash: dash };
    if (rings.length) out.rings = rings;
    if (typeof p.groupId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.groupId)) out.groupId = p.groupId;
    return out;
  }

  // Validates a parsed project. Returns a clean document or null.
  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.layers)) return null;
    if (raw.layers.length === 0 || raw.layers.length > 200) return null;
    var used = {};
    var makeId = function () { return IM.Model.uid(); };
    var doc = { version: 1, size: num(raw.size, 1, 512, 32), layers: [], activeLayerId: null };
    for (var li = 0; li < raw.layers.length; li++) {
      var L = raw.layers[li];
      if (!L || typeof L !== "object" || !Array.isArray(L.paths)) return null;
      var layer = {
        id: typeof L.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(L.id) && !used[L.id] ? L.id : makeId(),
        name: typeof L.name === "string" && L.name.trim() ? L.name.trim().slice(0, 60) : "Layer " + (li + 1),
        visible: L.visible !== false,
        locked: !!L.locked,
        opacity: num(L.opacity, 0, 1, 1),
        paths: []
      };
      used[layer.id] = true;
      for (var pi = 0; pi < L.paths.length; pi++) {
        var clean = sanitizePath(L.paths[pi], makeId, used);
        if (!clean) return null;
        layer.paths.push(clean);
      }
      doc.layers.push(layer);
    }
    var wanted = raw.activeLayerId;
    doc.activeLayerId = doc.layers[0].id;
    for (var k = 0; k < doc.layers.length; k++) {
      if (doc.layers[k].id === wanted) doc.activeLayerId = wanted;
    }
    return doc;
  }

  function save(doc) {
    download(JSON.stringify(doc, null, 2), "icon-" + doc.size + ".iconmaker.json", "application/json");
  }

  // cb(doc) with a clean document, or cb(null) when the file is not a project.
  function loadFile(file, cb) {
    if (!file || file.size > MAX_FILE_BYTES) {
      cb(null);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var doc = null;
      try {
        doc = sanitize(JSON.parse(reader.result));
      } catch (e) {
        doc = null;
      }
      cb(doc);
    };
    reader.onerror = function () { cb(null); };
    reader.readAsText(file);
  }

  function autosave(doc) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(doc));
      } catch (e) {
        // storage full or disabled: the drawing still works, it just is not kept
      }
    }, 400);
  }

  function restore() {
    try {
      var text = localStorage.getItem(KEY);
      return text ? sanitize(JSON.parse(text)) : null;
    } catch (e) {
      return null;
    }
  }

  function forget() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  IM.io = {
    KEY: KEY,
    download: download,
    save: save,
    loadFile: loadFile,
    autosave: autosave,
    restore: restore,
    forget: forget,
    sanitize: sanitize
  };
})();
