/* IconMaker — snapping.js
 * Snaps points and moved selections to anchors, alignment lines (other shapes'
 * edges and centres, the artboard centre) and whole pixel positions.
 * Priority: anchor (both axes) > alignment per axis > pixel grid per axis.
 * Attaches IM.Snap.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var docRef = null;
  var guides = [];

  function setDocument(doc) { docRef = doc; }

  function clearGuides() { guides = []; }

  // Anchor points of visible, unlocked layers, skipping excluded path ids.
  function collectAnchors(doc, exclude) {
    var out = [];
    for (var li = 0; li < doc.layers.length; li++) {
      var L = doc.layers[li];
      if (!L.visible || L.locked) continue;
      for (var pi = 0; pi < L.paths.length; pi++) {
        var p = L.paths[pi];
        if (exclude && exclude.indexOf(p.id) >= 0) continue;
        for (var j = 0; j < p.points.length; j++) out.push({ x: p.points[j].x, y: p.points[j].y });
        for (var r = 0; p.rings && r < p.rings.length; r++) {
          for (var k = 0; k < p.rings[r].length; k++) out.push({ x: p.rings[r][k].x, y: p.rings[r][k].y });
        }
      }
    }
    return out;
  }

  // Bounds of other visible, unlocked paths (geometry only, no stroke).
  function collectBoxes(doc, exclude) {
    var out = [];
    for (var li = 0; li < doc.layers.length; li++) {
      var L = doc.layers[li];
      if (!L.visible || L.locked) continue;
      for (var pi = 0; pi < L.paths.length; pi++) {
        var p = L.paths[pi];
        if (exclude && exclude.indexOf(p.id) >= 0) continue;
        var b = IM.Renderer.bbox(p, false);
        if (b) out.push(b);
      }
    }
    return out;
  }

  // Closest target to any probe, within r. Returns {delta, pos} or null.
  function bestAlign(probes, targets, r) {
    var best = null;
    for (var i = 0; i < probes.length; i++) {
      for (var j = 0; j < targets.length; j++) {
        var d = targets[j] - probes[i];
        if (Math.abs(d) < r && (!best || Math.abs(d) < Math.abs(best.delta))) {
          best = { delta: d, pos: targets[j] };
        }
      }
    }
    return best;
  }

  // ctx: { doc, zoom, grid, anchors, exclude }. Returns {x, y, snap}.
  function snapPoint(px, py, ctx) {
    var doc = ctx.doc || docRef;
    var zoom = ctx.zoom > 0 ? ctx.zoom : 1;
    var rAnchor = 12 / zoom, rLine = 8 / zoom;
    clearGuides();
    var anchors = ctx.anchors ? collectAnchors(doc, ctx.exclude) : [];

    // 1. an anchor under the pointer wins outright
    var best = null, bd = rAnchor;
    for (var i = 0; i < anchors.length; i++) {
      var d = Math.sqrt((px - anchors[i].x) * (px - anchors[i].x) + (py - anchors[i].y) * (py - anchors[i].y));
      if (d < bd) { bd = d; best = anchors[i]; }
    }
    if (best) {
      guides.push({ axis: "v", pos: best.x }, { axis: "h", pos: best.y });
      return { x: best.x, y: best.y, snap: { type: "anchor" } };
    }

    // 2. alignment per axis: anchors and the artboard centre lines
    var xs = [], ys = [], half = doc.size / 2, k;
    for (k = 0; k < anchors.length; k++) { xs.push(anchors[k].x); ys.push(anchors[k].y); }
    xs.push(half); ys.push(half);
    var ax = bestAlign([px], xs, rLine), ay = bestAlign([py], ys, rLine);
    var x = px, y = py, type = null;
    if (ax) { x = ax.pos; guides.push({ axis: "v", pos: ax.pos }); type = "align"; }
    else if (ctx.grid) { x = Math.round(px); type = "grid"; }
    if (ay) { y = ay.pos; guides.push({ axis: "h", pos: ay.pos }); type = "align"; }
    else if (ctx.grid) { y = Math.round(py); if (!type) type = "grid"; }
    return { x: x, y: y, snap: type ? { type: type } : null };
  }

  // Moves a selection whose base bounds are ctx.bbox by (dx,dy).
  // ctx: { doc, zoom, grid, exclude, bbox }. Returns {dx, dy}.
  function snapSegmentMove(dx, dy, ctx) {
    var doc = ctx.doc || docRef;
    var zoom = ctx.zoom > 0 ? ctx.zoom : 1;
    var r = 8 / zoom;
    clearGuides();
    var b = ctx.bbox;
    if (!b) return { dx: dx, dy: dy };

    var x0 = b.x + dx, y0 = b.y + dy;
    var probesX = [x0, x0 + b.w / 2, x0 + b.w];
    var probesY = [y0, y0 + b.h / 2, y0 + b.h];
    var tx = [0, doc.size / 2, doc.size], ty = [0, doc.size / 2, doc.size];
    var anchors = collectAnchors(doc, ctx.exclude), boxes = collectBoxes(doc, ctx.exclude), i;
    for (i = 0; i < anchors.length; i++) { tx.push(anchors[i].x); ty.push(anchors[i].y); }
    for (i = 0; i < boxes.length; i++) {
      var bx = boxes[i];
      tx.push(bx.x, bx.x + bx.w / 2, bx.x + bx.w);
      ty.push(bx.y, bx.y + bx.h / 2, bx.y + bx.h);
    }

    var ndx = dx, ndy = dy;
    var sx = bestAlign(probesX, tx, r), sy = bestAlign(probesY, ty, r);
    if (sx) { ndx += sx.delta; guides.push({ axis: "v", pos: sx.pos }); }
    else if (ctx.grid) ndx += Math.round(x0) - x0;
    if (sy) { ndy += sy.delta; guides.push({ axis: "h", pos: sy.pos }); }
    else if (ctx.grid) ndy += Math.round(y0) - y0;
    return { dx: ndx, dy: ndy };
  }

  function snapValue(v, step) {
    return Math.round(v / step) * step;
  }

  IM.Snap = {
    setDocument: setDocument,
    snapPoint: snapPoint,
    snapSegmentMove: snapSegmentMove,
    snapValue: snapValue,
    clear: clearGuides
  };
  Object.defineProperty(IM.Snap, "guides", {
    enumerable: true,
    get: function () { return guides; }
  });
})();
