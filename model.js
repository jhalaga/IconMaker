/* IconMaker — model.js
 * Document model, point helpers, the operation vocabulary (applyOp) and the
 * undo/redo History. Every edit is an operation that can be applied forward
 * and inverted, so undo never needs a snapshot of the whole document.
 * Attaches IM.Model. Loaded first; no DOM access.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var seq = 0;
  var SESSION = Math.random().toString(36).slice(2, 8);
  var MERGE_MS = 1200;
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // Unique, XML-id-safe string. The random session part keeps ids from a
  // reloaded project from colliding with ids created in this session.
  function uid() {
    seq += 1;
    return "n" + SESSION + seq.toString(36);
  }

  function clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
  }

  function isColor(c) {
    return typeof c === "string" && HEX_RE.test(c);
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.substr(1, 2), 16),
      parseInt(hex.substr(3, 2), 16),
      parseInt(hex.substr(5, 2), 16)
    ];
  }

  function lighten(hex, amount) {
    var rgb = hexToRgb(hex);
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var v = Math.round(rgb[i] + (255 - rgb[i]) * amount);
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return out;
  }

  function makeLayer(name) {
    return { id: uid(), name: name || "Layer", visible: true, locked: false, opacity: 1, paths: [] };
  }

  function newDoc(size) {
    var first = makeLayer("Layer 1");
    return { version: 1, size: size || 32, layers: [first], activeLayerId: first.id };
  }

  function makePath(closed) {
    return {
      id: uid(),
      closed: !!closed,
      points: [],
      fill: { kind: "none", color: "#5b8def", opacity: 1, gradient: null },
      stroke: { color: "#1d1d1f", width: 2, opacity: 1, cap: "round", join: "round" },
      dash: null
    };
  }

  function pt(x, y, cLx, cLy, cRx, cRy) {
    return { x: x, y: y, cLx: cLx || 0, cLy: cLy || 0, cRx: cRx || 0, cRy: cRy || 0 };
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  function layerIndex(doc, id) {
    return indexOfId(doc.layers, id);
  }

  function layer(doc, id) {
    var i = layerIndex(doc, id);
    return i < 0 ? null : doc.layers[i];
  }

  function pathIn(doc, layerId, id) {
    var L = layer(doc, layerId);
    if (!L) return null;
    var i = indexOfId(L.paths, id);
    return i < 0 ? null : L.paths[i];
  }

  function findPathLayer(doc, id) {
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      if (indexOfId(doc.layers[i].paths, id) >= 0) return doc.layers[i].id;
    }
    return null;
  }

  // Layer ids from top (front) to bottom (back).
  function topLayerOrder(doc) {
    var out = [];
    for (var i = doc.layers.length - 1; i >= 0; i--) out.push(doc.layers[i].id);
    return out;
  }

  /* ---------- geometry transforms (used by ops and by live tool previews) ---------- */

  // Every ring of a path: the primary `points` plus any holes or extra
  // regions added by a merge. Transforms touch all of them.
  function ringsOf(p) {
    return [p.points].concat(p.rings || []);
  }

  function eachPoint(p, fn) {
    var rs = ringsOf(p);
    for (var r = 0; r < rs.length; r++) {
      for (var i = 0; i < rs[r].length; i++) fn(rs[r][i]);
    }
  }

  function movePath(p, dx, dy) {
    eachPoint(p, function (q) { q.x += dx; q.y += dy; });
    var g = p.fill && p.fill.gradient;
    if (g) { g.x1 += dx; g.x2 += dx; g.y1 += dy; g.y2 += dy; }
  }

  // keepStroke: bbox resizes keep the line weight; canvas-size scaling does not.
  function scalePath(p, sx, sy, cx, cy, keepStroke) {
    eachPoint(p, function (q) {
      q.x = cx + (q.x - cx) * sx;
      q.y = cy + (q.y - cy) * sy;
      q.cLx *= sx; q.cLy *= sy;
      q.cRx *= sx; q.cRy *= sy;
    });
    var g = p.fill && p.fill.gradient;
    if (g) {
      g.x1 = cx + (g.x1 - cx) * sx; g.y1 = cy + (g.y1 - cy) * sy;
      g.x2 = cx + (g.x2 - cx) * sx; g.y2 = cy + (g.y2 - cy) * sy;
    }
    if (p.stroke && !keepStroke) p.stroke.width *= Math.sqrt(Math.abs(sx * sy));
  }

  function rotatePath(p, deg, cx, cy) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var vx, vy;
    eachPoint(p, function (q) {
      vx = q.x - cx; vy = q.y - cy;
      q.x = cx + vx * c - vy * s;
      q.y = cy + vx * s + vy * c;
      vx = q.cLx; vy = q.cLy;
      q.cLx = vx * c - vy * s; q.cLy = vx * s + vy * c;
      vx = q.cRx; vy = q.cRy;
      q.cRx = vx * c - vy * s; q.cRy = vx * s + vy * c;
    });
    var g = p.fill && p.fill.gradient;
    if (g) {
      vx = g.x1 - cx; vy = g.y1 - cy;
      g.x1 = cx + vx * c - vy * s; g.y1 = cy + vx * s + vy * c;
      vx = g.x2 - cx; vy = g.y2 - cy;
      g.x2 = cx + vx * c - vy * s; g.y2 = cy + vx * s + vy * c;
    }
  }

  // Calls fn(path) for every path named in op.ids inside op.layerId.
  function forTargets(doc, op, fn) {
    var L = layer(doc, op.layerId);
    if (!L || !op.ids) return;
    for (var i = 0; i < L.paths.length; i++) {
      if (op.ids.indexOf(L.paths[i].id) >= 0) fn(L.paths[i]);
    }
  }

  // Copy of a whole document resized to `size` (drawing scales with it).
  function scaledCopy(doc, size) {
    var copy = clone(doc);
    var f = size / doc.size;
    for (var li = 0; li < copy.layers.length; li++) {
      var paths = copy.layers[li].paths;
      for (var pi = 0; pi < paths.length; pi++) scalePath(paths[pi], f, f, 0, 0);
    }
    copy.size = size;
    return copy;
  }

  /* ---------- operations ----------
   * applyOp(doc, op, forward) performs `op` (forward=true) or undoes it
   * (forward=false). See SPEC.md for the vocabulary.
   */
  function applyOp(doc, op, forward) {
    var L, p, n, i, v, f, a, b;
    switch (op.type) {
      case "add": {
        L = layer(doc, op.layerId);
        if (!L) return;
        if (forward) {
          L.paths.splice(op.index == null ? L.paths.length : op.index, 0, clone(op.path));
        } else {
          i = indexOfId(L.paths, op.path.id);
          if (i >= 0) L.paths.splice(i, 1);
        }
        break;
      }
      case "delete": {
        L = layer(doc, op.layerId);
        if (!L) return;
        if (forward) L.paths.splice(op.index, 1);
        else L.paths.splice(op.index, 0, clone(op.path));
        break;
      }
      case "move": {
        f = forward ? 1 : -1;
        forTargets(doc, op, function (q) { movePath(q, f * op.dx, f * op.dy); });
        break;
      }
      case "scale": {
        a = forward ? op.sx : 1 / op.sx;
        b = forward ? op.sy : 1 / op.sy;
        forTargets(doc, op, function (q) { scalePath(q, a, b, op.cx, op.cy, !!op.keepStroke); });
        break;
      }
      case "rotate": {
        f = forward ? op.angle : -op.angle;
        forTargets(doc, op, function (q) { rotatePath(q, f, op.cx, op.cy); });
        break;
      }
      case "style": {
        p = pathIn(doc, op.layerId, op.id);
        if (p) p[op.field] = clone(forward ? op.to : op.from);
        break;
      }
      case "geom": {
        // whole-geometry replacement: closed flag + all points
        p = pathIn(doc, op.layerId, op.id);
        if (p) {
          v = forward ? op.to : op.from;
          p.closed = !!v.closed;
          p.points = clone(v.points);
        }
        break;
      }
      case "node-move": {
        p = pathIn(doc, op.layerId, op.id);
        n = p && p.points[op.index];
        if (!n) return;
        v = forward ? op.to : op.from;
        n.x = v.x; n.y = v.y;
        n.cLx = v.cLx; n.cLy = v.cLy; n.cRx = v.cRx; n.cRy = v.cRy;
        break;
      }
      case "node-handle": {
        p = pathIn(doc, op.layerId, op.id);
        n = p && p.points[op.index];
        if (!n) return;
        v = forward ? op.to : op.from;
        if (op.side !== "R") { n.cLx = v.cLx; n.cLy = v.cLy; }
        if (op.side !== "L") { n.cRx = v.cRx; n.cRy = v.cRy; }
        break;
      }
      case "zorder": {
        L = layer(doc, op.layerId);
        if (!L) return;
        a = forward ? op.from : op.to;
        b = forward ? op.to : op.from;
        v = L.paths.splice(a, 1)[0];
        if (v) L.paths.splice(b, 0, v);
        break;
      }
      case "layer-add": {
        if (forward) doc.layers.splice(op.index, 0, clone(op.layer));
        else {
          i = layerIndex(doc, op.layer.id);
          if (i >= 0) doc.layers.splice(i, 1);
        }
        break;
      }
      case "layer-delete": {
        if (forward) doc.layers.splice(op.index, 1);
        else doc.layers.splice(op.index, 0, clone(op.layer));
        break;
      }
      case "layer-move": {
        a = forward ? op.from : op.to;
        b = forward ? op.to : op.from;
        v = doc.layers.splice(a, 1)[0];
        doc.layers.splice(b, 0, v);
        break;
      }
      case "layer-style": {
        L = layer(doc, op.layerId);
        if (L) L[op.field] = clone(forward ? op.to : op.from);
        break;
      }
      case "size": {
        f = forward ? op.to / op.from : op.from / op.to;
        for (i = 0; i < doc.layers.length; i++) {
          for (var k = 0; k < doc.layers[i].paths.length; k++) {
            scalePath(doc.layers[i].paths[k], f, f, 0, 0);
          }
        }
        doc.size = forward ? op.to : op.from;
        break;
      }
      case "set-active-layer": {
        doc.activeLayerId = forward ? op.to : op.from;
        break;
      }
      case "path-layer": {
        var src = layer(doc, op.fromLayerId), dst = layer(doc, op.toLayerId);
        if (!src || !dst) return;
        if (forward) {
          i = indexOfId(src.paths, op.id);
          if (i < 0) return;
          var moved = src.paths.splice(i, 1)[0];
          dst.paths.splice(op.index == null ? dst.paths.length : op.index, 0, moved);
        } else {
          i = indexOfId(dst.paths, op.id);
          if (i < 0) return;
          var back = dst.paths.splice(i, 1)[0];
          src.paths.splice(op.fromIndex, 0, back);
        }
        break;
      }
      case "group": {
        // Sets or clears `groupId` on each listed path. from/to: id string or null.
        for (i = 0; i < op.changes.length; i++) {
          var ch = op.changes[i];
          p = pathIn(doc, ch.layerId, ch.id);
          if (!p) continue;
          v = forward ? ch.to : ch.from;
          if (v) p.groupId = v;
          else delete p.groupId;
        }
        break;
      }
      case "replace": {
        // Swaps a set of paths in one layer for another (used by boolean merges).
        // before/after: [{index, path}] with ascending indices.
        L = layer(doc, op.layerId);
        if (!L) return;
        var out = forward ? op.before : op.after;
        var inn = forward ? op.after : op.before;
        for (i = 0; i < out.length; i++) {
          var oi = indexOfId(L.paths, out[i].path.id);
          if (oi >= 0) L.paths.splice(oi, 1);
        }
        for (i = 0; i < inn.length; i++) {
          L.paths.splice(inn[i].index, 0, clone(inn[i].path));
        }
        break;
      }
      case "batch": {
        if (forward) {
          for (i = 0; i < op.ops.length; i++) applyOp(doc, op.ops[i], true);
        } else {
          for (i = op.ops.length - 1; i >= 0; i--) applyOp(doc, op.ops[i], false);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------- history ---------- */

  // Merge `op` into `top` when both describe one continuous gesture
  // (a repeated nudge, a slider that keeps changing). Returns true if merged.
  function mergeable(top, op) {
    if (top.type !== op.type) return false;
    if (top.type === "style" || top.type === "layer-style") {
      if (top.layerId !== op.layerId || top.id !== op.id || top.field !== op.field) return false;
      top.to = op.to;
      return true;
    }
    if (top.type === "move") {
      if (top.layerId !== op.layerId || top.ids.join() !== op.ids.join()) return false;
      top.dx += op.dx;
      top.dy += op.dy;
      return true;
    }
    if (top.type === "node-move") {
      if (top.layerId !== op.layerId || top.id !== op.id || top.index !== op.index) return false;
      top.to = op.to;
      return true;
    }
    return false;
  }

  function History(doc) {
    this.doc = doc;
    this.stack = [];
    this.ptr = -1;
    this.key = null;
    this.keyTime = 0;
  }

  // The caller has already applied `op`. `key` groups repeated small changes.
  History.prototype.push = function (op, key) {
    var now = Date.now();
    var top = this.ptr >= 0 ? this.stack[this.ptr] : null;
    if (key && key === this.key && top && now - this.keyTime < MERGE_MS && mergeable(top, op)) {
      this.keyTime = now;
      return;
    }
    this.stack.length = this.ptr + 1;
    this.stack.push(op);
    this.ptr = this.stack.length - 1;
    this.key = key || null;
    this.keyTime = now;
  };
  History.prototype.canUndo = function () { return this.ptr >= 0; };
  History.prototype.canRedo = function () { return this.ptr < this.stack.length - 1; };
  History.prototype.undo = function () {
    if (!this.canUndo()) return null;
    var op = this.stack[this.ptr];
    applyOp(this.doc, op, false);
    this.ptr -= 1;
    this.key = null;
    return op;
  };
  History.prototype.redo = function () {
    if (!this.canRedo()) return null;
    this.ptr += 1;
    var op = this.stack[this.ptr];
    applyOp(this.doc, op, true);
    this.key = null;
    return op;
  };

  IM.Model = {
    uid: uid,
    clone: clone,
    isColor: isColor,
    hexToRgb: hexToRgb,
    lighten: lighten,
    makeLayer: makeLayer,
    newDoc: newDoc,
    makePath: makePath,
    pt: pt,
    layer: layer,
    layerIndex: layerIndex,
    indexOfId: indexOfId,
    pathIn: pathIn,
    findPathLayer: findPathLayer,
    topLayerOrder: topLayerOrder,
    movePath: movePath,
    scalePath: scalePath,
    rotatePath: rotatePath,
    scaledCopy: scaledCopy,
    applyOp: applyOp,
    History: History
  };
})();
