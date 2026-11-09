/* Boolean merges of closed shapes: Union, Subtract, Intersect and Exclude.
 * Geometry comes from PolyBool (vendor/polybool.min.js), so results are
 * polygons: curves are sampled into short straight segments. Attaches IM.Merge.
 * No DOM access.
 */
(function () {
  "use strict";
  var IM = window.IM;
  var MAX_POINTS = 20000;
  var SAMPLES = 24;               // samples per curve segment before merging
  var FOLD = {
    union: "union",
    intersect: "intersect",
    exclude: "xor",               // symmetric difference
    subtract: "difference"        // base minus everything after it
  };

  function round2(v) { return Math.round(v * 100) / 100; }

  // Closed shape -> PolyBool regions, one per ring, without the repeated closing point.
  function regionsOf(path) {
    var polys = IM.Renderer.flattenAll(path, SAMPLES), out = [], k, i;
    for (k = 0; k < polys.length; k++) {
      var poly = polys[k], n = poly.length;
      if (n > 1 && poly[0].x === poly[n - 1].x && poly[0].y === poly[n - 1].y) n--;
      var reg = [];
      for (i = 0; i < n; i++) reg.push([poly[i].x, poly[i].y]);
      if (reg.length >= 3) out.push(reg);
    }
    return out;
  }

  function polyOf(path) {
    return { regions: regionsOf(path), inverted: false };
  }

  // Why the selection cannot be merged, or null when it can.
  function problemOf(paths) {
    if (paths.length < 2) return "Select two or more shapes to merge";
    for (var i = 0; i < paths.length; i++) {
      if (!paths[i].closed) return "Only closed shapes can be merged";
    }
    return null;
  }

  // Signed shoelace area of a PolyBool region.
  function areaOf(reg) {
    var a = 0;
    for (var i = 0; i < reg.length; i++) {
      var p = reg[i], q = reg[(i + 1) % reg.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  /* ---------- curve refit ----------
   * PolyBool only returns straight edges, so each ring is refit into cubic
   * Béziers (Schneider's algorithm). Sharp corners stay as anchors, straight
   * runs stay straight, and smooth runs become handles again.
   */
  var FIT_TOL = 0.1;                       // max deviation in document units
  var FIT_TOL2 = FIT_TOL * FIT_TOL;
  var CORNER_COS = Math.cos(40 * Math.PI / 180);

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function scale(a, k) { return { x: a.x * k, y: a.y * k }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a, fallback) {
    var l = len(a);
    return l > 1e-12 ? scale(a, 1 / l) : fallback;
  }

  function bezAt(B, t) {
    var m = 1 - t, a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    return { x: a * B[0].x + b * B[1].x + c * B[2].x + d * B[3].x,
             y: a * B[0].y + b * B[1].y + c * B[2].y + d * B[3].y };
  }

  function bezTangents(B, t) {
    var m = 1 - t;
    var d1 = add(add(scale(sub(B[1], B[0]), 3 * m * m), scale(sub(B[2], B[1]), 6 * m * t)),
                 scale(sub(B[3], B[2]), 3 * t * t));
    var d2 = add(scale(add(sub(B[2], scale(B[1], 2)), B[0]), 6 * m),
                 scale(add(sub(B[3], scale(B[2], 2)), B[1]), 6 * t));
    return { d1: d1, d2: d2 };
  }

  function chordParams(d) {
    var u = [0], i;
    for (i = 1; i < d.length; i++) u[i] = u[i - 1] + len(sub(d[i], d[i - 1]));
    var total = u[u.length - 1] || 1;
    for (i = 0; i < u.length; i++) u[i] /= total;
    return u;
  }

  // Least-squares cubic through d with fixed end tangents (Schneider).
  function genBezier(d, u, t1, t2) {
    var n = d.length, d0 = d[0], dn = d[n - 1];
    var C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0, i;
    for (i = 0; i < n; i++) {
      var t = u[i], m = 1 - t;
      var b0 = m * m * m, b1 = 3 * t * m * m, b2 = 3 * t * t * m, b3 = t * t * t;
      var A0 = scale(t1, b1), A1 = scale(t2, b2);
      C00 += dot(A0, A0); C01 += dot(A0, A1); C11 += dot(A1, A1);
      var tmp = sub(d[i], add(scale(d0, b0 + b1), scale(dn, b2 + b3)));
      X0 += dot(A0, tmp); X1 += dot(A1, tmp);
    }
    var segLen = len(sub(dn, d0));
    var det = C00 * C11 - C01 * C01;
    var alL = 0, alR = 0;
    if (Math.abs(det) > 1e-12) {
      alL = (X0 * C11 - X1 * C01) / det;
      alR = (C00 * X1 - C01 * X0) / det;
    }
    if (!(alL > 1e-6 * segLen) || !(alR > 1e-6 * segLen)) {
      alL = segLen / 3; alR = segLen / 3;
    }
    return [d0, add(d0, scale(t1, alL)), add(dn, scale(t2, alR)), dn];
  }

  // Largest squared deviation of the curve from its points, and where it is.
  function worstPoint(d, B, u) {
    var worst = -1, split = Math.floor(d.length / 2), i;
    for (i = 1; i < d.length - 1; i++) {
      var e = sub(bezAt(B, u[i]), d[i]), dd = dot(e, e);
      if (dd > worst) { worst = dd; split = i; }
    }
    return { err: worst, split: split };
  }

  // One Newton step per point to better match parameters to the curve.
  function reparam(d, B, u) {
    var out = [], i;
    for (i = 0; i < d.length; i++) {
      var t = u[i], t2 = bezTangents(B, t), diff = sub(bezAt(B, t), d[i]);
      var num = dot(diff, t2.d1), den = dot(t2.d1, t2.d1) + dot(diff, t2.d2);
      var next = den !== 0 ? t - num / den : t;
      out.push(Math.min(1, Math.max(0, next)));
    }
    out[0] = 0; out[out.length - 1] = 1;
    return out;
  }

  // Fits cubics through d (array of points) with end tangents t1 (into the
  // curve at the start) and t2 (into the curve at the end). Appends to `out`.
  function fitCurve(d, t1, t2, out) {
    var n = d.length;
    if (n === 2) {
      var k = len(sub(d[1], d[0])) / 3;
      out.push([d[0], add(d[0], scale(t1, k)), add(d[1], scale(t2, k)), d[1]]);
      return;
    }
    var u = chordParams(d), B = genBezier(d, u, t1, t2), w = worstPoint(d, B, u);
    if (w.err < FIT_TOL2) { out.push(B); return; }
    if (w.err < FIT_TOL2 * 16) {
      for (var iter = 0; iter < 20; iter++) {
        u = reparam(d, B, u);
        B = genBezier(d, u, t1, t2);
        w = worstPoint(d, B, u);
        if (w.err < FIT_TOL2) { out.push(B); return; }
      }
    }
    var s = w.split, tc = unit(sub(d[s - 1], d[s + 1]), unit(sub(d[n - 1], d[0]), { x: 1, y: 0 }));
    fitCurve(d.slice(0, s + 1), t1, tc, out);
    fitCurve(d.slice(s), scale(tc, -1), t2, out);
  }

  // Segments {a, c1, c2, b} for the loop of points `pts`. c1/c2 are null for straight edges.
  function loopSegments(pts) {
    var n = pts.length, corners = [], i, segs = [];
    for (i = 0; i < n; i++) {
      var e1 = sub(pts[i], pts[(i - 1 + n) % n]), e2 = sub(pts[(i + 1) % n], pts[i]);
      if (dot(e1, e2) / (len(e1) * len(e2)) < CORNER_COS) corners.push(i);
    }
    var runs = [];
    if (corners.length === 0) {
      runs.push({ start: 0, steps: n });
    } else {
      for (i = 0; i < corners.length; i++) {
        var from = corners[i], to = corners[(i + 1) % corners.length];
        var steps = (to - from + n) % n || n;
        runs.push({ start: from, steps: steps });
      }
    }
    runs.forEach(function (run) {
      var Q = [], k;
      for (k = 0; k <= run.steps; k++) Q.push(pts[(run.start + k) % n]);
      if (isStraight(Q)) {
        segs.push({ a: Q[0], c1: null, c2: null, b: Q[Q.length - 1] });
        return;
      }
      var curves = [], t1, t2;
      if (corners.length === 0) {
        // A smooth closed loop: one shared tangent keeps the start joint collinear.
        var tStart = unit(sub(pts[1 % n], pts[n - 1]), { x: 1, y: 0 });
        t1 = tStart; t2 = scale(tStart, -1);
      } else {
        t1 = unit(sub(Q[1], Q[0]), { x: 1, y: 0 });
        t2 = unit(sub(Q[Q.length - 2], Q[Q.length - 1]), { x: -1, y: 0 });
      }
      fitCurve(Q, t1, t2, curves);
      curves.forEach(function (B) { segs.push({ a: B[0], c1: B[1], c2: B[2], b: B[3] }); });
    });
    return segs;
  }

  function isStraight(Q) {
    var a = Q[0], b = Q[Q.length - 1], ab = sub(b, a), L = len(ab), i;
    for (i = 1; i < Q.length - 1; i++) {
      var ap = sub(Q[i], a), t = L > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / (L * L))) : 0;
      var proj = add(a, scale(ab, t));
      if (len(sub(Q[i], proj)) > FIT_TOL) return false;
    }
    return true;
  }

  // Region (PolyBool points) -> ring of anchors with handles. Falls back to
  // the plain polyline if the refit yields fewer than three anchors.
  function ringPoints(reg) {
    var pts = [], i;
    for (i = 0; i < reg.length; i++) {
      var p = { x: reg[i][0], y: reg[i][1] };
      var last = pts[pts.length - 1];
      if (!last || len(sub(p, last)) > 1e-9) pts.push(p);
    }
    while (pts.length > 1 && len(sub(pts[0], pts[pts.length - 1])) <= 1e-9) pts.pop();
    if (pts.length < 3) return [];
    var segs = loopSegments(pts), n = segs.length, out = [];
    for (i = 0; i < n; i++) {
      var a = segs[i].a, prev = segs[(i - 1 + n) % n];
      var pt = { x: round2(a.x), y: round2(a.y), cLx: 0, cLy: 0, cRx: 0, cRy: 0 };
      if (segs[i].c1) { pt.cRx = round2(segs[i].c1.x - a.x); pt.cRy = round2(segs[i].c1.y - a.y); }
      if (prev.c2) { pt.cLx = round2(prev.c2.x - a.x); pt.cLy = round2(prev.c2.y - a.y); }
      out.push(pt);
    }
    var curved = out.some(function (p) { return p.cRx || p.cRy || p.cLx || p.cLy; });
    if (out.length >= 3 || (out.length >= 2 && curved)) return out;
    return pts.map(function (p) {
      return { x: round2(p.x), y: round2(p.y), cLx: 0, cLy: 0, cRx: 0, cRy: 0 };
    });
  }

  // Merges `shapes` (closed paths, back-most first) with `kind`. Returns
  // { path } with the result, or { empty: true } / { tooLarge: true }.
  function run(kind, shapes, id) {
    var PB = window.PolyBool;
    if (!PB) throw new Error("PolyBool is not loaded");
    var fn = PB[FOLD[kind]];
    if (!fn) throw new Error("Unknown merge: " + kind);
    var acc = polyOf(shapes[0]), i;
    for (i = 1; i < shapes.length; i++) acc = fn(acc, polyOf(shapes[i]));

    var regs = acc.regions.filter(function (r) { return r.length >= 3; });
    if (regs.length === 0) return { empty: true };
    var total = 0;
    for (i = 0; i < regs.length; i++) total += regs[i].length;
    if (total > MAX_POINTS) return { tooLarge: true };
    // Largest outline first, so the primary ring is the outer boundary, not a hole.
    regs.sort(function (a, b) { return Math.abs(areaOf(b)) - Math.abs(areaOf(a)); });

    var rings = regs.map(ringPoints).filter(function (r) { return r.length >= 2; });
    if (rings.length === 0) return { empty: true };
    var base = shapes[0], path = {
      id: id,
      closed: true,
      points: rings[0],
      fill: IM.Model.clone(base.fill),
      stroke: IM.Model.clone(base.stroke),
      dash: base.dash ? IM.Model.clone(base.dash) : null
    };
    if (rings.length > 1) path.rings = rings.slice(1);
    return { path: path };
  }

  // Undoable op that swaps the `sources` in layer `L` for `result`. The result
  // takes the place of the back-most source, which is the first in the layer.
  function replaceOp(L, sources, result) {
    var before = [], i;
    for (i = 0; i < L.paths.length; i++) {
      if (sources.indexOf(L.paths[i].id) >= 0) {
        before.push({ index: i, path: IM.Model.clone(L.paths[i]) });
      }
    }
    return {
      type: "replace",
      layerId: L.id,
      before: before,
      after: [{ index: before[0].index, path: IM.Model.clone(result) }]
    };
  }

  IM.Merge = {
    problemOf: problemOf,
    run: run,
    replaceOp: replaceOp,
    regionsOf: regionsOf
  };
})();
