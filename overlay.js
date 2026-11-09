/* IconMaker — overlay.js
 * Everything drawn on top of the artwork: selection outlines and transform
 * handles, node handles for the node tool, the pen draft, alignment guides
 * and the marquee. Handle sizes are constant on screen. Attaches IM.Overlay.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var HANDLE_PX = 8;      // square handle size on screen
  var HIT_PX = 8;         // pointer tolerance on screen
  var ROTATE_PX = 22;     // distance of the rotate handle above the box
  var DASH_PX = 4, GAP_PX = 3;  // dash pattern on screen

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
        e.setAttribute(k, attrs[k]);
      }
    }
    return e;
  }

  function clear(app) {
    var g = app.canvas.overlayG;
    while (g.firstChild) g.removeChild(g.firstChild);
  }

  function dist(ax, ay, bx, by) {
    return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
  }

  // Overlay strokes and dashes are in document units, which grow with the zoom.
  // Dividing by zoom keeps them at the same size on screen at every artboard size.
  function dashArray(zoom) {
    return DASH_PX / zoom + " " + GAP_PX / zoom;
  }

  // Paths currently selected in the active layer, in layer order.
  function selectedPaths(app) {
    var L = app.activeLayer(), out = [];
    if (!L) return out;
    for (var i = 0; i < L.paths.length; i++) {
      if (app.state.selPathIds.indexOf(L.paths[i].id) >= 0) out.push(L.paths[i]);
    }
    return out;
  }

  function primaryPath(app) {
    if (!app.state.selPathId) return null;
    return IM.Model.pathIn(app.doc, app.doc.activeLayerId, app.state.selPathId);
  }

  // Selection box corners and handles. Corners: 0 TL, 1 TR, 2 BR, 3 BL.
  function boxHandles(bb, zoom) {
    var x = bb.x, y = bb.y, w = bb.w, h = bb.h, cx = x + w / 2, cy = y + h / 2;
    return [
      { kind: "bbox-corner", corner: 0, x: x, y: y },
      { kind: "bbox-edge", edge: "n", x: cx, y: y },
      { kind: "bbox-corner", corner: 1, x: x + w, y: y },
      { kind: "bbox-edge", edge: "e", x: x + w, y: cy },
      { kind: "bbox-corner", corner: 2, x: x + w, y: y + h },
      { kind: "bbox-edge", edge: "s", x: cx, y: y + h },
      { kind: "bbox-corner", corner: 3, x: x, y: y + h },
      { kind: "bbox-edge", edge: "w", x: x, y: cy },
      { kind: "bbox-rotate", x: cx, y: y - ROTATE_PX / zoom }
    ];
  }

  function selectionBox(app) {
    var L = app.activeLayer();
    return IM.Renderer.selectionBounds(L, app.state.selPathIds, false);
  }

  function drawNodes(g, path, st, zoom) {
    var hs = HANDLE_PX / zoom, i, p, n = path.points.length;
    // Thin outline that stays one screen pixel wide, so it reads inside any border width.
    g.appendChild(el("path", { d: IM.Renderer.pathD(path), "class": "ov-outline", "stroke-width": 1 / zoom, fill: "none" }));
    for (i = 0; i < n; i++) {
      p = path.points[i];
      if (p.cLx || p.cLy) {
        g.appendChild(el("line", { x1: p.x, y1: p.y, x2: p.x + p.cLx, y2: p.y + p.cLy, "class": "ov-handle", "stroke-width": 1 / zoom }));
        g.appendChild(el("circle", { cx: p.x + p.cLx, cy: p.y + p.cLy, r: 3.5 / zoom, "class": "ov-handle-c" }));
      }
      if (p.cRx || p.cRy) {
        g.appendChild(el("line", { x1: p.x, y1: p.y, x2: p.x + p.cRx, y2: p.y + p.cRy, "class": "ov-handle", "stroke-width": 1 / zoom }));
        g.appendChild(el("circle", { cx: p.x + p.cRx, cy: p.y + p.cRy, r: 3.5 / zoom, "class": "ov-handle-c" }));
      }
    }
    for (i = 0; i < n; i++) {
      p = path.points[i];
      g.appendChild(el("rect", {
        x: p.x - hs / 2, y: p.y - hs / 2, width: hs, height: hs,
        "class": "ov-node" + (st.selPointIndex === i ? " sel" : ""), "stroke-width": 1 / zoom
      }));
    }
  }

  function drawPenDraft(g, app, zoom) {
    var d = app.state.penDraft;
    if (!d || !d.points.length) return;
    var hs = HANDLE_PX / zoom;
    for (var i = 0; i < d.points.length; i++) {
      var p = d.points[i];
      var first = i === 0 && d.points.length >= 3;
      g.appendChild(el("rect", {
        x: p.x - hs / 2 - (first ? 2 / zoom : 0), y: p.y - hs / 2 - (first ? 2 / zoom : 0),
        width: hs + (first ? 4 / zoom : 0), height: hs + (first ? 4 / zoom : 0),
        "class": first ? "ov-close" : "ov-node", "stroke-width": 1 / zoom
      }));
    }
  }

  function render(app) {
    clear(app);
    var g = app.canvas.overlayG, zoom = app.view.zoom, st = app.state, tool = st.tool;
    var hs = HANDLE_PX / zoom;

    // selection outlines for every tool except the node tool (which draws its own)
    if (tool !== "node" && st.selPathIds.length) {
      var paths = selectedPaths(app);
      for (var s = 0; s < paths.length; s++) {
        var ob = IM.Renderer.bbox(paths[s], true);
        if (!ob) continue;
        g.appendChild(el("rect", { x: ob.x, y: ob.y, width: ob.w, height: ob.h, "class": "ov-sel", "stroke-width": 1 / zoom }));
      }
    }

    if (tool === "select" && st.selPathIds.length) {
      var bb = selectionBox(app);
      if (bb) {
        g.appendChild(el("rect", {
          x: bb.x, y: bb.y, width: bb.w, height: bb.h, "class": "ov-bbox",
          "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom)
        }));
        g.appendChild(el("line", {
          x1: bb.x + bb.w / 2, y1: bb.y, x2: bb.x + bb.w / 2, y2: bb.y - ROTATE_PX / zoom,
          "class": "ov-handle", "stroke-width": 1 / zoom
        }));
        var hl = boxHandles(bb, zoom);
        for (var h = 0; h < hl.length; h++) {
          if (hl[h].kind === "bbox-rotate") {
            g.appendChild(el("circle", { cx: hl[h].x, cy: hl[h].y, r: 4.5 / zoom, "class": "ov-rot", "stroke-width": 1 / zoom }));
          } else {
            g.appendChild(el("rect", { x: hl[h].x - hs / 2, y: hl[h].y - hs / 2, width: hs, height: hs, "class": "ov-node", "stroke-width": 1 / zoom }));
          }
        }
      }
    }

    if (tool === "node") {
      var node = primaryPath(app);
      if (node) drawNodes(g, node, st, zoom);
      if (st.nodeHover && st.nodeHover.kind === "segment") {
        var dr = 4 / zoom, hx = st.nodeHover.x, hy = st.nodeHover.y;
        var dd = "M" + hx + " " + (hy - dr) + "L" + (hx + dr) + " " + hy + "L" + hx + " " + (hy + dr) + "L" + (hx - dr) + " " + hy + "Z";
        g.appendChild(el("path", { d: dd, "class": "ov-ghost-dot", "stroke-width": 1 / zoom }));
      }
    }

    if (tool === "pen") drawPenDraft(g, app, zoom);

    // drawing ghost (shape being drawn) and pen rubber band
    if (st.ghost && st.ghost.points && st.ghost.points.length >= 2) {
      g.appendChild(el("path", { d: IM.Renderer.pathD(st.ghost), "class": "ov-ghost", "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom), fill: "none" }));
    }
    if (st.penPreviewSeg) {
      var seg = st.penPreviewSeg;
      g.appendChild(el("line", { x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, "class": "ov-ghost", "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom) }));
    }

    if (st.marquee) {
      var m = st.marquee;
      g.appendChild(el("rect", {
        x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
        width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0),
        "class": "ov-marquee", "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom)
      }));
    }

    drawGuides(app);
  }

  function drawGuides(app) {
    var g = app.canvas.overlayG, zoom = app.view.zoom, size = app.doc.size;
    var gs = IM.Snap.guides || [];
    for (var i = 0; i < gs.length; i++) {
      var gd = gs[i], line;
      if (gd.axis === "v") {
        var x = Math.min(size, Math.max(0, gd.pos));
        line = el("line", { x1: x, y1: -20 / zoom, x2: x, y2: size + 20 / zoom, "class": "ov-guide", "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom) });
      } else {
        var y = Math.min(size, Math.max(0, gd.pos));
        line = el("line", { x1: -20 / zoom, y1: y, x2: size + 20 / zoom, y2: y, "class": "ov-guide", "stroke-width": 1 / zoom, "stroke-dasharray": dashArray(zoom) });
      }
      g.appendChild(line);
    }
  }

  // Topmost handle under (x,y) in document units, or null.
  //   node tool:   {kind:"handle", index, side} | {kind:"anchor", index} | {kind:"segment", index, t, x, y}
  //   select tool: {kind:"bbox-corner"|"bbox-edge"|"bbox-rotate", corner?|edge?}
  function hitNode(app, x, y) {
    var st = app.state, zoom = app.view.zoom, tol = HIT_PX / zoom, i;

    if (st.tool === "node") {
      var path = primaryPath(app);
      if (!path) return null;
      return IM.Renderer.nodeTargetAt(path, x, y, tol);
    }

    if (st.tool === "select" && st.selPathIds.length) {
      var bb = selectionBox(app);
      if (!bb) return null;
      var hl = boxHandles(bb, zoom);
      for (i = 0; i < hl.length; i++) {
        if (dist(x, y, hl[i].x, hl[i].y) <= (hl[i].kind === "bbox-rotate" ? tol * 1.4 : tol)) {
          var out = { kind: hl[i].kind };
          if (hl[i].kind === "bbox-corner") out.corner = hl[i].corner;
          if (hl[i].kind === "bbox-edge") out.edge = hl[i].edge;
          return out;
        }
      }
    }
    return null;
  }

  IM.Overlay = {
    render: render,
    clear: clear,
    hitNode: hitNode,
    drawGuides: drawGuides,
    selectionBox: selectionBox
  };
})();
