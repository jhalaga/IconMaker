/* IconMaker — tools.js
 * The drawing and editing tools (IM.Tools). A tool is:
 *   { id, cursor, hint(app), activate(app), deactivate(app),
 *     onDown(app,e), onMove(app,e), onUp(app,e), onDblClick(app,e), onKey(app,e) }
 * Pointer events are in document units (e.x, e.y). onKey returns true when the
 * tool consumed the key. Tools change the document only through app.pushHistory
 * (or app.beginTx / app.endTx to group several changes into one undo step).
 * Drags show a live preview and record the final result once, on release.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var M = IM.Model, R = IM.Renderer;
  var MIN_SHAPE = 1;          // smallest rectangle or oval that is kept
  var MIN_DIST = 0.5;         // smallest line that is kept

  /* ---------- shared helpers ---------- */

  function dist(ax, ay, bx, by) {
    return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
  }

  function tolOf(app) { return 8 / app.view.zoom; }

  // Snap a point to anchors, guides and whole pixels (when snapping is on).
  function snapPt(app, x, y, exclude) {
    if (!app.state.snap) {
      IM.Snap.clear();
      return { x: x, y: y };
    }
    return IM.Snap.snapPoint(x, y, { doc: app.doc, zoom: app.view.zoom, grid: true, anchors: true, exclude: exclude || [] });
  }

  // The active layer, or null (with a message) when it is hidden or locked.
  function activeUnlocked(app) {
    var L = app.activeLayer();
    if (!L) return null;
    if (!L.visible) {
      app.toast("This layer is hidden. Click its eye to show it.");
      return null;
    }
    if (L.locked) {
      app.toast("This layer is locked. Click its lock to unlock it.");
      return null;
    }
    return L;
  }

  // Visible shape under the pointer, in paint order (see R.topHit).
  function hitAt(app, x, y) {
    return R.topHit(app.doc, x, y, tolOf(app), app.doc.activeLayerId);
  }

  // Shape under the pointer for the fill and outline tools (outline or inside).
  function pickAt(app, x, y) {
    return R.pickShape(app.doc, x, y, tolOf(app), app.doc.activeLayerId);
  }

  // Null when a Fill pick finds no fill, so an outline colour is never copied as a fill.
  function pickColor(p, target) {
    if (target === "fill") {
      if (p.fill.kind === "color") return p.fill.color;
      if (p.fill.kind === "gradient" && p.fill.gradient) return p.fill.gradient.stops[0].color;
      return null;
    }
    return p.stroke.color;
  }

  // Gradient across a path's bounds, from its top-left to its bottom-right.
  function gradientFor(path, stops) {
    var b = R.bbox(path, false) || { x: 0, y: 0, w: 32, h: 32 };
    return {
      x1: b.x, y1: b.y, x2: b.x + Math.max(b.w, 1), y2: b.y + Math.max(b.h, 1),
      stops: M.clone(stops)
    };
  }

  // Drawing always starts with the default style, independent of the last edit.
  function newDrawingPath(app, points, closed, isShape) {
    var path = M.makePath(closed);
    path.points = points;
    path.fill = { kind: closed ? "color" : "none", color: "#000000", opacity: 1, gradient: null };
    path.stroke = { color: "#000000", width: isShape ? 0 : 2, opacity: 1, cap: "round", join: "round" };
    path.dash = null;
    return path;
  }

  function addPath(app, path) {
    var L = activeUnlocked(app);
    if (!L) return false;
    app.pushHistory("Add shape", { type: "add", layerId: L.id, path: path });
    app.select([path.id], path.id);
    return true;
  }

  function snapshotPaths(L, ids) {
    var out = [];
    for (var i = 0; i < L.paths.length; i++) {
      var p = L.paths[i];
      if (ids.indexOf(p.id) >= 0) {
        // rings = holes / extra regions left by a merge; they must be restored
        // every frame too, or a moved shape drags its holes further each time
        out.push({ id: p.id, closed: p.closed, points: M.clone(p.points), rings: M.clone(p.rings), fill: M.clone(p.fill), stroke: M.clone(p.stroke), dash: M.clone(p.dash) });
      }
    }
    return out;
  }

  function restoreSnapshot(L, snap) {
    for (var i = 0; i < snap.length; i++) {
      var s = snap[i];
      var k = M.indexOfId(L.paths, s.id);
      if (k < 0) continue;
      var p = L.paths[k];
      p.closed = s.closed;
      p.points = M.clone(s.points);
      if (s.rings) p.rings = M.clone(s.rings);
      else delete p.rings;
      p.fill = M.clone(s.fill);
      p.stroke = M.clone(s.stroke);
      p.dash = M.clone(s.dash);
    }
  }

  function handlesOf(pt) {
    return { cLx: pt.cLx, cLy: pt.cLy, cRx: pt.cRx, cRy: pt.cRy };
  }

  function pointOf(pt) {
    return { x: pt.x, y: pt.y, cLx: pt.cLx, cLy: pt.cLy, cRx: pt.cRx, cRy: pt.cRy };
  }

  // Keeps a scale factor away from zero (a flip through the anchor is allowed).
  function safeRatio(num, den) {
    if (Math.abs(den) < 1e-6) return 1;
    var r = num / den;
    var sign = r < 0 ? -1 : 1;
    return sign * Math.max(Math.abs(r), 0.02);
  }

  /* ---------- select ---------- */

  var drag = null;      // transform or move gesture in progress
  var marquee = null;   // rubber-band selection in progress

  function startDrag(app, mode, e, extra) {
    var L = app.activeLayer();
    var ids = app.state.selPathIds.slice();
    drag = {
      mode: mode, layerId: L.id, ids: ids, x0: e.x, y0: e.y,
      snap: snapshotPaths(L, ids),
      base: R.selectionBounds(L, ids, false)
    };
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) drag[k] = extra[k];
    }
    return drag;
  }

  // Shows an operation on top of the gesture's starting state.
  function previewDrag(app, op) {
    var L = M.layer(app.doc, drag.layerId);
    if (!L) return;
    restoreSnapshot(L, drag.snap);
    M.applyOp(app.doc, op, true);
    app.requestRender();
  }

  function cancelDrag(app) {
    if (!drag) return;
    var L = M.layer(app.doc, drag.layerId);
    if (L) restoreSnapshot(L, drag.snap);
    if (drag.copied) app.endTx();
    drag = null;
    app.renderAll();
  }

  // Duplicates the selected paths in place (used by Alt-drag). Returns the new ids.
  function duplicateInPlace(app, ids) {
    var L = app.activeLayer(), newIds = [], paths = [];
    for (var i = 0; i < L.paths.length; i++) {
      if (ids.indexOf(L.paths[i].id) >= 0) paths.push(L.paths[i]);
    }
    var copies = M.copyPaths(paths);
    for (var j = 0; j < copies.length; j++) {
      var copy = copies[j];
      app.pushHistory("Duplicate", { type: "add", layerId: L.id, path: copy });
      newIds.push(copy.id);
    }
    return newIds;
  }

  var select = {
    id: "select",
    cursor: "default",
    hint: function (app) {
      if (app.state.selPathIds.length) {
        return "Drag to move. Drag a corner to resize, the top circle to rotate. Arrow keys nudge. Del deletes.";
      }
      return "Click a shape on the active layer to select it. Drag to fully enclose shapes or groups. Shift adds to the selection.";
    },
    activate: function () { drag = null; marquee = null; },
    deactivate: function (app) {
      cancelDrag(app);
      marquee = null;
      app.state.marquee = null;
    },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      IM.Snap.clear();
      var hn = IM.Overlay.hitNode(app, e.x, e.y);
      if (hn) {
        var L = activeUnlocked(app);
        if (!L) return;
        var box = IM.Overlay.selectionBox(app);
        if (!box) return;
        var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        var corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
        if (hn.kind === "bbox-rotate") {
          startDrag(app, "rotate", e, {
            cx: cx, cy: cy, angle: 0,
            a0: Math.atan2(e.y - cy, e.x - cx)
          });
          return;
        }
        var extra = { fx: cx, fy: cy, hx0: cx, hy0: cy, axis: "xy", corner: false, sx: 1, sy: 1 };
        if (hn.kind === "bbox-corner") {
          var opp = [2, 3, 0, 1][hn.corner];
          extra.fx = corners[opp][0]; extra.fy = corners[opp][1];
          extra.hx0 = corners[hn.corner][0]; extra.hy0 = corners[hn.corner][1];
          extra.corner = true;
        } else if (hn.edge === "n") {
          extra.fx = cx; extra.fy = box.y + box.h; extra.hx0 = cx; extra.hy0 = box.y; extra.axis = "y";
        } else if (hn.edge === "s") {
          extra.fx = cx; extra.fy = box.y; extra.hx0 = cx; extra.hy0 = box.y + box.h; extra.axis = "y";
        } else if (hn.edge === "e") {
          extra.fx = box.x; extra.fy = cy; extra.hx0 = box.x + box.w; extra.hy0 = cy; extra.axis = "x";
        } else if (hn.edge === "w") {
          extra.fx = box.x + box.w; extra.fy = cy; extra.hx0 = box.x; extra.hy0 = cy; extra.axis = "x";
        }
        startDrag(app, "scale", e, extra);
        return;
      }

      var hit = hitAt(app, e.x, e.y);
      if (hit) {
        var id = hit.path.id;
        var ids = app.state.selPathIds.slice();
        if (e.shiftKey) {
          var at = ids.indexOf(id);
          if (at >= 0) {
            var toRemove = app.expandGroups([id]);
            ids = ids.filter(function (x) { return toRemove.indexOf(x) < 0; });
          } else {
            ids = app.expandGroups(ids.concat([id]));
          }
          app.select(ids, id);
          app.renderAll();
          return;
        }
        if (ids.indexOf(id) < 0) ids = app.expandGroups([id]);
        app.select(ids, id);
        if (e.altKey) {
          app.beginTx("Duplicate and move");
          drag = null;
          var copies = duplicateInPlace(app, ids);
          app.select(copies, copies[copies.length - 1]);
          startDrag(app, "move", e, {});
          drag.copied = true;
        } else {
          startDrag(app, "move", e, {});
        }
        drag.dx = 0; drag.dy = 0;
        app.renderAll();
        return;
      }

      marquee = { x0: e.x, y0: e.y, x1: e.x, y1: e.y, add: e.shiftKey, base: e.shiftKey ? app.state.selPathIds.slice() : [] };
      if (!e.shiftKey) app.select([], null);
      app.renderAll();
    },
    onMove: function (app, e) {
      if (drag) {
        if (drag.mode === "move") {
          var dx = e.x - drag.x0, dy = e.y - drag.y0;
          var res = { dx: dx, dy: dy };
          if (app.state.snap) {
            res = IM.Snap.snapSegmentMove(dx, dy, { doc: app.doc, zoom: app.view.zoom, grid: true, exclude: drag.ids, bbox: drag.base });
          } else {
            IM.Snap.clear();
          }
          drag.dx = res.dx; drag.dy = res.dy;
          previewDrag(app, { type: "move", layerId: drag.layerId, ids: drag.ids, dx: res.dx, dy: res.dy });
        } else if (drag.mode === "scale") {
          var p = app.state.snap ? snapPt(app, e.x, e.y, drag.ids) : { x: e.x, y: e.y };
          var sx = 1, sy = 1;
          if (drag.axis !== "y") sx = safeRatio(p.x - drag.fx, drag.hx0 - drag.fx);
          if (drag.axis !== "x") sy = safeRatio(p.y - drag.fy, drag.hy0 - drag.fy);
          if (drag.corner && e.shiftKey) {
            var u = Math.abs(sx) > Math.abs(sy) ? sx : sy;
            sx = u; sy = u;
          }
          drag.sx = sx; drag.sy = sy;
          previewDrag(app, { type: "scale", layerId: drag.layerId, ids: drag.ids, sx: sx, sy: sy, cx: drag.fx, cy: drag.fy, keepStroke: true });
        } else if (drag.mode === "rotate") {
          var deg = (Math.atan2(e.y - drag.cy, e.x - drag.cx) - drag.a0) * 180 / Math.PI;
          if (e.shiftKey) deg = Math.round(deg / 15) * 15;
          drag.angle = deg;
          previewDrag(app, { type: "rotate", layerId: drag.layerId, ids: drag.ids, angle: deg, cx: drag.cx, cy: drag.cy });
        }
        return;
      }
      if (marquee) {
        marquee.x1 = e.x; marquee.y1 = e.y;
        app.state.marquee = marquee;
        app.requestRender();
      }
    },
    onUp: function (app, e) {
      if (marquee) {
        var m = marquee;
        marquee = null;
        app.state.marquee = null;
        var x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
        var y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
        var L = app.activeLayer(), ids = m.add ? m.base.slice() : [];
        if (L && L.visible && !L.locked) {
          var contained = L.paths.filter(function (path) {
            var b = R.bbox(path, true);
            return b && b.x >= x0 && b.x + b.w <= x1 && b.y >= y0 && b.y + b.h <= y1;
          }).map(function (path) { return path.id; });
          L.paths.forEach(function (path) {
            if (contained.indexOf(path.id) < 0) return;
            // A group is one selectable object: every member must fit.
            if (path.groupId && L.paths.some(function (member) {
              return member.groupId === path.groupId && contained.indexOf(member.id) < 0;
            })) return;
            if (ids.indexOf(path.id) < 0) ids.push(path.id);
          });
        }
        app.select(ids, ids[ids.length - 1] || null);
        app.renderAll();
        return;
      }
      if (!drag) return;
      var d = drag;
      drag = null;
      IM.Snap.clear();
      if (d.mode === "move") {
        if (d.dx || d.dy) {
          app.pushHistory("Move", { type: "move", layerId: d.layerId, ids: d.ids, dx: d.dx, dy: d.dy }, { applied: true });
        }
      } else if (d.mode === "scale") {
        if (d.sx !== 1 || d.sy !== 1) {
          app.pushHistory("Resize", { type: "scale", layerId: d.layerId, ids: d.ids, sx: d.sx, sy: d.sy, cx: d.fx, cy: d.fy, keepStroke: true }, { applied: true });
        }
      } else if (d.mode === "rotate") {
        if (d.angle) {
          app.pushHistory("Rotate", { type: "rotate", layerId: d.layerId, ids: d.ids, angle: d.angle, cx: d.cx, cy: d.cy }, { applied: true });
        }
      }
      if (d.copied) app.endTx();
      app.renderAll();
    },
    onDblClick: function () {},
    onKey: function () { return false; }
  };

  /* ---------- pen ---------- */

  function findOpenEnd(app, x, y, L) {
    var tol = tolOf(app);
    for (var i = L.paths.length - 1; i >= 0; i--) {
      var p = L.paths[i];
      if (p.closed || p.points.length === 0) continue;
      var first = p.points[0], last = p.points[p.points.length - 1];
      if (dist(x, y, last.x, last.y) <= tol) return { path: p, end: "last" };
      if (dist(x, y, first.x, first.y) <= tol) return { path: p, end: "first" };
    }
    return null;
  }

  function updateGhost(app) {
    var d = app.state.penDraft;
    app.state.ghost = d && d.points.length >= 2 ? newDrawingPath(app, M.clone(d.points), false) : null;
  }

  function cancelDraft(app) {
    app.state.penDraft = null;
    app.state.ghost = null;
    app.state.penPreviewSeg = null;
  }

  // Turns the pen draft into a path (new, or an extension of an open path).
  function finishDraft(app, closed) {
    var d = app.state.penDraft;
    if (!d) return;
    pen.pending = null;
    cancelDraft(app);
    var pts = M.clone(d.points);
    if (d.reversed) pts.reverse();
    if (d.originId) {
      var orig = M.pathIn(app.doc, d.layerId, d.originId);
      if (orig && (pts.length !== orig.points.length || !!closed !== orig.closed)) {
        app.pushHistory("Extend path", {
          type: "geom", layerId: d.layerId, id: orig.id,
          from: { closed: orig.closed, points: M.clone(orig.points) },
          to: { closed: orig.closed || !!closed, points: pts }
        });
      }
    } else if (pts.length >= (closed ? 3 : 2)) {
      addPath(app, newDrawingPath(app, pts, !!closed));
    }
    app.renderAll();
  }

  var pen = {
    id: "pen",
    cursor: "crosshair",
    pending: null,
    hint: function (app) {
      if (app.state.penDraft) {
        return "Click to add points. Click the first point to close the shape. Enter or double-click finishes, Esc cancels.";
      }
      return "Click to place points. Press and drag a point to bend the line into a curve. Click the end of a line to keep drawing from it.";
    },
    activate: function () { pen.pending = null; },
    deactivate: function (app) { finishDraft(app, false); },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      var L = activeUnlocked(app);
      if (!L) return;
      var st = app.state, startedHere = false;
      if (!st.penDraft) {
        var end = findOpenEnd(app, e.x, e.y, L);
        if (end) {
          var reversed = end.end === "first";
          var pts = M.clone(end.path.points);
          if (reversed) pts.reverse();
          st.penDraft = { points: pts, base: pts.length, originId: end.path.id, layerId: L.id, reversed: reversed };
          startedHere = true;
        } else {
          st.penDraft = { points: [], originId: null, layerId: L.id, reversed: false };
        }
      }
      var d = st.penDraft;
      var p = snapPt(app, e.x, e.y, d.originId ? [d.originId] : []);
      if (d.points.length >= 3 && dist(p.x, p.y, d.points[0].x, d.points[0].y) <= tolOf(app)) {
        finishDraft(app, true);
        return;
      }
      var last = d.points[d.points.length - 1];
      if (!startedHere && (!last || dist(p.x, p.y, last.x, last.y) > 1e-9)) {
        d.points.push({ x: p.x, y: p.y, cLx: 0, cLy: 0, cRx: 0, cRy: 0 });
      }
      pen.pending = { index: d.points.length - 1, x0: e.x, y0: e.y, moved: false };
      updateGhost(app);
      app.renderAll();
    },
    onMove: function (app, e) {
      var d = app.state.penDraft;
      if (!d) return;
      var pend = pen.pending;
      if (pend && !pend.moved && dist(e.x, e.y, pend.x0, pend.y0) * app.view.zoom > 3) pend.moved = true;
      if (pend && pend.moved) {
        var a = d.points[pend.index];
        if (a) {
          var hx = e.x - a.x, hy = e.y - a.y;
          a.cRx = hx; a.cRy = hy;
          if (e.altKey) { a.cLx = 0; a.cLy = 0; }
          else { a.cLx = -hx; a.cLy = -hy; }
          updateGhost(app);
        }
      }
      var last = d.points[d.points.length - 1];
      if (last) {
        var q = pend && pend.moved ? { x: e.x, y: e.y } : snapPt(app, e.x, e.y, d.originId ? [d.originId] : []);
        app.state.penPreviewSeg = { x1: last.x, y1: last.y, x2: q.x, y2: q.y };
      }
      app.requestRender();
    },
    onUp: function (app) {
      pen.pending = null;
      app.renderAll();
    },
    onDblClick: function (app) {
      finishDraft(app, false);
    },
    onKey: function (app, e) {
      var d = app.state.penDraft;
      if (!d) return false;
      if (e.key === "Enter") {
        finishDraft(app, false);
        return true;
      }
      if (e.key === "Escape") {
        pen.pending = null;
        cancelDraft(app);
        app.renderAll();
        return true;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (d.points.length > (d.originId ? d.base : 0)) d.points.pop();
        if (!d.points.length && !d.originId) cancelDraft(app);
        updateGhost(app);
        app.renderAll();
        return true;
      }
      return false;
    }
  };

  /* ---------- pencil ---------- */

  function perpDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return dist(p.x, p.y, a.x, a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  }

  // Ramer-Douglas-Peucker: keeps the points that carry the shape.
  function simplify(pts, eps) {
    var n = pts.length, i;
    var keep = [];
    for (i = 0; i < n; i++) keep.push(false);
    keep[0] = true;
    keep[n - 1] = true;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1], maxD = 0, idx = -1;
      for (i = a + 1; i < b; i++) {
        var d = perpDist(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx > 0 && maxD > eps) {
        keep[idx] = true;
        stack.push([a, idx], [idx, b]);
      }
    }
    var out = [];
    for (i = 0; i < n; i++) if (keep[i]) out.push(M.pt(pts[i].x, pts[i].y));
    return out;
  }

  var pencilPts = null;

  // Ignores pointer jitter below 1.2 screen px.
  function addPencilPoint(app, e) {
    var last = pencilPts[pencilPts.length - 1];
    if (dist(e.x, e.y, last.x, last.y) * app.view.zoom < 1.2) return false;
    pencilPts.push(M.pt(e.x, e.y));
    return true;
  }

  function finishPencil(app) {
    var pts = pencilPts;
    pencilPts = null;
    app.state.ghost = null;
    if (!pts || pts.length < 2) {
      app.renderAll();
      return;
    }
    var first = pts[0], last = pts[pts.length - 1];
    var closed = pts.length > 2 && dist(first.x, first.y, last.x, last.y) * app.view.zoom < 12;
    var simp = simplify(pts, Math.max(0.1, app.doc.size / 100));
    if (closed && simp.length > 2) simp.pop();
    if (simp.length < (closed ? 3 : 2)) {
      app.renderAll();
      return;
    }
    for (var i = 0; i < simp.length; i++) {
      var h = R.smoothHandles(simp, i, closed);
      simp[i].cLx = h.cLx; simp[i].cLy = h.cLy;
      simp[i].cRx = h.cRx; simp[i].cRy = h.cRy;
    }
    addPath(app, newDrawingPath(app, simp, closed));
    app.renderAll();
  }

  var pencil = {
    id: "pencil",
    cursor: "crosshair",
    hint: function () { return "Draw freely. Let go to finish. Lines are tidied up automatically."; },
    activate: function () { pencilPts = null; },
    deactivate: function (app) { if (pencilPts) finishPencil(app); },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      if (!activeUnlocked(app)) return;
      pencilPts = [M.pt(e.x, e.y)];
      app.state.ghost = newDrawingPath(app, M.clone(pencilPts), false);
      app.requestRender();
    },
    onMove: function (app, e) {
      if (!pencilPts || !addPencilPoint(app, e)) return;
      app.state.ghost = newDrawingPath(app, M.clone(pencilPts), false);
      app.requestRender();
    },
    onUp: function (app, e) {
      if (!pencilPts) return;
      addPencilPoint(app, e);
      finishPencil(app);
    },
    onDblClick: function () {},
    onKey: function () { return false; }
  };

  /* ---------- line ---------- */

  var lineD = null;

  // End point of the line being drawn: snapped, and angle-locked with Shift.
  function lineEnd(app, d, e) {
    var p = snapPt(app, e.x, e.y, []);
    if (!e.shiftKey) return { x: p.x, y: p.y };
    var dx = p.x - d.x0, dy = p.y - d.y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    var step = Math.PI / 12;
    var a = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: d.x0 + Math.cos(a) * len, y: d.y0 + Math.sin(a) * len };
  }

  var line = {
    id: "line",
    cursor: "crosshair",
    hint: function () { return "Drag to draw a straight line. Hold Shift to snap the angle."; },
    activate: function () { lineD = null; },
    deactivate: function (app) { lineD = null; app.state.ghost = null; },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      if (!activeUnlocked(app)) return;
      var p = snapPt(app, e.x, e.y, []);
      lineD = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    },
    onMove: function (app, e) {
      if (!lineD) return;
      var end = lineEnd(app, lineD, e);
      lineD.x1 = end.x; lineD.y1 = end.y;
      app.state.ghost = newDrawingPath(app, [M.pt(lineD.x0, lineD.y0), M.pt(end.x, end.y)], false);
      app.requestRender();
    },
    onUp: function (app, e) {
      if (!lineD) return;
      var d = lineD;
      lineD = null;
      app.state.ghost = null;
      var end = lineEnd(app, d, e);
      d.x1 = end.x; d.y1 = end.y;
      if (dist(d.x0, d.y0, d.x1, d.y1) >= MIN_DIST) {
        addPath(app, newDrawingPath(app, [M.pt(d.x0, d.y0), M.pt(d.x1, d.y1)], false));
      }
      app.renderAll();
    },
    onDblClick: function () {},
    onKey: function () { return false; }
  };

  /* ---------- drawable objects ---------- */

  var shapeNames = {
    rect: "Rectangle", roundedRect: "Rounded rectangle", ellipse: "Oval",
    triangle: "Triangle", diamond: "Diamond", pentagon: "Pentagon", hexagon: "Hexagon",
    star: "Star", heart: "Heart", arrow: "Arrow", plus: "Plus"
  };

  // Geometry for a rectangle or ellipse dragged from (x0,y0) to (x1,y1).
  function shapeGeom(kind, x0, y0, x1, y1, shift, alt, size) {
    if (shift) {
      var dx = x1 - x0, dy = y1 - y0, m = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = x0 + (dx < 0 ? -m : m);
      y1 = y0 + (dy < 0 ? -m : m);
    }
    var ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    if (kind === "rect" || kind === "roundedRect") {
      if ((alt || kind === "roundedRect") && bx - ax > 0 && by - ay > 0) {
        // rounded corners; radius scales with the artboard (2 px at 32 px)
        var r = Math.min(Math.max(1, size / 16), (bx - ax) / 2, (by - ay) / 2);
        var k = 0.5523 * r;
        return {
          closed: true,
          points: [
            M.pt(ax + r, ay, -k, 0, 0, 0),
            M.pt(bx - r, ay, 0, 0, k, 0),
            M.pt(bx, ay + r, 0, -k, 0, 0),
            M.pt(bx, by - r, 0, 0, 0, k),
            M.pt(bx - r, by, k, 0, 0, 0),
            M.pt(ax + r, by, 0, 0, -k, 0),
            M.pt(ax, by - r, 0, k, 0, 0),
            M.pt(ax, ay + r, 0, 0, 0, -k)
          ]
        };
      }
      return { closed: true, points: [M.pt(ax, ay), M.pt(bx, ay), M.pt(bx, by), M.pt(ax, by)] };
    }
    var w = bx - ax, h = by - ay, vertices = null;
    if (kind === "triangle") vertices = [[0.5, 0], [1, 1], [0, 1]];
    if (kind === "diamond") vertices = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    if (kind === "arrow") vertices = [[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]];
    if (kind === "plus") vertices = [[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]];
    if (kind === "pentagon" || kind === "hexagon" || kind === "star") {
      vertices = [];
      var n = kind === "star" ? 10 : kind === "pentagon" ? 5 : 6;
      for (var i = 0; i < n; i++) {
        var angle = -Math.PI / 2 + i * Math.PI * 2 / n;
        var radius = kind === "star" && i % 2 ? 0.225 : 0.5;
        vertices.push([0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)]);
      }
      // Fit the polygon exactly to the dragged frame.
      var xs = vertices.map(function (v) { return v[0]; }), ys = vertices.map(function (v) { return v[1]; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      vertices = vertices.map(function (v) { return [(v[0] - minX) / (maxX - minX), (v[1] - minY) / (maxY - minY)]; });
    }
    if (vertices) return { closed: true, points: vertices.map(function (v) { return M.pt(ax + v[0] * w, ay + v[1] * h); }) };
    if (kind === "heart") {
      return { closed: true, points: [
        M.pt(ax + w * 0.5, by, w * 0.25, -h * 0.25, -w * 0.25, -h * 0.25),
        M.pt(ax, ay + h * 0.3, 0, h * 0.25, 0, -h * 0.4),
        M.pt(ax + w * 0.5, ay + h * 0.2, -w * 0.2, -h * 0.3, w * 0.2, -h * 0.3),
        M.pt(bx, ay + h * 0.3, 0, -h * 0.4, 0, h * 0.25)
      ] };
    }
    var cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = (bx - ax) / 2, ry = (by - ay) / 2;
    var kx = 0.5523 * rx, ky = 0.5523 * ry;
    return {
      closed: true,
      points: [
        M.pt(cx - rx, cy, 0, ky, 0, -ky),
        M.pt(cx, cy - ry, -kx, 0, kx, 0),
        M.pt(cx + rx, cy, 0, -ky, 0, ky),
        M.pt(cx, cy + ry, kx, 0, -kx, 0)
      ]
    };
  }

  function shapeTool(kind) {
    var s = null;
    return {
      id: kind,
      cursor: "crosshair",
      hint: function () {
        return kind === "rect"
          ? "Drag to draw a rectangle. Hold Shift for a square, Alt for rounded corners."
          : kind === "ellipse" ? "Drag to draw an oval. Hold Shift for a circle."
          : "Drag to draw a " + shapeNames[kind].toLowerCase() + ". Hold Shift for equal width and height.";
      },
      activate: function () { s = null; },
      deactivate: function (app) { s = null; app.state.ghost = null; },
      onDown: function (app, e) {
        if (e.space || e.button) return;
        if (!activeUnlocked(app)) return;
        var p = snapPt(app, e.x, e.y, []);
        s = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      },
      onMove: function (app, e) {
        if (!s) return;
        var p = snapPt(app, e.x, e.y, []);
        s.x1 = p.x; s.y1 = p.y;
        var g = shapeGeom(kind, s.x0, s.y0, s.x1, s.y1, e.shiftKey, e.altKey, app.doc.size);
        app.state.ghost = newDrawingPath(app, g.points, g.closed, true);
        app.requestRender();
      },
      onUp: function (app, e) {
        if (!s) return;
        var d = s;
        s = null;
        app.state.ghost = null;
        var end = snapPt(app, e.x, e.y, []);
        d.x1 = end.x; d.y1 = end.y;
        var g = shapeGeom(kind, d.x0, d.y0, d.x1, d.y1, e.shiftKey, e.altKey, app.doc.size);
        var xs = g.points.map(function (q) { return q.x; }), ys = g.points.map(function (q) { return q.y; });
        var w = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        var h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
        if (w >= MIN_SHAPE && h >= MIN_SHAPE) addPath(app, newDrawingPath(app, g.points, g.closed, true));
        app.renderAll();
      },
      onDblClick: function () {},
      onKey: function () { return false; }
    };
  }

  var rect = shapeTool("rect");
  var ellipse = shapeTool("ellipse");

  /* ---------- fill and stroke (click, or drag across shapes) ---------- */

  var painting = null;   // {seen: {}} while a fill/stroke drag is in progress

  function endPaint(app) {
    if (!painting) return;
    painting = null;
    app.endTx();
    app.renderAll();
  }

  function applyFill(app, hit) {
    var st = app.state, p = hit.path;
    painting.seen[p.id] = true;
    var to = { kind: st.fillKind, color: st.fillColor, opacity: st.fillOpacity, gradient: null };
    if (st.fillKind === "gradient") to.gradient = gradientFor(p, st.gradient.stops);
    app.pushHistory("Fill", { type: "style", layerId: hit.layerId, id: p.id, field: "fill", from: M.clone(p.fill), to: to });
  }

  function applyStroke(app, hit) {
    var st = app.state, p = hit.path;
    painting.seen[p.id] = true;
    var to = { color: st.strokeColor, width: st.strokeWidth, opacity: st.strokeOpacity, cap: "round", join: "round" };
    app.pushHistory("Stroke", { type: "style", layerId: hit.layerId, id: p.id, field: "stroke", from: M.clone(p.stroke), to: to });
    var dash = st.dash && st.dash !== "none" ? { pattern: st.dash } : null;
    if (JSON.stringify(dash) !== JSON.stringify(p.dash)) {
      app.pushHistory("Stroke", { type: "style", layerId: hit.layerId, id: p.id, field: "dash", from: M.clone(p.dash), to: dash });
    }
  }

  function paintTool(id, apply, message, hintText) {
    return {
      id: id,
      cursor: "crosshair",
      hint: function () { return hintText; },
      deactivate: function (app) { endPaint(app); },
      onDown: function (app, e) {
        if (e.space || e.button) return;
        var hit = pickAt(app, e.x, e.y);
        if (!hit) {
          app.toast(message);
          return;
        }
        app.beginTx(id === "fill" ? "Fill" : "Stroke");
        painting = { seen: {} };
        apply(app, hit);
      },
      onMove: function (app, e) {
        if (!painting) return;
        var hit = pickAt(app, e.x, e.y);
        if (hit && !painting.seen[hit.path.id]) apply(app, hit);
      },
      onUp: function (app) { endPaint(app); },
      onDblClick: function () {},
      onKey: function () { return false; }
    };
  }

  var fill = paintTool("fill", applyFill, "Click inside a shape to fill it.",
    "Click inside a shape to fill it with the current colour. Drag across several shapes to fill them all.");
  var stroke = paintTool("stroke", applyStroke, "Click a shape's outline to give it the current line style.",
    "Click a shape's outline to give it the current line style. Drag across outlines to change several.");

  /* ---------- eyedropper ---------- */

  var eyedropper = {
    id: "eyedropper",
    cursor: "crosshair",
    hint: function (app) {
      return app.state.styleTarget === "fill"
        ? "Click a shape to copy its fill colour."
        : "Click a shape to copy its outline colour.";
    },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      var hit = hitAt(app, e.x, e.y);
      if (!hit) {
        app.toast("Nothing to pick here.");
        return;
      }
      var c = pickColor(hit.path, app.state.styleTarget);
      if (c === null) {
        app.toast("That shape has no fill. Choose Outline to copy its line colour.");
        return;
      }
      var hasSelection = app.state.selPathIds.length > 0;
      if (app.state.styleTarget === "fill") app.setFillColor(c);
      else app.setStrokeColor(c);
      app.toast(hasSelection ? "Picked " + c : "Picked " + c + ". Use Fill or Outline to apply it.");
    },
    onMove: function () {},
    onUp: function () {}
  };

  /* ---------- node ---------- */

  var nodeDrag = null;

  function primaryPathOf(app) {
    return app.state.selPathId ? M.pathIn(app.doc, app.doc.activeLayerId, app.state.selPathId) : null;
  }

  function setPoints(app, path, label, points, closed) {
    app.pushHistory(label, {
      type: "geom", layerId: app.doc.activeLayerId, id: path.id,
      from: { closed: path.closed, points: M.clone(path.points) },
      to: { closed: closed === undefined ? path.closed : closed, points: points }
    });
  }

  function insertNodeAt(app, path, index, t) {
    var n = path.points.length;
    var bi = (index + 1) % n;
    var sp = R.splitSegment(path.points[index], path.points[bi], t);
    var pts = M.clone(path.points);
    pts[index].cRx = sp.aOut.x; pts[index].cRy = sp.aOut.y;
    pts[bi].cLx = sp.bIn.x; pts[bi].cLy = sp.bIn.y;
    var np = { x: sp.point.x, y: sp.point.y, cLx: sp.point.cLx, cLy: sp.point.cLy, cRx: sp.point.cRx, cRy: sp.point.cRy };
    if (app.state.snap) {
      np.x = Math.round(np.x);
      np.y = Math.round(np.y);
    }
    pts.splice(index + 1, 0, np);
    setPoints(app, path, "Add point", pts);
    app.state.selPointIndex = index + 1;
  }

  function deleteNode(app, index) {
    var path = primaryPathOf(app);
    if (!path || index < 0 || index >= path.points.length) return;
    var min = path.closed ? 3 : 2;
    if (path.points.length <= min) {
      app.toast(path.closed ? "A shape needs at least three points." : "A line needs at least two points.");
      return;
    }
    var pts = M.clone(path.points);
    pts.splice(index, 1);
    setPoints(app, path, "Delete point", pts);
    app.state.selPointIndex = -1;
  }

  function toggleSmooth(app, index) {
    var path = primaryPathOf(app);
    if (!path || index < 0) return;
    var pt = path.points[index];
    var hasHandles = pt.cLx || pt.cLy || pt.cRx || pt.cRy;
    var to = hasHandles ? { cLx: 0, cLy: 0, cRx: 0, cRy: 0 } : R.smoothHandles(path.points, index, path.closed);
    app.pushHistory(hasHandles ? "Make corner" : "Make smooth", {
      type: "node-handle", layerId: app.doc.activeLayerId, id: path.id, index: index, side: "both",
      from: handlesOf(pt), to: to
    });
  }

  function toggleClosed(app) {
    var path = primaryPathOf(app);
    if (!path) return;
    if (!path.closed && path.points.length < 3) {
      app.toast("Add at least three points to close a shape.");
      return;
    }
    setPoints(app, path, path.closed ? "Open path" : "Close path", M.clone(path.points), !path.closed);
  }

  var hoverApp = null, lastPt = null, hoverKey = "";

  function setHoverClass(app, mode) {
    var svg = app.canvas.svg;
    svg.classList.toggle("nh-add", mode === "add");
    svg.classList.toggle("nh-remove", mode === "remove");
    svg.classList.toggle("nh-move", mode === "move");
  }

  function clearHover(app) {
    app.state.nodeHover = null;
    hoverKey = "";
    setHoverClass(app, null);
    app.requestRender();
  }

  // Shows what a click would do here: add a point on a curve, remove a point
  // while Alt is held, or move a point or handle.
  function updateHover(app, x, y, alt) {
    var hn = null;
    if (!app.state.space && !nodeDrag && primaryPathOf(app)) hn = IM.Overlay.hitNode(app, x, y);
    var mode = null;
    if (hn) {
      if (hn.kind === "segment") mode = "add";
      else if (hn.kind === "anchor" && alt) mode = "remove";
      else mode = "move";
    }
    app.state.nodeHover = hn ? { kind: hn.kind, index: hn.index, t: hn.t, x: hn.x, y: hn.y, mode: mode } : null;
    setHoverClass(app, mode);
    var key = hn ? mode + ":" + hn.kind + ":" + hn.index + ":" + (hn.side || "") : "";
    if (key || hoverKey) app.requestRender();
    hoverKey = key;
  }

  // Alt is a keyboard-only signal, so refresh the hover when it changes.
  function onAltChange(ev) {
    if (ev.key !== "Alt" || !hoverApp || !lastPt) return;
    updateHover(hoverApp, lastPt.x, lastPt.y, ev.altKey);
  }

  var node = {
    id: "node",
    cursor: "crosshair",
    hint: function (app) {
      if (app.state.selPointIndex >= 0) {
        return "Drag the point or its round handles. F makes it smooth or sharp. Del removes it. Arrow keys nudge.";
      }
      if (app.state.selPathId) {
        return "Drag a point or handle. Hover a curve and click the diamond to add a point. Hold Alt and click a point to remove it. G opens or closes the line.";
      }
      return "Click a shape to edit its points.";
    },
    activate: function (app) {
      nodeDrag = null;
      hoverApp = app;
      document.addEventListener("keydown", onAltChange);
      document.addEventListener("keyup", onAltChange);
    },
    deactivate: function (app) {
      nodeDrag = null;
      document.removeEventListener("keydown", onAltChange);
      document.removeEventListener("keyup", onAltChange);
      lastPt = null;
      hoverApp = null;
      clearHover(app);
    },
    onLeave: function (app) {
      if (nodeDrag) return;
      lastPt = null;
      clearHover(app);
    },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      IM.Snap.clear();
      var st = app.state;
      var hn = IM.Overlay.hitNode(app, e.x, e.y);
      if (!hn) {
        var hit = hitAt(app, e.x, e.y);
        if (hit) {
          app.select([hit.path.id], hit.path.id);
        } else {
          app.select([], null);
        }
        app.renderAll();
        return;
      }
      var L = app.activeLayer();
      var path = primaryPathOf(app);
      if (!path || !L) return;
      if (L.locked) {
        app.toast("This layer is locked. Click its lock to unlock it.");
        return;
      }
      if (hn.kind === "segment") {
        insertNodeAt(app, path, hn.index, hn.t);
        var np = primaryPathOf(app);
        var ni = hn.index + 1;
        nodeDrag = { mode: "anchor", id: np.id, layerId: L.id, index: ni, from: pointOf(np.points[ni]) };
      } else if (hn.kind === "anchor") {
        if (e.altKey) {
          deleteNode(app, hn.index);
          app.renderAll();
          return;
        }
        st.selPointIndex = hn.index;
        nodeDrag = { mode: "anchor", id: path.id, layerId: L.id, index: hn.index, from: pointOf(path.points[hn.index]) };
      } else if (hn.kind === "handle") {
        st.selPointIndex = hn.index;
        nodeDrag = { mode: "handle", id: path.id, layerId: L.id, index: hn.index, side: hn.side, from: handlesOf(path.points[hn.index]) };
      }
      app.renderAll();
    },
    onMove: function (app, e) {
      lastPt = { x: e.x, y: e.y };
      if (!nodeDrag) {
        updateHover(app, e.x, e.y, e.altKey);
        return;
      }
      var path = M.pathIn(app.doc, nodeDrag.layerId, nodeDrag.id);
      if (!path) return;
      var pt = path.points[nodeDrag.index];
      if (nodeDrag.mode === "anchor") {
        var target = app.state.snap
          ? IM.Snap.snapPoint(e.x, e.y, { doc: app.doc, zoom: app.view.zoom, grid: true, anchors: true, exclude: [path.id] })
          : { x: e.x, y: e.y };
        pt.x = target.x;
        pt.y = target.y;
      } else {
        var tip = app.state.snap
          ? IM.Snap.snapPoint(e.x, e.y, { doc: app.doc, zoom: app.view.zoom, grid: true, anchors: true, exclude: [path.id] })
          : { x: e.x, y: e.y };
        var hx = tip.x - pt.x, hy = tip.y - pt.y;
        if (nodeDrag.side === "L") {
          pt.cLx = hx; pt.cLy = hy;
          if (e.altKey) { pt.cRx = -hx; pt.cRy = -hy; }
        } else {
          pt.cRx = hx; pt.cRy = hy;
          if (e.altKey) { pt.cLx = -hx; pt.cLy = -hy; }
        }
      }
      app.requestRender();
    },
    onUp: function (app) {
      var d = nodeDrag;
      nodeDrag = null;
      if (!d) return;
      var path = M.pathIn(app.doc, d.layerId, d.id);
      if (!path || !path.points[d.index]) {
        app.renderAll();
        return;
      }
      var pt = path.points[d.index];
      if (d.mode === "anchor") {
        var to = pointOf(pt);
        if (to.x !== d.from.x || to.y !== d.from.y) {
          app.pushHistory("Move point", { type: "node-move", layerId: d.layerId, id: d.id, index: d.index, from: pointOf(d.from), to: to }, { applied: true });
        }
      } else {
        var toH = handlesOf(pt);
        if (toH.cLx !== d.from.cLx || toH.cLy !== d.from.cLy || toH.cRx !== d.from.cRx || toH.cRy !== d.from.cRy) {
          app.pushHistory("Move handle", { type: "node-handle", layerId: d.layerId, id: d.id, index: d.index, side: "both", from: d.from, to: toH }, { applied: true });
        }
      }
      app.renderAll();
    },
    onKey: function (app, e) {
      var st = app.state;
      var k = e.key;
      if (k === "Alt") return true;
      if (!primaryPathOf(app)) return false;
      if ((k === "f" || k === "F") && st.selPointIndex >= 0) {
        toggleSmooth(app, st.selPointIndex);
        return true;
      }
      if (k === "g" || k === "G") {
        toggleClosed(app);
        return true;
      }
      if ((k === "Delete" || k === "Backspace") && st.selPointIndex >= 0) {
        deleteNode(app, st.selPointIndex);
        return true;
      }
      var step = e.shiftKey ? 5 : 1;
      var dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
      var dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
      if ((dx || dy) && st.selPointIndex >= 0) {
        var path = primaryPathOf(app);
        var pt = path.points[st.selPointIndex];
        var from = pointOf(pt);
        var to = { x: pt.x + dx, y: pt.y + dy, cLx: pt.cLx, cLy: pt.cLy, cRx: pt.cRx, cRy: pt.cRy };
        app.pushHistory("Move point", { type: "node-move", layerId: app.doc.activeLayerId, id: path.id, index: st.selPointIndex, from: from, to: to }, { key: "nudge-node" });
        return true;
      }
      return false;
    }
  };

  /* ---------- eraser ---------- */

  var erasing = false;

  function endErase(app) {
    if (!erasing) return;
    erasing = false;
    app.endTx();
    app.renderAll();
  }

  function eraseAt(app, x, y) {
    var hit = hitAt(app, x, y);
    if (!hit) return;
    var L = M.layer(app.doc, hit.layerId);
    var idx = M.indexOfId(L.paths, hit.path.id);
    if (idx < 0) return;
    app.pushHistory("Erase", { type: "delete", layerId: L.id, index: idx, path: M.clone(hit.path) });
  }

  var eraser = {
    id: "eraser",
    cursor: "crosshair",
    hint: function () { return "Click a shape to remove it. Drag across shapes to remove several at once."; },
    deactivate: function (app) { endErase(app); },
    onDown: function (app, e) {
      if (e.space || e.button) return;
      erasing = true;
      app.beginTx("Erase");
      eraseAt(app, e.x, e.y);
    },
    onMove: function (app, e) {
      if (erasing) eraseAt(app, e.x, e.y);
    },
    onUp: function (app) { endErase(app); },
    onDblClick: function () {},
    onKey: function () { return false; }
  };

  /* ---------- hand ---------- */

  var handD = null;

  var hand = {
    id: "hand",
    cursor: "grab",
    hint: function () { return "Drag to move around the artboard. You can also hold Ctrl or Space in any tool."; },
    deactivate: function () { handD = null; },
    onDown: function (app, e) {
      if (e.button) return;
      handD = { px: e.clientX, py: e.clientY, panX: app.view.panX, panY: app.view.panY };
    },
    onMove: function (app, e) {
      if (!handD) return;
      app.view.panX = handD.panX + (e.clientX - handD.px);
      app.view.panY = handD.panY + (e.clientY - handD.py);
      app.requestRender();
    },
    onUp: function () { handD = null; },
    onDblClick: function () {},
    onKey: function () { return false; }
  };

  IM.Tools = {
    select: select,
    pen: pen,
    pencil: pencil,
    line: line,
    rect: rect,
    ellipse: ellipse,
    fill: fill,
    stroke: stroke,
    node: node,
    eraser: eraser,
    eyedropper: eyedropper,
    hand: hand,
    // keyboard letter -> tool id
    keys: {
      v: "select", p: "pen", b: "pencil", l: "line", r: "rect", e: "ellipse",
      g: "fill", k: "stroke", t: "node", c: "eraser", i: "eyedropper", h: "hand"
    },
    // helpers shared with the app shell
    gradientFor: gradientFor,
    newDrawingPath: newDrawingPath,
    shapeNames: shapeNames,
    shapeGeom: shapeGeom
  };
  Object.keys(shapeNames).forEach(function (kind) {
    if (!IM.Tools[kind]) IM.Tools[kind] = shapeTool(kind);
  });
})();
