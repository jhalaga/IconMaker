/* IconMaker — renderer.js
 * SVG rendering of documents (main canvas and 1:1 previews) plus the geometry
 * helpers shared by tools, overlay, snapping and export. Attaches IM.Renderer.
 *
 * Geometry rule: a segment is a cubic Bezier whenever either end has a handle.
 * Single-handle segments are degree-elevated to cubic, so drawing, sampling,
 * hit-testing and node splitting all use the same curve.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var R = (IM.Renderer = {});
  var STEPS = 16;               // samples per curve segment (hit tests, bounds)
  /* ---------- DOM helpers ---------- */

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Path data: two decimals, trailing zeros removed.
  function fmt(n) {
    var s = (Math.round(n * 100) / 100).toFixed(2);
    if (s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
  }

  // Full precision for transforms.
  function num(n) {
    return String(Math.round(n * 1e6) / 1e6);
  }

  /* ---------- curve geometry ---------- */

  function hasOut(p) { return p.cRx !== 0 || p.cRy !== 0; }
  function hasIn(p) { return p.cLx !== 0 || p.cLy !== 0; }

  // Cubic control points for segment a -> b, or null for a straight line.
  function segCubic(a, b) {
    var oh = hasOut(a), ih = hasIn(b);
    if (!oh && !ih) return null;
    var c1, c2;
    if (oh && ih) {
      c1 = { x: a.x + a.cRx, y: a.y + a.cRy };
      c2 = { x: b.x + b.cLx, y: b.y + b.cLy };
    } else {
      // one handle = quadratic; degree-elevate to cubic
      var q = oh ? { x: a.x + a.cRx, y: a.y + a.cRy } : { x: b.x + b.cLx, y: b.y + b.cLy };
      c1 = { x: a.x + (2 / 3) * (q.x - a.x), y: a.y + (2 / 3) * (q.y - a.y) };
      c2 = { x: b.x + (2 / 3) * (q.x - b.x), y: b.y + (2 / 3) * (q.y - b.y) };
    }
    return { c1: c1, c2: c2 };
  }

  function cubicAt(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  function lerp(p, q, t) {
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  }

  function segD(a, b) {
    var c = segCubic(a, b);
    if (!c) return "L" + fmt(b.x) + " " + fmt(b.y);
    return "C" + fmt(c.c1.x) + " " + fmt(c.c1.y) + " " + fmt(c.c2.x) + " " + fmt(c.c2.y) +
      " " + fmt(b.x) + " " + fmt(b.y);
  }

  // Sub-shapes of a path: the primary outline plus any extra rings (holes or
  // separate islands left by a boolean merge). Extra rings are always closed.
  function subpaths(path) {
    var out = [path], rings = path.rings || [], i;
    for (i = 0; i < rings.length; i++) out.push({ points: rings[i], closed: true });
    return out;
  }
  R.subpaths = subpaths;

  // SVG path "d" for one sub-shape.
  function ringD(path) {
    var pts = path.points;
    if (!pts || pts.length === 0) return "";
    var d = "M" + fmt(pts[0].x) + " " + fmt(pts[0].y);
    var i;
    for (i = 1; i < pts.length; i++) d += segD(pts[i - 1], pts[i]);
    if (path.closed && pts.length > 1) d += segD(pts[pts.length - 1], pts[0]);
    if (path.closed) d += "Z";
    return d;
  }

  // SVG path "d" for a path object, covering all of its rings.
  function pathD(path) {
    var subs = subpaths(path), d = "", k;
    for (k = 0; k < subs.length; k++) d += ringD(subs[k]);
    return d;
  }

  function sampleSegment(out, a, b, steps) {
    var c = segCubic(a, b), k;
    if (!c) {
      out.push({ x: b.x, y: b.y });
      return;
    }
    for (k = 1; k <= steps; k++) out.push(cubicAt(a, c.c1, c.c2, b, k / steps));
  }

  // Polyline approximation of a path. Closed paths end on their first point.
  // Only the primary outline; see flattenAll for every ring.
  function flatten(path, steps) {
    steps = steps > 0 ? steps : STEPS;
    var pts = path.points, out = [], i;
    if (!pts || pts.length === 0) return out;
    out.push({ x: pts[0].x, y: pts[0].y });
    var segs = path.closed ? pts.length : pts.length - 1;
    for (i = 0; i < segs; i++) sampleSegment(out, pts[i], pts[(i + 1) % pts.length], steps);
    if (path.closed && pts.length > 1) out.push({ x: pts[0].x, y: pts[0].y });
    return out;
  }

  function distSq(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    var qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }

  /* ---------- node editing helpers ---------- */

  R.pathD = pathD;
  R.flattenAll = flattenAll;
  R.subpaths = subpaths;
  R.flatten = flatten;

  // Midpoint of segment i (i -> i+1, wrapping on closed paths).
  R.pointAtSegMid = function (path, i) {
    var pts = path.points, n = pts.length;
    if (n < 2) return null;
    var last = path.closed ? n - 1 : n - 2;
    if (i < 0 || i > last) return null;
    var a = pts[i], b = pts[(i + 1) % n];
    var c = segCubic(a, b);
    if (!c) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return cubicAt(a, c.c1, c.c2, b, 0.5);
  };

  // Point at parameter t on a -> b. Straight segments use linear t, matching splitSegment.
  function segPoint(a, b, c, t) {
    return c ? cubicAt(a, c.c1, c.c2, b, t) : lerp(a, b, t);
  }

  // Nearest point on segment a -> b to (x, y), refined past the sampling grid.
  function nearestOnSegment(a, b, x, y) {
    var c = segCubic(a, b), steps = 48, best = null, k, t, p, d2, j;
    for (k = 0; k <= steps; k++) {
      t = k / steps;
      p = segPoint(a, b, c, t);
      d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (!best || d2 < best.d2) best = { t: t, x: p.x, y: p.y, d2: d2 };
    }
    var step = 1 / steps;
    for (var r = 0; r < 24; r++) {
      for (j = -1; j <= 1; j += 2) {
        t = Math.max(0, Math.min(1, best.t + j * step));
        p = segPoint(a, b, c, t);
        d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d2 < best.d2) best = { t: t, x: p.x, y: p.y, d2: d2 };
      }
      step /= 2;
    }
    return best;
  }

  // What a node-tool pointer at (x, y) grabs, by priority: a visible handle tip,
  // then an anchor, then the nearest point on a curve within tol. A handle shorter
  // than tol sits under its anchor, so it is never grabbed on its own.
  // Returns {kind:"handle", index, side} | {kind:"anchor", index} |
  //         {kind:"segment", index, t, x, y} | null.
  R.nodeTargetAt = function (path, x, y, tol) {
    var pts = path.points, n = pts.length, i, p;
    if (!n) return null;
    function near(px, py) { return Math.sqrt((px - x) * (px - x) + (py - y) * (py - y)) <= tol; }
    function longer(vx, vy) { return Math.sqrt(vx * vx + vy * vy) > tol; }

    for (i = 0; i < n; i++) {
      p = pts[i];
      if (longer(p.cLx, p.cLy) && near(p.x + p.cLx, p.y + p.cLy)) return { kind: "handle", index: i, side: "L" };
      if (longer(p.cRx, p.cRy) && near(p.x + p.cRx, p.y + p.cRy)) return { kind: "handle", index: i, side: "R" };
    }
    for (i = 0; i < n; i++) {
      if (near(pts[i].x, pts[i].y)) return { kind: "anchor", index: i };
    }
    if (n < 2) return null;
    var segs = path.closed ? n : n - 1, best = null, s;
    for (i = 0; i < segs; i++) {
      s = nearestOnSegment(pts[i], pts[(i + 1) % n], x, y);
      if (s.d2 <= tol * tol && (!best || s.d2 < best.d2)) best = { kind: "segment", index: i, t: s.t, x: s.x, y: s.y, d2: s.d2 };
    }
    if (!best) return null;
    delete best.d2;
    return best;
  };

  // Split segment a -> b at parameter t without changing its shape.
  // Returns the new anchor and the new handle vectors for a (aOut) and b (bIn).
  R.splitSegment = function (a, b, t) {
    var c = segCubic(a, b);
    if (!c) {
      var m = lerp(a, b, t);
      return {
        point: { x: m.x, y: m.y, cLx: 0, cLy: 0, cRx: 0, cRy: 0 },
        aOut: { x: 0, y: 0 },
        bIn: { x: 0, y: 0 }
      };
    }
    var q0 = lerp(a, c.c1, t), q1 = lerp(c.c1, c.c2, t), q2 = lerp(c.c2, b, t);
    var r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
    var s = lerp(r0, r1, t);
    return {
      point: { x: s.x, y: s.y, cLx: r0.x - s.x, cLy: r0.y - s.y, cRx: r1.x - s.x, cRy: r1.y - s.y },
      aOut: { x: q0.x - a.x, y: q0.y - a.y },
      bIn: { x: q2.x - b.x, y: q2.y - b.y }
    };
  };

  // Handles that make point i smooth, following its neighbours (Catmull-Rom).
  R.smoothHandles = function (points, i, closed) {
    var n = points.length, p = points[i];
    var prev = null, next = null;
    if (closed && n > 2) {
      prev = points[(i - 1 + n) % n];
      next = points[(i + 1) % n];
    } else {
      prev = i > 0 ? points[i - 1] : null;
      next = i < n - 1 ? points[i + 1] : null;
    }
    if (prev && next) {
      var tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
      return { cLx: -tx, cLy: -ty, cRx: tx, cRy: ty };
    }
    if (next) {
      return { cLx: 0, cLy: 0, cRx: (next.x - p.x) / 3, cRy: (next.y - p.y) / 3 };
    }
    if (prev) {
      return { cLx: (prev.x - p.x) / 3, cLy: (prev.y - p.y) / 3, cRx: 0, cRy: 0 };
    }
    return { cLx: 0, cLy: 0, cRx: 0, cRy: 0 };
  };

  /* ---------- bounds and hit tests ---------- */

  // One polyline per sub-shape (see subpaths).
  function flattenAll(path, steps) {
    var subs = subpaths(path), out = [], k;
    for (k = 0; k < subs.length; k++) out.push(flatten(subs[k], steps));
    return out;
  }

  R.bbox = function (path, includeStroke) {
    var polys = flattenAll(path), minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, i, k, poly;
    var any = false;
    for (k = 0; k < polys.length; k++) {
      poly = polys[k];
      for (i = 0; i < poly.length; i++) {
        any = true;
        if (poly[i].x < minx) minx = poly[i].x;
        if (poly[i].x > maxx) maxx = poly[i].x;
        if (poly[i].y < miny) miny = poly[i].y;
        if (poly[i].y > maxy) maxy = poly[i].y;
      }
    }
    if (!any) return null;
    if (includeStroke && path.stroke && path.stroke.width > 0) {
      var pad = path.stroke.width / 2;
      minx -= pad; miny -= pad; maxx += pad; maxy += pad;
    }
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  };


  // Union bounds of the paths in layer `L` whose ids are in `ids`.
  R.selectionBounds = function (L, ids, includeStroke) {
    if (!L || !ids || !ids.length) return null;
    var res = null;
    for (var i = 0; i < L.paths.length; i++) {
      if (ids.indexOf(L.paths[i].id) < 0) continue;
      var b = R.bbox(L.paths[i], includeStroke);
      if (!b) continue;
      if (!res) {
        res = { x: b.x, y: b.y, w: b.w, h: b.h };
      } else {
        var x1 = Math.max(res.x + res.w, b.x + b.w), y1 = Math.max(res.y + res.h, b.y + b.h);
        res.x = Math.min(res.x, b.x);
        res.y = Math.min(res.y, b.y);
        res.w = x1 - res.x;
        res.h = y1 - res.y;
      }
    }
    return res;
  };

  // True when (px,py) is within `tol` of any stroke outline.
  R.hitTestPoint = function (px, py, path, tol) {
    var polys = flattenAll(path), t2 = tol * tol, i, k, poly, n;
    for (k = 0; k < polys.length; k++) {
      poly = polys[k];
      n = poly.length;
      if (n === 1) {
        var dx = px - poly[0].x, dy = py - poly[0].y;
        if (dx * dx + dy * dy <= t2) return true;
      }
      for (i = 0; i < n - 1; i++) {
        if (distSq(px, py, poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y) <= t2) return true;
      }
    }
    return false;
  };

  // Even-odd point-in-shape test across all rings, so holes come out empty
  // (open paths are closed implicitly, as in SVG).
  R.hitsPoint = function (path, x, y) {
    var polys = flattenAll(path), inside = false, k, poly, n, i, j;
    for (k = 0; k < polys.length; k++) {
      poly = polys[k];
      n = poly.length;
      if (n < 3) continue;
      for (i = 0, j = n - 1; i < n; j = i++) {
        var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };


  // Topmost path under (x,y) in paint order: higher layers and paths win, and
  // within one path the outline is painted over its own fill.
  R.topHit = function (doc, x, y, tol, layerId) {
    var layers = doc.layers, i, j, L, p;
    for (i = layers.length - 1; i >= 0; i--) {
      L = layers[i];
      if (!L.visible || L.locked || (layerId && L.id !== layerId)) continue;
      for (j = L.paths.length - 1; j >= 0; j--) {
        p = L.paths[j];
        if (p.stroke && p.stroke.opacity > 0 && p.stroke.width > 0 && R.hitTestPoint(x, y, p, tol)) {
          return { layerId: L.id, path: p };
        }
        if (p.fill && p.fill.kind !== "none" && p.fill.opacity > 0 && R.hitsPoint(p, x, y)) {
          return { layerId: L.id, path: p };
        }
      }
    }
    return null;
  };

  // Topmost path a click lands on: an outline (any stroke width) or the inside
  // of a closed shape. The fill and outline tools use this, so they also work
  // on shapes that have no fill yet.
  R.pickShape = function (doc, x, y, tol, layerId) {
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      var L = doc.layers[i];
      if (!L.visible || L.locked || (layerId && L.id !== layerId)) continue;
      for (var j = L.paths.length - 1; j >= 0; j--) {
        var p = L.paths[j];
        if (R.hitTestPoint(x, y, p, tol) || (p.closed && R.hitsPoint(p, x, y))) {
          return { layerId: L.id, path: p };
        }
      }
    }
    return null;
  };

  /* ---------- SVG building ---------- */

  // Dash array for a pattern at stroke width w (null = solid).
  R.dashArray = function (pattern, w) {
    if (!pattern || !(w > 0)) return null;
    if (pattern === "dash") return fmt(w * 3) + "," + fmt(w * 2);
    if (pattern === "dot") return "0.01," + fmt(w * 2);
    if (pattern === "dashdot") return fmt(w * 3) + "," + fmt(w) + ",0.01," + fmt(w);
    return null;
  };

  // Linear gradients for gradient fills, one per path id.
  R.buildDefs = function (defsG, doc, prefix) {
    clear(defsG);
    for (var i = 0; i < doc.layers.length; i++) {
      var paths = doc.layers[i].paths;
      for (var j = 0; j < paths.length; j++) {
        var p = paths[j];
        if (p.fill.kind !== "gradient" || !p.fill.gradient) continue;
        var gd = p.fill.gradient;
        var lg = el("linearGradient", {
          id: prefix + "grad_" + p.id, gradientUnits: "userSpaceOnUse",
          x1: num(gd.x1), y1: num(gd.y1), x2: num(gd.x2), y2: num(gd.y2)
        });
        var stops = gd.stops || [];
        for (var k = 0; k < stops.length; k++) {
          lg.appendChild(el("stop", {
            offset: stops[k].offset, "stop-color": stops[k].color, "stop-opacity": stops[k].opacity
          }));
        }
        defsG.appendChild(lg);
      }
    }
  };

  function pathElement(p, layerId, prefix) {
    var fill = p.fill, st = p.stroke;
    var a = { d: pathD(p), "data-path-id": p.id, "data-layer-id": layerId };
    if (fill.kind === "gradient" && fill.gradient) a.fill = "url(#" + prefix + "grad_" + p.id + ")";
    else if (fill.kind === "color") a.fill = fill.color;
    else a.fill = "none";
    a["fill-opacity"] = fill.opacity;
    a["fill-rule"] = "evenodd";
    a.stroke = st.color;
    a["stroke-width"] = st.width;
    a["stroke-opacity"] = st.opacity;
    a["stroke-linecap"] = st.cap;
    a["stroke-linejoin"] = st.join;
    var pattern = p.dash && p.dash.pattern;
    var dash = R.dashArray(pattern, st.width);
    if (dash) {
      a["stroke-dasharray"] = dash;
      if (pattern === "dot") a["stroke-linecap"] = "round";
    }
    return el("path", a);
  }

  // Painter's order: layers bottom to top, paths in array order.
  function buildLayers(container, doc, prefix) {
    for (var i = 0; i < doc.layers.length; i++) {
      var L = doc.layers[i];
      if (!L.visible) continue;
      var g = el("g", { "data-layer-id": L.id, opacity: L.opacity == null ? 1 : L.opacity });
      for (var j = 0; j < L.paths.length; j++) g.appendChild(pathElement(L.paths[j], L.id, prefix));
      container.appendChild(g);
    }
  }

  // The icon's artboard: white with a transparency checkerboard, so colours
  // and see-through areas are both visible.
  // bg: "checker" (default), "light" or "dark", to test the icon on both.
  function buildArtboard(artG, doc, zoom, bg) {
    clear(artG);
    var size = doc.size;
    if (bg === "light" || bg === "dark") {
      artG.appendChild(el("rect", { x: 0, y: 0, width: size, height: size, fill: bg === "light" ? "#ffffff" : "#1a1a1a" }));
      artG.appendChild(el("rect", {
        x: 0, y: 0, width: size, height: size, fill: "none",
        stroke: "rgba(127,127,127,0.55)", "stroke-width": 1 / zoom
      }));
      return;
    }
    var cell = zoom >= 6 ? 1 : zoom >= 3 ? 2 : 4;
    var defs = el("defs", {});
    var pat = el("pattern", { id: "im-checker", width: cell * 2, height: cell * 2, patternUnits: "userSpaceOnUse" });
    pat.appendChild(el("rect", { x: 0, y: 0, width: cell * 2, height: cell * 2, fill: "#ffffff" }));
    pat.appendChild(el("rect", { x: 0, y: 0, width: cell, height: cell, fill: "#e3e3e3" }));
    pat.appendChild(el("rect", { x: cell, y: cell, width: cell, height: cell, fill: "#e3e3e3" }));
    defs.appendChild(pat);
    artG.appendChild(defs);
    artG.appendChild(el("rect", { x: 0, y: 0, width: size, height: size, fill: "url(#im-checker)" }));
    artG.appendChild(el("rect", {
      x: 0, y: 0, width: size, height: size, fill: "none",
      stroke: "rgba(127,127,127,0.55)", "stroke-width": 1 / zoom
    }));
  }

  // Pixel grid: lines at whole units, stronger every 4 units, never closer than 3 screen px.
  function buildGrid(gridG, doc, zoom) {
    clear(gridG);
    var size = doc.size, sw = 1 / zoom, step = 1;
    while (zoom * step < 3 && step < size) step *= 2;
    if (zoom * step >= 3) {
      for (var i = 0; i <= size; i += step) {
        var col = i % 4 === 0 ? "rgba(127,127,127,0.45)" : "rgba(127,127,127,0.22)";
        gridG.appendChild(el("line", { x1: i, y1: 0, x2: i, y2: size, stroke: col, "stroke-width": sw }));
        gridG.appendChild(el("line", { x1: 0, y1: i, x2: size, y2: i, stroke: col, "stroke-width": sw }));
      }
    }
  }

  /* ---------- entry points ---------- */

  // ctx = { worldG, artG, defsG, gridG, layersG }. worldG carries the view
  // transform. The overlay group is owned by overlay.js and left alone.
  R.renderDoc = function (ctx, doc, view, opts) {
    var zoom = view && view.zoom > 0 ? view.zoom : 1;
    var panX = view && view.panX ? view.panX : 0;
    var panY = view && view.panY ? view.panY : 0;
    if (ctx.worldG) {
      ctx.worldG.setAttribute("transform", "translate(" + num(panX) + "," + num(panY) + ") scale(" + num(zoom) + ")");
    }
    if (ctx.defsG) R.buildDefs(ctx.defsG, doc, "");
    if (ctx.artG) buildArtboard(ctx.artG, doc, zoom, opts && opts.bg);
    if (ctx.gridG) buildGrid(ctx.gridG, doc, zoom);
    if (ctx.layersG) {
      clear(ctx.layersG);
      buildLayers(ctx.layersG, doc, "");
    }
  };

  // Standalone SVG at 1:1 (or `scale` times) used by the preview, thumbnails
  // and mini previews. A stable per-root prefix keeps gradient ids unique.
  var previewSeq = 0;
  R.renderPreview = function (svgRoot, doc, scale) {
    if (!svgRoot || !doc) return;
    scale = scale > 0 ? scale : 1;
    clear(svgRoot);
    var prefix = svgRoot.getAttribute("data-grad-ns");
    if (!prefix) {
      previewSeq += 1;
      prefix = "pv" + previewSeq + "_";
      svgRoot.setAttribute("data-grad-ns", prefix);
    }
    var defs = el("defs", {});
    R.buildDefs(defs, doc, prefix);
    svgRoot.appendChild(defs);
    var g = el("g", {});
    buildLayers(g, doc, prefix);
    svgRoot.appendChild(g);
    svgRoot.setAttribute("viewBox", "0 0 " + doc.size + " " + doc.size);
    var dim = Math.round(doc.size * scale);
    svgRoot.setAttribute("width", dim);
    svgRoot.setAttribute("height", dim);
  };
})();
