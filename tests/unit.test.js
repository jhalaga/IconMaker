/* IconMaker unit tests â€” no dependencies. Run with:  node tests/unit.test.js
 * Loads the real browser modules into a sandbox (no DOM) and checks the document
 * model, undo/redo, geometry, snapping, project validation and the tools' edits
 * through a small stand-in for the app shell.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const ctx = vm.createContext({ console, Math, JSON, Date, Array, Object, Number, String });
ctx.window = ctx;
for (const f of ["model.js", "renderer.js", "snapping.js", "overlay.js", "io.js", "vendor/polybool.min.js", "merge.js", "tools.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}
const IM = ctx.IM;
const M = IM.Model, R = IM.Renderer;

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(name + ": " + (err && err.message ? err.message : err));
    console.log("not ok  " + name + "\n      " + (err && err.message ? err.message : err));
    return;
  }
  console.log("ok      " + name);
}
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((msg || "values differ") + "\n      got      " + x + "\n      expected " + y);
}
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps || 1e-6)) throw new Error((msg || "not close") + ": " + a + " vs " + b);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

/* ---------- fixtures ---------- */

function docWith(paths) {
  const doc = M.newDoc(32);
  doc.layers[0].paths = paths || [];
  return doc;
}
function basePath(points, closed) {
  const p = M.makePath(closed);
  p.points = points;
  return p;
}
function samplePath(path, steps) {
  return R.flatten(path, steps || 32);
}
function maxDeviation(a, b) {
  // max distance from points of a to the polyline b
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (let i = 0; i < b.length - 1; i++) {
      const ax = b[i].x, ay = b[i].y, bx = b[i + 1].x, by = b[i + 1].y;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx - p.x, qy = ay + t * dy - p.y;
      best = Math.min(best, Math.sqrt(qx * qx + qy * qy));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/* ---------- model: operations and undo ---------- */

test("add then undo restores the layer", () => {
  const doc = docWith([]);
  const h = new M.History(doc);
  const L = doc.layers[0];
  const p = basePath([M.pt(1, 1), M.pt(5, 5)]);
  const op = { type: "add", layerId: L.id, index: 0, path: p };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(L.paths.length, 1);
  h.undo();
  eq(L.paths.length, 0, "undo should remove the path");
  h.redo();
  eq(L.paths.length, 1);
  eq(L.paths[0].id, p.id);
});

test("zorder undo puts the path back (regression: undo used to remove the wrong path)", () => {
  const a = basePath([M.pt(0, 0)]), b = basePath([M.pt(1, 1)]), c = basePath([M.pt(2, 2)]);
  const doc = docWith([a, b, c]);
  const h = new M.History(doc);
  const L = doc.layers[0];
  const op = { type: "zorder", layerId: L.id, from: 0, to: 2 };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(L.paths.map((p) => p.id), [b.id, c.id, a.id], "after forward");
  h.undo();
  eq(L.paths.map((p) => p.id), [a.id, b.id, c.id], "after undo");
  h.redo();
  eq(L.paths.map((p) => p.id), [b.id, c.id, a.id], "after redo");
});

test("moving a path to another layer undoes and redoes exactly once (regression: path-layer applied twice)", () => {
  const p1 = basePath([M.pt(0, 0)]), p2 = basePath([M.pt(9, 9)]);
  const doc = M.newDoc(32);
  const top = M.makeLayer("Top");
  doc.layers[0].paths = [p1, p2];
  doc.layers.push(top);
  const h = new M.History(doc);
  const src = doc.layers[0];
  const op = { type: "path-layer", fromLayerId: src.id, toLayerId: top.id, id: p1.id, fromIndex: 0, index: 0 };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(src.paths.map((p) => p.id), [p2.id]);
  eq(top.paths.map((p) => p.id), [p1.id]);
  h.undo();
  eq(src.paths.map((p) => p.id), [p1.id, p2.id], "source restored in order");
  eq(top.paths.length, 0, "target emptied");
  h.redo();
  eq(src.paths.map((p) => p.id), [p2.id]);
  eq(top.paths.map((p) => p.id), [p1.id]);
});

test("layer reorder undo/redo", () => {
  const doc = M.newDoc(32);
  doc.layers.push(M.makeLayer("B"), M.makeLayer("C"));
  const ids = doc.layers.map((l) => l.id);
  const h = new M.History(doc);
  const op = { type: "layer-move", from: 0, to: 2 };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(doc.layers.map((l) => l.id), [ids[1], ids[2], ids[0]]);
  h.undo();
  eq(doc.layers.map((l) => l.id), ids);
});

test("batch ops undo in reverse and redo in order", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0)]);
  const doc = docWith([p]);
  const L = doc.layers[0];
  const h = new M.History(doc);
  const batch = {
    type: "batch",
    ops: [
      { type: "move", layerId: L.id, ids: [p.id], dx: 3, dy: 0 },
      { type: "move", layerId: L.id, ids: [p.id], dx: 0, dy: 4 }
    ]
  };
  M.applyOp(doc, batch, true);
  h.push(batch);
  eq(p.points[0].x, 3);
  eq(p.points[0].y, 4);
  h.undo();
  eq(p.points[0].x, 0);
  eq(p.points[0].y, 0);
  h.redo();
  eq(p.points[1].x, 13);
});

test("move carries gradient coordinates with the shape (regression)", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10)], true);
  p.fill = { kind: "gradient", color: "#000000", opacity: 1, gradient: { x1: 0, y1: 0, x2: 10, y2: 10, stops: [{ offset: 0, color: "#000000", opacity: 1 }, { offset: 1, color: "#ffffff", opacity: 1 }] } };
  const doc = docWith([p]);
  const L = doc.layers[0];
  M.applyOp(doc, { type: "move", layerId: L.id, ids: [p.id], dx: 5, dy: 2 }, true);
  eq([p.fill.gradient.x1, p.fill.gradient.y1, p.fill.gradient.x2, p.fill.gradient.y2], [5, 2, 15, 12]);
});

test("bbox resize with keepStroke leaves line thickness alone", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0)], false);
  p.stroke.width = 4;
  const doc = docWith([p]);
  const L = doc.layers[0];
  const h = new M.History(doc);
  const s = { type: "scale", layerId: L.id, ids: [p.id], sx: 2, sy: 1, cx: 0, cy: 0, keepStroke: true };
  M.applyOp(doc, s, true);
  h.push(s);
  near(p.points[1].x, 20, 1e-9, "stretched");
  near(p.stroke.width, 4, 1e-9, "width unchanged by a one-axis stretch");
  h.undo();
  near(p.points[1].x, 10, 1e-9, "undo restores geometry");
  near(p.stroke.width, 4, 1e-9, "undo keeps width");
});

test("canvas-size scaling still scales stroke width uniformly", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0)], false);
  p.stroke.width = 4;
  const doc = docWith([p]);
  const copy = M.scaledCopy(doc, doc.size * 2);
  near(copy.layers[0].paths[0].stroke.width, 8, 1e-9, "uniform 2x scale doubles width");
});

test("scale and rotate ops invert exactly", () => {
  const p = basePath([M.pt(2, 3, -1, 0, 1, 2), M.pt(20, 6, 0, 0, 0, 0), M.pt(8, 25, 0, 3, 0, 0)], true);
  p.stroke.width = 2;
  const before = JSON.stringify(p);
  const doc = docWith([p]);
  const L = doc.layers[0];
  const h = new M.History(doc);
  const s = { type: "scale", layerId: L.id, ids: [p.id], sx: 1.7, sy: 0.6, cx: 2, cy: 3 };
  M.applyOp(doc, s, true);
  h.push(s);
  const r = { type: "rotate", layerId: L.id, ids: [p.id], angle: 33, cx: 5, cy: 5 };
  M.applyOp(doc, r, true);
  h.push(r);
  h.undo();
  h.undo();
  near(p.points[0].x, 2, 1e-9);
  near(p.points[2].y, 25, 1e-9);
  near(p.stroke.width, 2, 1e-9, "stroke width restored");
  const restored = JSON.parse(before);
  const now = JSON.parse(JSON.stringify(p));
  const flat = (o) => Object.keys(o).sort().reduce((acc, k) => acc.concat(typeof o[k] === "object" && o[k] !== null ? flat(o[k]) : [o[k]]), []);
  const a = flat(restored), b = flat(now);
  eq(a.length, b.length, "same shape of data");
  for (let i = 0; i < a.length; i++) {
    if (typeof a[i] === "number") near(b[i], a[i], 1e-9, "field " + i);
    else eq(b[i], a[i], "field " + i);
  }
});

test("node-move and node-handle store exact values for undo", () => {
  const p = basePath([M.pt(1, 1), M.pt(9, 9)]);
  const doc = docWith([p]);
  const L = doc.layers[0];
  const h = new M.History(doc);
  const from = { x: 1, y: 1, cLx: 0, cLy: 0, cRx: 0, cRy: 0 };
  const to = { x: 1.3333333, y: 0.7, cLx: 0, cLy: 0, cRx: 2.5, cRy: 0 };
  const op = { type: "node-move", layerId: L.id, id: p.id, index: 0, from, to };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(p.points[0], to);
  h.undo();
  eq(p.points[0], from);
});

test("size change scales geometry and undo restores it", () => {
  const p = basePath([M.pt(4, 8), M.pt(16, 16)]);
  const doc = docWith([p]);
  const h = new M.History(doc);
  const op = { type: "size", from: 32, to: 128 };
  M.applyOp(doc, op, true);
  h.push(op);
  eq(doc.size, 128);
  eq(p.points[0].x, 16);
  eq(p.points[1].y, 64);
  h.undo();
  eq(doc.size, 32);
  eq(p.points[0].x, 4);
});

test("history merges repeated nudges with the same key into one step", () => {
  const p = basePath([M.pt(0, 0)]);
  const doc = docWith([p]);
  const L = doc.layers[0];
  const h = new M.History(doc);
  for (let i = 0; i < 3; i++) {
    const op = { type: "move", layerId: L.id, ids: [p.id], dx: 1, dy: 0 };
    M.applyOp(doc, op, true);
    h.push(op, "nudge");
  }
  eq(p.points[0].x, 3);
  eq(h.stack.length, 1, "one undo step");
  h.undo();
  eq(p.points[0].x, 0);
});

test("history drops redo steps after a new change", () => {
  const doc = docWith([]);
  const h = new M.History(doc);
  const L = doc.layers[0];
  const a = { type: "add", layerId: L.id, index: 0, path: basePath([M.pt(0, 0)]) };
  const b = { type: "add", layerId: L.id, index: 1, path: basePath([M.pt(5, 5)]) };
  M.applyOp(doc, a, true); h.push(a);
  M.applyOp(doc, b, true); h.push(b);
  h.undo();
  ok(h.canRedo());
  const c = { type: "add", layerId: L.id, index: 1, path: basePath([M.pt(7, 7)]) };
  M.applyOp(doc, c, true); h.push(c);
  ok(!h.canRedo(), "redo should be cleared");
});

/* ---------- geometry ---------- */

test("one-handle segment is drawn where it is sampled (regression: wrong degree elevation)", () => {
  const a = M.pt(0, 0, 0, 0, 8, 0);          // quadratic with control (8,0)
  const b = M.pt(16, 0);
  const path = basePath([a, b]);
  // quadratic midpoint: (P0 + 2Q + P2)/4 = (0 + 16 + 16)/4 = 8 on x, y=0 ... use a bent case
  const bent = basePath([M.pt(0, 0, 0, 0, 4, 10), M.pt(16, 0)]);
  const d = R.pathD(bent);
  const m = /C([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/.exec(d);
  ok(m, "path data should be a cubic: " + d);
  const c1 = { x: +m[1], y: +m[2] }, c2 = { x: +m[3], y: +m[4] };
  // the quadratic midpoint at t=0.5 is 0.25*P0 + 0.5*Q + 0.25*P2
  const qx = 4, qy = 10;
  const quadMid = { x: 0.25 * 0 + 0.5 * qx + 0.25 * 16, y: 0.25 * 0 + 0.5 * qy + 0.25 * 0 };
  // cubic midpoint from the emitted control points
  const cubicMid = { x: (0 + 3 * c1.x + 3 * c2.x + 16) / 8, y: (0 + 3 * c1.y + 3 * c2.y + 0) / 8 };
  near(cubicMid.x, quadMid.x, 0.02, "x midpoint");
  near(cubicMid.y, quadMid.y, 0.02, "y midpoint");
  ok(path.points.length === 2);
});

test("pointAtSegMid lies on the sampled curve", () => {
  const path = basePath([M.pt(0, 0, 0, 0, 0, 12), M.pt(20, 0, -6, 6, 0, 0)]);
  const mid = R.pointAtSegMid(path, 0);
  const dev = maxDeviation([mid], samplePath(path, 64));
  ok(dev < 0.05, "midpoint off the curve by " + dev);
});

test("splitSegment keeps the curve shape exactly", () => {
  const a = M.pt(0, 0, 0, 0, 3, 14);
  const b = M.pt(24, 4, -5, 9, 0, 0);
  const sp = R.splitSegment(a, b, 0.5);
  const left = basePath([a, sp.point]);
  left.points[0] = { x: a.x, y: a.y, cLx: a.cLx, cLy: a.cLy, cRx: sp.aOut.x, cRy: sp.aOut.y };
  left.points[1] = sp.point;
  const right = basePath([sp.point, b]);
  right.points[1] = { x: b.x, y: b.y, cLx: sp.bIn.x, cLy: sp.bIn.y, cRx: b.cRx, cRy: b.cRy };
  const whole = samplePath(basePath([a, b]), 64);
  const parts = samplePath(left, 32).concat(samplePath(right, 32));
  const dev = maxDeviation(parts, whole);
  ok(dev < 0.02, "split curve deviates by " + dev);
  const dev2 = maxDeviation(whole, parts);
  ok(dev2 < 0.02, "reverse deviation " + dev2);
});

test("splitSegment on a straight line gives the midpoint with no handles", () => {
  const sp = R.splitSegment(M.pt(0, 0), M.pt(10, 10), 0.5);
  eq([sp.point.x, sp.point.y], [5, 5]);
  eq([sp.point.cLx, sp.point.cRx, sp.aOut.x, sp.bIn.y], [0, 0, 0, 0]);
});

test("nodeTargetAt: a handle tip beats the curve it belongs to", () => {
  const path = basePath([M.pt(0, 0, 0, 0, 0, 12), M.pt(20, 0)]);
  const hit = R.nodeTargetAt(path, 0.5, 11.5, 2);
  eq([hit.kind, hit.index, hit.side], ["handle", 0, "R"]);
});

test("nodeTargetAt: an anchor beats the segment under it", () => {
  const path = basePath([M.pt(0, 0), M.pt(20, 0)]);
  eq(R.nodeTargetAt(path, 0.5, 0.5, 2).kind, "anchor");
});

test("nodeTargetAt: a handle shorter than the tolerance never steals an anchor click", () => {
  const path = basePath([M.pt(0, 0, 0, 0, 1, 0), M.pt(20, 0)]);
  eq(R.nodeTargetAt(path, 0.5, 0, 2), { kind: "anchor", index: 0 });
});

test("nodeTargetAt: a click on a curve returns the nearest curve point and its t", () => {
  const path = basePath([M.pt(0, 0, 0, 0, 0, 12), M.pt(20, 0, -6, 6, 0, 0)]);
  const curve = samplePath(path, 256);
  const target = curve[Math.floor(curve.length * 0.2)];
  const hit = R.nodeTargetAt(path, target.x + 0.3, target.y - 0.3, 2);
  ok(hit && hit.kind === "segment" && hit.index === 0, "expected segment 0");
  ok(Math.hypot(hit.x - target.x, hit.y - target.y) < 0.1, "returned point is the nearest curve point");
  ok(hit.t > 0 && hit.t < 1 && Math.abs(hit.t - 0.5) > 0.05, "t reflects position, not the midpoint");
});

test("nodeTargetAt: closed paths include the wrap-around segment; misses return null", () => {
  const tri = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(0, 10)], true);
  const hit = R.nodeTargetAt(tri, 0.4, 5, 1);
  eq([hit.kind, hit.index], ["segment", 2]);
  eq(R.nodeTargetAt(basePath([M.pt(0, 0), M.pt(20, 0)]), 10, 50, 2), null);
  eq(R.nodeTargetAt({ points: [], closed: false }, 0, 0, 2), null);
});

test("smoothHandles are symmetric for interior points and point along the path", () => {
  const pts = [M.pt(0, 0), M.pt(10, 0), M.pt(20, 10)];
  const h = R.smoothHandles(pts, 1, false);
  near(h.cRx, -h.cLx, 1e-9);
  near(h.cRy, -h.cLy, 1e-9);
  ok(h.cRx > 0, "handle points forward");
  const end = R.smoothHandles(pts, 0, false);
  eq([end.cLx, end.cLy], [0, 0], "start has no incoming handle");
  ok(end.cRx > 0);
});

test("bbox and selectionBounds include the geometry", () => {
  const p = basePath([M.pt(2, 2), M.pt(10, 4)]);
  const b = R.bbox(p, false);
  eq([b.x, b.y, b.w, b.h], [2, 2, 8, 2]);
  const q = basePath([M.pt(20, 20), M.pt(22, 28)]);
  const L = { paths: [p, q] };
  const u = R.selectionBounds(L, [p.id, q.id], false);
  eq([u.x, u.y, u.w, u.h], [2, 2, 20, 26]);
});

test("topHit: the top outline wins over the shape below it, and locked layers are skipped", () => {
  const filled = basePath([M.pt(0, 0), M.pt(20, 0), M.pt(20, 20), M.pt(0, 20)], true);
  filled.fill.kind = "color";
  filled.stroke.width = 0;
  const outlined = basePath([M.pt(5, 5), M.pt(15, 5), M.pt(15, 15), M.pt(5, 15)], true);
  outlined.fill.kind = "none";
  outlined.stroke.width = 2;
  const doc = docWith([filled, outlined]);
  let hit = R.topHit(doc, 5, 10, 0.5);
  eq(hit.path.id, outlined.id, "outline of the top shape wins");
  hit = R.topHit(doc, 10, 10, 0.5);
  eq(hit.path.id, filled.id, "inside the outlined shape (no fill) the filled one below is hit");
  doc.layers[0].locked = true;
  hit = R.topHit(doc, 2, 2, 0.5);
  eq(hit, null, "locked layers are not picked");
});

test("topHit: a fill above an outline covers the outline where they overlap", () => {
  const outlined = basePath([M.pt(0, 0), M.pt(20, 0), M.pt(20, 20), M.pt(0, 20)], true);
  outlined.fill.kind = "none";
  outlined.stroke.width = 2;
  const filled = basePath([M.pt(-5, 5), M.pt(10, 5), M.pt(10, 15), M.pt(-5, 15)], true);
  filled.fill.kind = "color";
  filled.stroke.width = 0;
  const doc = docWith([outlined, filled]);
  eq(R.topHit(doc, 0, 10, 0.5).path.id, filled.id, "the lower outline's left edge is under the top fill");
  eq(R.topHit(doc, 20, 10, 0.5).path.id, outlined.id, "its right edge is uncovered");
});

test("pickShape finds outlines of shapes with no stroke width and insides with no fill", () => {
  const noFill = basePath([M.pt(0, 0), M.pt(20, 0), M.pt(20, 20), M.pt(0, 20)], true);
  noFill.fill.kind = "none";
  noFill.stroke.width = 0;
  const doc = docWith([noFill]);
  eq(R.topHit(doc, 10, 10, 0.5), null, "selection ignores it");
  eq(R.pickShape(doc, 10, 10, 0.5).path.id, noFill.id, "fill tool can click inside");
  eq(R.pickShape(doc, 0, 10, 0.5).path.id, noFill.id, "outline tool can click the edge");
  eq(R.pickShape(doc, 40, 40, 0.5), null, "outside is nothing");
});

test("hitsPoint uses the even-odd rule", () => {
  const sq = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  ok(R.hitsPoint(sq, 5, 5));
  ok(!R.hitsPoint(sq, 15, 5));
});

test("dashArray follows the stroke width", () => {
  eq(R.dashArray("dash", 2), "6,4");
  eq(R.dashArray("dot", 2), "0.01,4");
  eq(R.dashArray("none", 2), null);
  eq(R.dashArray("dash", 0), null, "no stroke, no dashes");
});

/* ---------- snapping ---------- */

test("snapPoint: anchor beats grid, grid rounds when nothing else is near", () => {
  const p = basePath([M.pt(10, 10), M.pt(20, 20)]);
  const doc = docWith([p]);
  IM.Snap.setDocument(doc);
  let r = IM.Snap.snapPoint(10.4, 10.6, { doc, zoom: 8, grid: true, anchors: true, exclude: [] });
  eq([r.x, r.y], [10, 10], "anchor");
  r = IM.Snap.snapPoint(3.3, 7.8, { doc, zoom: 8, grid: true, anchors: true, exclude: [] });
  eq([r.x, r.y], [3, 8], "grid");
  r = IM.Snap.snapPoint(3.3, 7.8, { doc, zoom: 8, grid: false, anchors: true, exclude: [] });
  eq([r.x, r.y], [3.3, 7.8], "grid off");
});

test("snapPoint aligns one axis to an anchor and keeps the other free", () => {
  const p = basePath([M.pt(6, 0), M.pt(40, 40)]);
  const doc = docWith([p]);
  const r = IM.Snap.snapPoint(6.5, 3.4, { doc, zoom: 8, grid: false, anchors: true, exclude: [] });
  eq(r.x, 6, "x aligned to the anchor column");
  eq(r.y, 3.4, "y untouched");
});

test("snapSegmentMove snaps a moved box to the grid and to other shapes' edges", () => {
  const moving = basePath([M.pt(4, 4), M.pt(8, 8)]);
  const other = basePath([M.pt(20, 0), M.pt(30, 10)]);
  const doc = docWith([moving, other]);
  const bbox = R.bbox(moving, false);
  let r = IM.Snap.snapSegmentMove(10.2, 0, { doc, zoom: 8, grid: true, exclude: [moving.id], bbox });
  near(r.dx, 10, 1e-9, "left edge 4.2 -> 4? actually snaps to grid 14.2->14 only if no edge within reach");
  r = IM.Snap.snapSegmentMove(15.6, 0, { doc, zoom: 8, grid: true, exclude: [moving.id], bbox });
  // moving box right edge (8+15.6=23.6) is 3.6 from the other box's left edge at 20 -> align
  near(r.dx + 0, 16, 1e-9, "should align right edge to 20 (delta 16.0)");
});

/* ---------- project files ---------- */

test("sanitize accepts a good project and rejects junk", () => {
  const doc = docWith([basePath([M.pt(1, 2), M.pt(3, 4)], true)]);
  const clean = IM.io.sanitize(JSON.parse(JSON.stringify(doc)));
  ok(clean, "good project accepted");
  eq(clean.layers[0].paths[0].points.length, 2);
  eq(IM.io.sanitize({ version: 2, layers: [] }), null, "wrong version");
  eq(IM.io.sanitize({ version: 1, layers: [] }), null, "no layers");
  eq(IM.io.sanitize("nope"), null);
  const bad = JSON.parse(JSON.stringify(doc));
  bad.layers[0].paths[0].points[0].x = "NaN";
  eq(IM.io.sanitize(bad), null, "non-numeric point rejected");
});

test("sanitize cleans colours, clamps numbers and fixes duplicate or unsafe ids", () => {
  const raw = {
    version: 1, size: 32, activeLayerId: "ghost",
    layers: [{
      id: "<bad>", name: "  ", visible: true, locked: 0, opacity: 9,
      paths: [
        { id: "same", closed: 1, points: [{ x: 0, y: 0 }], fill: { kind: "color", color: "red; x" }, stroke: { color: "#AABBCC", width: 9999, cap: "weird" } },
        { id: "same", closed: false, points: [{ x: 1, y: 1 }], fill: { kind: "none" }, stroke: {} }
      ]
    }]
  };
  const d = IM.io.sanitize(raw);
  ok(d, "accepted");
  ok(/^[A-Za-z0-9_-]+$/.test(d.layers[0].id), "layer id made safe");
  eq(d.layers[0].opacity, 1);
  eq(d.layers[0].name, "Layer 1");
  eq(d.layers[0].paths[0].fill.color, "#5b8def", "bad colour replaced by default");
  eq(d.layers[0].paths[0].stroke.color, "#aabbcc");
  eq(d.layers[0].paths[0].stroke.width, 200, "width clamped");
  eq(d.layers[0].paths[0].stroke.cap, "round");
  ok(d.layers[0].paths[0].id !== d.layers[0].paths[1].id, "duplicate path ids are made unique");
  eq(d.activeLayerId, d.layers[0].id, "unknown active layer falls back");
});

/* ---------- tools (through a stand-in app shell) ---------- */

function makeApp(doc) {
  const app = {
    doc,
    view: { zoom: 8, panX: 0, panY: 0 },
    state: {
      tool: "pen", snap: false, grid: false, space: false,
      selPathIds: [], selPathId: null, selPointIndex: -1,
      styleTarget: "fill", fillKind: "color", fillColor: "#336699", fillOpacity: 1,
      strokeColor: "#112233", strokeWidth: 2, shapeWidth: 0, strokeOpacity: 1, dash: "none",
      gradient: { stops: [{ offset: 0, color: "#000000", opacity: 1 }, { offset: 1, color: "#ffffff", opacity: 1 }] },
      gradSel: 0, penDraft: null, ghost: null, penPreviewSeg: null, marquee: null
    },
    history: new M.History(doc),
    tx: null,
    toasts: [],
    activeLayer() { return M.layer(this.doc, this.doc.activeLayerId); },
    pushHistory(label, op, opts) {
      opts = opts || {};
      if (op.type === "add" && op.index === undefined) {
        const L = M.layer(this.doc, op.layerId);
        op.index = L.paths.length;
      }
      if (op.path) op.path = M.clone(op.path);
      if (!opts.applied) M.applyOp(this.doc, op, true);
      if (this.tx) this.tx.ops.push(op);
      else this.history.push(op, opts.key);
    },
    beginTx() { if (!this.tx) this.tx = { ops: [] }; },
    endTx() {
      const t = this.tx;
      this.tx = null;
      if (t && t.ops.length) this.history.push(t.ops.length === 1 ? t.ops[0] : { type: "batch", ops: t.ops });
    },
    select(ids, primary) { this.state.selPathIds = ids.slice(); this.state.selPathId = primary || ids[0] || null; },
    setActiveLayer(id) { this.doc.activeLayerId = id; this.state.selPathIds = []; this.state.selPathId = null; },
    toast(m) { this.toasts.push(m); },
    renderAll() {}, requestRender() {},
    setFillColor() {}, setStrokeColor() {}
  };
  return app;
}
function down(app, tool, x, y, extra) {
  IM.Tools[tool].onDown(app, Object.assign({ type: "down", x, y, button: 0, buttons: 1, shiftKey: false, altKey: false, space: false }, extra || {}));
}
function move(app, tool, x, y, extra) {
  IM.Tools[tool].onMove(app, Object.assign({ type: "move", x, y, button: 0, buttons: 1, shiftKey: false, altKey: false, space: false }, extra || {}));
}
function up(app, tool, x, y, extra) {
  IM.Tools[tool].onUp(app, Object.assign({ type: "up", x, y, button: 0, buttons: 0, shiftKey: false, altKey: false, space: false }, extra || {}));
}
function click(app, tool, x, y, extra) { down(app, tool, x, y, extra); up(app, tool, x, y, extra); }
function lastPath(doc) {
  const L = doc.layers[0];
  return L.paths[L.paths.length - 1];
}

test("pen: three clicks then clicking the first point closes a triangle with exactly three anchors", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  click(app, "pen", 2, 2);
  click(app, "pen", 20, 2);
  click(app, "pen", 11, 18);
  click(app, "pen", 2, 2);
  eq(doc.layers[0].paths.length, 1, "one path");
  const p = lastPath(doc);
  eq(p.points.length, 3, "no duplicate first anchor (regression)");
  eq(p.closed, true);
});

test("pen: a drag on the second anchor bends that anchor and does not touch the first (regression)", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  click(app, "pen", 2, 2);
  down(app, "pen", 20, 2);
  move(app, "pen", 24, 8);
  move(app, "pen", 26, 10);
  up(app, "pen", 26, 10);
  down(app, "pen", 30, 20);
  up(app, "pen", 30, 20);
  app.tx = null;
  IM.Tools.pen.onKey(app, { key: "Enter" });
  const p = lastPath(doc);
  eq(p.points.length, 3, "three anchors: first, dragged, last");
  ok(p.points[0].cRx === 0 && p.points[0].cRy === 0, "first anchor stays a corner");
  ok(p.points[1].cRx !== 0 || p.points[1].cRy !== 0, "dragged anchor has a handle");
  eq(p.points[1].cLx, -p.points[1].cRx, "handles mirror");
});

test("pen: double-click finishing adds no duplicate point", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  click(app, "pen", 2, 2);
  click(app, "pen", 20, 4);
  click(app, "pen", 20, 4);      // second half of a double-click
  IM.Tools.pen.onDblClick(app, { x: 20, y: 4 });
  const p = lastPath(doc);
  eq(p.points.length, 2, "two anchors, not three");
  eq(p.closed, false);
});

test("pen: Escape cancels without touching the document; Backspace removes the last point", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  click(app, "pen", 2, 2);
  click(app, "pen", 20, 4);
  IM.Tools.pen.onKey(app, { key: "Backspace" });
  eq(app.state.penDraft.points.length, 1);
  IM.Tools.pen.onKey(app, { key: "Escape" });
  eq(app.state.penDraft, null);
  eq(doc.layers[0].paths.length, 0, "nothing added");
});

test("pen: clicking the end of an open path continues it", () => {
  const open = basePath([M.pt(2, 2), M.pt(10, 2)], false);
  const doc = docWith([open]);
  const app = makeApp(doc);
  click(app, "pen", 10, 2);      // the end point: continues from here, adds nothing yet
  click(app, "pen", 10, 14);
  IM.Tools.pen.onKey(app, { key: "Enter" });
  eq(doc.layers[0].paths.length, 1, "still one path");
  eq(open.points.length, 3, "continued to a third point");
  eq([doc.layers[0].paths[0].points[2].x, doc.layers[0].paths[0].points[2].y], [10, 14]);
  app.history.undo();
  eq(doc.layers[0].paths[0].points.length, 2, "undo restores the original path");
});

test("node: inserting a point on a curve leaves the curve in place (regression: it used to flatten)", () => {
  const p = basePath([M.pt(2, 20, 0, 0, 8, -14), M.pt(30, 20, -8, -14, 0, 0)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.selPathId = p.id; app.state.selPathIds = [p.id];
  app.state.tool = "node";
  const before = samplePath(p, 64);
  const mid = R.pointAtSegMid(p, 0);
  IM.Tools.node.onDown(app, { type: "down", x: mid.x, y: mid.y, button: 0, space: false, altKey: false, shiftKey: false, buttons: 1 });
  IM.Tools.node.onUp(app, { type: "up", x: mid.x, y: mid.y, button: 0, space: false, altKey: false, shiftKey: false, buttons: 0 });
  const after = doc.layers[0].paths[0];
  eq(after.points.length, 3, "one point inserted");
  const dev = maxDeviation(samplePath(after, 64), before);
  ok(dev < 0.05, "curve moved by " + dev);
  ok(after.points[1].cRx !== 0 || after.points[1].cRy !== 0 || after.points[1].cLx !== 0, "new point keeps handles");
  app.history.undo();
  eq(doc.layers[0].paths[0].points.length, 2, "undo removes it again");
});

test("node: with snap on, a dragged handle tip lands on the integer grid", () => {
  const p = basePath([M.pt(2, 20, 0, 0, 8, -14), M.pt(30, 20, -8, -14, 0, 0)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.snap = true;
  app.state.selPathId = p.id; app.state.selPathIds = [p.id];
  app.state.tool = "node";
  const tip = { x: 10, y: 6 };
  IM.Tools.node.onDown(app, { type: "down", x: tip.x, y: tip.y, button: 0, space: false, altKey: false, shiftKey: false, buttons: 1 });
  IM.Tools.node.onMove(app, { type: "move", x: 12.4, y: 9.6, button: 0, space: false, altKey: false, shiftKey: false, buttons: 1 });
  IM.Tools.node.onUp(app, { type: "up", x: 12.4, y: 9.6, button: 0, space: false, altKey: false, shiftKey: false, buttons: 0 });
  const h = doc.layers[0].paths[0].points[0];
  eq([2 + h.cRx, 20 + h.cRy], [12, 10], "handle tip snapped to (12, 10)");
});

test("node: with snap on, an inserted point is rounded to the integer grid", () => {
  const p = basePath([M.pt(2, 20, 0, 0, 8, -14), M.pt(30, 20, -8, -14, 0, 0)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.snap = true;
  app.state.selPathId = p.id; app.state.selPathIds = [p.id];
  app.state.tool = "node";
  const mid = R.pointAtSegMid(p, 0);
  IM.Tools.node.onDown(app, { type: "down", x: mid.x, y: mid.y, button: 0, space: false, altKey: false, shiftKey: false, buttons: 1 });
  IM.Tools.node.onUp(app, { type: "up", x: mid.x, y: mid.y, button: 0, space: false, altKey: false, shiftKey: false, buttons: 0 });
  const after = doc.layers[0].paths[0];
  eq(after.points.length, 3, "one point inserted");
  eq([after.points[1].x, after.points[1].y], [Math.round(after.points[1].x), Math.round(after.points[1].y)], "new anchor is on the grid");
});

test("node: F makes a corner smooth then sharp again; G opens and closes the path", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.selPathId = p.id; app.state.selPathIds = [p.id]; app.state.tool = "node"; app.state.selPointIndex = 1;
  IM.Tools.node.onKey(app, { key: "f" });
  ok(p.points[1].cRx !== 0 || p.points[1].cRy !== 0, "smooth now");
  IM.Tools.node.onKey(app, { key: "F" });
  eq([p.points[1].cRx, p.points[1].cRy, p.points[1].cLx, p.points[1].cLy], [0, 0, 0, 0], "sharp again");
  IM.Tools.node.onKey(app, { key: "g" });
  eq(p.closed, true, "G closes");
  IM.Tools.node.onKey(app, { key: "G" });
  eq(p.closed, false, "G opens");
});

test("node: Delete removes the selected point and keeps at least two points", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.selPathId = p.id; app.state.selPathIds = [p.id]; app.state.tool = "node"; app.state.selPointIndex = 1;
  IM.Tools.node.onKey(app, { key: "Delete" });
  eq(p.points.length, 2);
  app.state.selPointIndex = 0;
  IM.Tools.node.onKey(app, { key: "Delete" });
  eq(p.points.length, 2, "not reduced below two");
  ok(app.toasts.length > 0, "explains why");
});

test("node: a closed shape never drops below three points", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10)], true);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.selPathId = p.id; app.state.selPathIds = [p.id]; app.state.tool = "node"; app.state.selPointIndex = 1;
  IM.Tools.node.onKey(app, { key: "Delete" });
  eq(p.points.length, 3, "triangle keeps its three points");
  ok(app.toasts.length > 0, "explains why");
});

test("node: repeated arrow nudges merge into one undo step; a different point starts a new one", () => {
  const p = basePath([M.pt(0, 0), M.pt(10, 0)], false);
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.selPathId = p.id; app.state.selPathIds = [p.id]; app.state.tool = "node"; app.state.selPointIndex = 0;
  for (let i = 0; i < 3; i++) IM.Tools.node.onKey(app, { key: "ArrowRight" });
  eq(p.points[0].x, 3);
  eq(app.history.stack.length, 1, "three presses are one undo step");
  app.state.selPointIndex = 1;
  IM.Tools.node.onKey(app, { key: "ArrowUp" });
  eq(app.history.stack.length, 2, "a different point starts a new step");
  app.history.undo();
  eq(p.points[1].y, 0, "undo reverts the second point");
  eq(p.points[0].x, 3, "the first point's nudges stay");
  app.history.undo();
  eq(p.points[0].x, 0, "undo restores the original first point");
});

test("rect tool: Alt gives rounded corners with eight anchors; plain rect has four", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  app.state.tool = "rect";
  down(app, "rect", 4, 4);
  up(app, "rect", 20, 16);
  eq(lastPath(doc).points.length, 4);
  down(app, "rect", 4, 4);
  up(app, "rect", 20, 16, { altKey: true });
  eq(lastPath(doc).points.length, 8);
  eq(lastPath(doc).closed, true);
});

test("ellipse tool: four anchors, closed, cubic outline", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  down(app, "ellipse", 2, 2);
  move(app, "ellipse", 30, 30, { shiftKey: true });
  up(app, "ellipse", 30, 30, { shiftKey: true });
  const p = lastPath(doc);
  eq(p.points.length, 4);
  const b = R.bbox(p, false);
  near(b.w, b.h, 1e-6, "circle when Shift is held");
});

test("pencil: a wobbly stroke is simplified to fewer anchors and closed when it returns home", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  down(app, "pencil", 4, 4);
  for (let i = 1; i <= 60; i++) {
    const t = i / 60 * Math.PI * 2;
    move(app, "pencil", 16 + 10 * Math.cos(t) + 0.05 * Math.sin(40 * t), 16 + 10 * Math.sin(t));
  }
  move(app, "pencil", 4.2, 4.1);
  up(app, "pencil", 4.2, 4.1);
  const p = lastPath(doc);
  ok(p, "path created");
  ok(p.points.length < 30, "simplified to " + p.points.length + " anchors");
  eq(p.closed, true, "closed");
});

test("pencil: the pointer-up position is part of the stroke", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  down(app, "pencil", 2, 2);
  move(app, "pencil", 10, 2);
  up(app, "pencil", 30, 2);
  const p = lastPath(doc);
  ok(p, "path created");
  near(p.points[p.points.length - 1].x, 30, 0.01, "stroke ends where the pointer was released");
});

test("line: Shift snaps the angle to 15 degrees", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  down(app, "line", 4, 4);
  move(app, "line", 20, 9, { shiftKey: true });
  up(app, "line", 20, 9, { shiftKey: true });
  const p = lastPath(doc);
  const dx = p.points[1].x - p.points[0].x, dy = p.points[1].y - p.points[0].y;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  near(angle, Math.round(angle / 15) * 15, 1e-6, "angle " + angle);
});

test("select: dragging a shape with a hole (after Subtract) moves the hole with it, every frame (regression: the hole ran away)", () => {
  const p = basePath([M.pt(0, 0), M.pt(20, 0), M.pt(20, 20), M.pt(0, 20)], true);
  p.fill.kind = "color";
  p.rings = [[M.pt(6, 6), M.pt(14, 6), M.pt(14, 14), M.pt(6, 14)]];
  const doc = docWith([p]);
  const app = makeApp(doc);
  app.state.tool = "select";
  app.select([p.id], p.id);
  down(app, "select", 3, 3);
  for (let i = 1; i <= 10; i++) move(app, "select", 3 + i, 3);   // many frames
  up(app, "select", 13, 3);
  eq(p.points[0].x, 10, "outer ring moved by 10");
  eq(p.rings[0][0].x, 16, "hole moved by exactly 10, not accumulated per frame");
  eq(p.rings[0][0].y, 6);
  app.history.undo();
  eq([p.points[0].x, p.rings[0][0].x], [0, 6], "undo restores both");
});

test("new shapes: rectangle and oval default to no border; lines keep their thickness", () => {
  const doc = docWith([]);
  const app = makeApp(doc);
  down(app, "rect", 4, 4);
  up(app, "rect", 20, 16);
  eq(lastPath(doc).stroke.width, 0, "rectangle border");
  down(app, "ellipse", 4, 4);
  up(app, "ellipse", 20, 16);
  eq(lastPath(doc).stroke.width, 0, "oval border");
  down(app, "line", 4, 4);
  up(app, "line", 20, 16);
  eq(lastPath(doc).stroke.width, 2, "line thickness");
  app.state.shapeWidth = 3;
  down(app, "rect", 4, 4);
  up(app, "rect", 20, 16);
  eq(lastPath(doc).stroke.width, 0, "previous thickness does not carry over");
  app.state.shapeWidth = 0;
  app.state.fillKind = "none";
  down(app, "rect", 4, 4);
  up(app, "rect", 20, 16);
  eq(lastPath(doc).stroke.width, 0, "new shapes reset to a solid fill without a border");
  eq(lastPath(doc).fill.kind, "color");
});

test("select: dragging a multi-selection moves every selected shape and undoes as one step", () => {
  const a = basePath([M.pt(2, 2), M.pt(6, 6)], true), b = basePath([M.pt(10, 10), M.pt(14, 14)], true);
  const doc = docWith([a, b]);
  const app = makeApp(doc);
  app.state.tool = "select";
  app.select([a.id, b.id], a.id);
  down(app, "select", 4, 4);
  move(app, "select", 7, 6);
  up(app, "select", 7, 6);
  eq([a.points[0].x, a.points[0].y], [5, 4]);
  eq([b.points[0].x, b.points[0].y], [13, 12]);
  app.history.undo();
  eq([a.points[0].x, a.points[0].y, b.points[0].x], [2, 2, 10], "both restored");
});

test("select: Alt-drag copies in place and undo removes the copies", () => {
  const a = basePath([M.pt(2, 2), M.pt(6, 6)], true);
  const doc = docWith([a]);
  const app = makeApp(doc);
  app.state.tool = "select";
  app.select([a.id], a.id);
  down(app, "select", 4, 4, { altKey: true });
  move(app, "select", 9, 4, { altKey: true });
  up(app, "select", 9, 4, { altKey: true });
  eq(doc.layers[0].paths.length, 2, "copy created");
  eq(doc.layers[0].paths[0].points[0].x, 2, "original stays put");
  app.history.undo();
  eq(doc.layers[0].paths.length, 1, "one undo removes the copy");
});

test("select: corner handle scales about the opposite corner", () => {
  const a = basePath([M.pt(10, 10), M.pt(20, 20)], true);
  const doc = docWith([a]);
  const app = makeApp(doc);
  app.state.tool = "select";
  app.select([a.id], a.id);
  // bottom-right corner (20,20) dragged to (30,30); top-left stays at (10,10)
  down(app, "select", 20, 20);
  move(app, "select", 30, 30);
  up(app, "select", 30, 30);
  near(a.points[0].x, 10, 1e-9, "opposite corner fixed");
  near(a.points[1].x, 30, 1e-6);
  near(a.points[1].y, 30, 1e-6);
});

test("select: edge handle stretches one axis only (regression: edges scaled both axes)", () => {
  const a = basePath([M.pt(10, 10), M.pt(20, 20)], true);
  const doc = docWith([a]);
  const app = makeApp(doc);
  app.state.tool = "select";
  app.select([a.id], a.id);
  // east edge handle at (20, 15) dragged to (30, 15)
  down(app, "select", 20, 15);
  move(app, "select", 30, 15);
  up(app, "select", 30, 15);
  near(a.points[1].x, 30, 1e-6, "width grows");
  near(a.points[1].y, 20, 1e-6, "height unchanged");
});

test("fill tool: drag across shapes fills each once, in one undo step", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  const b = basePath([M.pt(20, 0), M.pt(30, 0), M.pt(30, 10), M.pt(20, 10)], true);
  const doc = docWith([a, b]);
  const app = makeApp(doc);
  app.state.tool = "fill";
  down(app, "fill", 5, 5);
  move(app, "fill", 5, 5);
  move(app, "fill", 25, 5);
  up(app, "fill", 25, 5);
  eq(a.fill.kind, "color");
  eq(b.fill.kind, "color");
  eq(app.history.stack.length, 1, "single undo step");
  app.history.undo();
  eq(a.fill.kind, "none");
  eq(b.fill.kind, "none");
});

test("eraser: a drag removes every shape it touches, in one undo step", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0)], false);
  const b = basePath([M.pt(0, 5), M.pt(10, 5)], false);
  const doc = docWith([a, b]);
  const app = makeApp(doc);
  app.state.tool = "eraser";
  down(app, "eraser", 2, 0);
  move(app, "eraser", 2, 5);
  up(app, "eraser", 2, 5);
  eq(doc.layers[0].paths.length, 0);
  app.history.undo();
  eq(doc.layers[0].paths.length, 2);
});

test("eyedropper: copies the colour under the pointer into the target", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  a.fill = { kind: "color", color: "#ab12cd", opacity: 1, gradient: null };
  const doc = docWith([a]);
  const app = makeApp(doc);
  let picked = null;
  app.setFillColor = (c) => { picked = c; };
  IM.Tools.eyedropper.onDown(app, { x: 5, y: 5, button: 0, space: false });
  eq(picked, "#ab12cd");
});

test("eyedropper: with nothing selected, the toast explains how to apply the colour", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  a.fill = { kind: "color", color: "#ab12cd", opacity: 1, gradient: null };
  const app = makeApp(docWith([a]));
  IM.Tools.eyedropper.onDown(app, { x: 5, y: 5, button: 0, space: false });
  ok(app.toasts[0].indexOf("Use Fill or Outline") >= 0, "toast was: " + app.toasts[0]);
});

test("eyedropper: on the Fill target, an outline-only shape copies nothing and says why", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  a.fill = { kind: "none", color: "#000000", opacity: 1, gradient: null };
  a.stroke.color = "#112233";
  const app = makeApp(docWith([a]));
  let picked = null;
  app.setFillColor = (c) => { picked = c; };
  IM.Tools.eyedropper.onDown(app, { x: 10, y: 5, button: 0, space: false });
  eq(picked, null, "the outline colour must not become the fill");
  eq(app.toasts.length, 1, "the user is told why nothing was picked");
});

test("eyedropper: on the Outline target, it copies the shape's outline colour", () => {
  const a = basePath([M.pt(0, 0), M.pt(10, 0), M.pt(10, 10), M.pt(0, 10)], true);
  a.fill = { kind: "none", color: "#000000", opacity: 1, gradient: null };
  a.stroke.color = "#112233";
  const app = makeApp(docWith([a]));
  app.state.styleTarget = "stroke";
  let picked = null;
  app.setStrokeColor = (c) => { picked = c; };
  IM.Tools.eyedropper.onDown(app, { x: 10, y: 5, button: 0, space: false });
  eq(picked, "#112233");
});

/* ---------- grouping and boolean merges ---------- */

function rectPath(x, y, w, h) {
  return basePath([M.pt(x, y), M.pt(x + w, y), M.pt(x + w, y + h), M.pt(x, y + h)], true);
}
function circlePath(cx, cy, r) {
  // Four cubic arcs with the usual kappa handles, clockwise from the top.
  const k = 0.5523 * r;
  return basePath([
    { x: cx, y: cy - r, cLx: -k, cLy: 0, cRx: k, cRy: 0 },
    { x: cx + r, y: cy, cLx: 0, cLy: -k, cRx: 0, cRy: k },
    { x: cx, y: cy + r, cLx: k, cLy: 0, cRx: -k, cRy: 0 },
    { x: cx - r, y: cy, cLx: 0, cLy: k, cRx: 0, cRy: -k }
  ], true);
}
function mergeArea(path) {
  // Even-odd filled area of the curve as drawn: a ring nested inside an odd number of others is a hole.
  const rings = IM.Renderer.flattenAll(path, 64);
  const inside = (pt, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  return rings.reduce((sum, ring, k) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a += p.x * q.y - q.x * p.y;
    }
    let depth = 0;
    rings.forEach((other, j) => { if (j !== k && inside(ring[0], other)) depth++; });
    return sum + (depth % 2 ? -1 : 1) * Math.abs(a) / 2;
  }, 0);
}

test("merge: union of two overlapping squares is one shape covering both", () => {
  const a = rectPath(0, 0, 10, 10), b = rectPath(5, 0, 10, 10);
  const r = IM.Merge.run("union", [a, b], "merged");
  ok(r.path, "result produced");
  eq(r.path.id, "merged");
  near(mergeArea(r.path), 150, 0.5, "10x10 + 10x10 overlapping by 5x10 is 150 square units");
  eq(r.path.closed, true);
});

test("merge: subtract removes the later shape from the back-most one and leaves a hole", () => {
  const base = rectPath(0, 0, 10, 10), cut = rectPath(4, 4, 2, 2);
  const r = IM.Merge.run("subtract", [base, cut], "m");
  ok(r.path, "result produced");
  eq(r.path.rings.length, 1, "the inner cut becomes a hole ring");
  near(mergeArea(r.path), 96, 0.5, "100 minus the 2x2 hole");
});

test("merge: merged curves keep their handles and stay within the fit tolerance", () => {
  // Two radius-10 circles whose centres are 10 apart overlap in a lens of area 122.84.
  const a = circlePath(0, 0, 10), b = circlePath(10, 0, 10);
  const r = IM.Merge.run("intersect", [a, b], "m");
  ok(r.path, "result produced");
  ok(r.path.points.some(p => p.cRx || p.cRy || p.cLx || p.cLy), "the lens keeps curved handles, not straight edges");
  near(mergeArea(r.path), 122.84, 1.0, "lens area of two overlapping circles");
});

test("merge: a union of rectangles stays straight-edged with no handles", () => {
  const r = IM.Merge.run("union", [rectPath(0, 0, 10, 10), rectPath(5, 0, 10, 10)], "m");
  ok(r.path.points.every(p => !p.cRx && !p.cRy && !p.cLx && !p.cLy), "no handles on a rectilinear outline");
});

test("merge: intersect of disjoint shapes reports empty, exclude of identical shapes too", () => {
  eq(IM.Merge.run("intersect", [rectPath(0, 0, 4, 4), rectPath(10, 10, 4, 4)], "m"), { empty: true });
  eq(IM.Merge.run("exclude", [rectPath(0, 0, 4, 4), rectPath(0, 0, 4, 4)], "m"), { empty: true });
});

test("merge: exclude keeps the parts covered by only one shape (symmetric difference)", () => {
  const r = IM.Merge.run("exclude", [rectPath(0, 0, 10, 10), rectPath(5, 0, 10, 10)], "m");
  near(mergeArea(r.path), 100, 0.5, "union 150 minus overlap 50");
});

test("merge: problemOf asks for two closed shapes", () => {
  ok(IM.Merge.problemOf([rectPath(0, 0, 2, 2)]), "one shape is not enough");
  const open = basePath([M.pt(0, 0), M.pt(4, 0), M.pt(4, 4)], false);
  ok(IM.Merge.problemOf([rectPath(0, 0, 2, 2), open]), "open paths are refused");
  eq(IM.Merge.problemOf([rectPath(0, 0, 2, 2), rectPath(3, 3, 2, 2)]), null);
});

test("merge: undo restores the source shapes in their original order and redo removes them again", () => {
  const doc = docWith([rectPath(0, 0, 10, 10), rectPath(20, 0, 5, 5), rectPath(40, 0, 3, 3)]);
  const L = doc.layers[0];
  const before = JSON.stringify(L.paths);
  const sources = [L.paths[0].id, L.paths[2].id];
  const r = IM.Merge.run("union", [L.paths[0], L.paths[2]], "merged");
  const op = IM.Merge.replaceOp(L, sources, r.path);
  M.applyOp(doc, op, true);
  eq(L.paths.map((p) => p.id), ["merged", L.paths[1].id], "merged shape takes the back-most slot");
  M.applyOp(doc, op, false);
  eq(JSON.stringify(L.paths), before, "undo restores the exact original layer");
  M.applyOp(doc, op, true);
  eq(L.paths.length, 2, "redo gives the same result again");
});

test("group: group and ungroup are undoable and sanitize keeps the group id", () => {
  const doc = docWith([rectPath(0, 0, 4, 4), rectPath(8, 0, 4, 4)]);
  const L = doc.layers[0];
  const changes = L.paths.map((p) => ({ layerId: L.id, id: p.id, from: null, to: "gA1" }));
  const op = { type: "group", changes };
  M.applyOp(doc, op, true);
  eq(L.paths.map((p) => p.groupId), ["gA1", "gA1"]);
  M.applyOp(doc, op, false);
  ok(L.paths.every((p) => p.groupId === undefined), "undo clears the group id");
  M.applyOp(doc, op, true);
  const clean = IM.io.sanitize(JSON.parse(JSON.stringify(doc)));
  eq(clean.layers[0].paths.map((p) => p.groupId), ["gA1", "gA1"], "group id survives a save and load");
  const bad = JSON.parse(JSON.stringify(doc));
  bad.layers[0].paths[0].groupId = "<script>";
  ok(IM.io.sanitize(bad).layers[0].paths[0].groupId === undefined, "unsafe group id is dropped");
});

test("sanitize keeps hole rings through a save and load", () => {
  const r = IM.Merge.run("subtract", [rectPath(0, 0, 10, 10), rectPath(4, 4, 2, 2)], "m");
  const doc = docWith([r.path]);
  const clean = IM.io.sanitize(JSON.parse(JSON.stringify(doc)));
  eq(clean.layers[0].paths[0].rings.length, 1, "hole ring preserved");
  near(mergeArea(clean.layers[0].paths[0]), 96, 0.5, "area unchanged after load");
});

/* ---------- selection, duplication and drawing regressions ---------- */

function selectFrame(app, x0, y0, x1, y1, extra) {
  IM.Tools.select.activate(app);
  down(app, "select", x0, y0, extra);
  move(app, "select", x1, y1, extra);
  up(app, "select", x1, y1, extra);
}

test("marquee selects only fully enclosed shapes in either drag direction, including their border", () => {
  const inside = rectPath(4, 4, 4, 4), partial = rectPath(12, 4, 8, 4);
  const border = rectPath(4, 12, 4, 3);
  border.stroke.width = 4;
  const app = makeApp(docWith([inside, partial, border]));
  selectFrame(app, 0, 0, 16, 16);
  eq(app.state.selPathIds, [inside.id]);
  app.select([], null);
  selectFrame(app, 16, 16, 0, 0);
  eq(app.state.selPathIds, [inside.id]);
});

test("marquee requires an entire group to fit and Shift preserves the previous selection", () => {
  const a = rectPath(4, 4, 4, 4), b = rectPath(20, 4, 4, 4), c = rectPath(26, 4, 2, 2);
  a.groupId = b.groupId = "originalGroup";
  const app = makeApp(docWith([a, b, c]));
  selectFrame(app, 0, 0, 16, 16);
  eq(app.state.selPathIds, []);
  app.select([c.id], c.id);
  selectFrame(app, 0, 0, 25, 16, { shiftKey: true });
  eq(app.state.selPathIds.slice().sort(), [a.id, b.id, c.id].sort());
});

test("copies preserve separate groups and get fresh group ids on every duplication or paste", () => {
  const paths = [rectPath(1, 1, 2, 2), rectPath(4, 1, 2, 2), rectPath(7, 1, 2, 2), rectPath(10, 1, 2, 2)];
  paths[0].groupId = paths[1].groupId = "firstGroup";
  paths[2].groupId = "secondGroup";
  const before = M.clone(paths), copies = M.copyPaths(paths), again = M.copyPaths(paths);
  eq(paths, before, "originals remain unchanged");
  eq(copies[0].groupId, copies[1].groupId);
  ok(copies[0].groupId !== paths[0].groupId);
  ok(copies[2].groupId !== copies[0].groupId);
  ok(copies[0].groupId !== again[0].groupId);
  ok(!copies[3].groupId, "ungrouped objects stay ungrouped");
  copies.forEach((p, i) => ok(p.id !== paths[i].id));
});

test("Alt-drag duplicates a group independently and undo restores the original group", () => {
  const a = rectPath(4, 4, 4, 4), b = rectPath(12, 4, 4, 4);
  a.groupId = b.groupId = "sourceGroup";
  a.fill.kind = b.fill.kind = "color";
  const doc = docWith([a, b]), app = makeApp(doc);
  app.select([a.id, b.id], a.id);
  IM.Tools.select.activate(app);
  down(app, "select", 6, 6, { altKey: true });
  move(app, "select", 8, 8, { altKey: true });
  up(app, "select", 8, 8, { altKey: true });
  const copies = doc.layers[0].paths.slice(2);
  eq(copies.length, 2);
  eq(copies[0].groupId, copies[1].groupId);
  ok(copies[0].groupId !== a.groupId);
  app.history.undo();
  eq(doc.layers[0].paths.map(p => p.groupId), ["sourceGroup", "sourceGroup"]);
  app.history.redo();
  eq(doc.layers[0].paths[2].groupId, copies[0].groupId);
});

test("canvas picking ignores other layers even when they overlap the active layer", () => {
  const own = rectPath(4, 4, 8, 8), other = rectPath(4, 4, 8, 8);
  own.fill.kind = other.fill.kind = "color";
  const doc = docWith([own]), upper = M.makeLayer("Other");
  upper.paths = [other]; doc.layers.push(upper);
  eq(R.topHit(doc, 8, 8, 1, doc.activeLayerId).path.id, own.id);
  eq(R.pickShape(doc, 8, 8, 1, doc.activeLayerId).path.id, own.id);
  const app = makeApp(doc);
  app.state.fillColor = "#ff0000";
  click(app, "fill", 8, 8);
  eq(own.fill.color, "#ff0000");
  ok(other.fill.color !== "#ff0000");
  click(app, "eraser", 8, 8);
  eq(doc.layers[0].paths.length, 0);
  eq(upper.paths.length, 1);
  click(app, "node", 8, 8);
  eq(app.state.selPathIds, []);
  eq(doc.activeLayerId, doc.layers[0].id);
  app.setActiveLayer(upper.id);
  click(app, "node", 8, 8);
  eq(app.state.selPathIds, [other.id]);
});

test("marquee skips locked and hidden active layers", () => {
  const app = makeApp(docWith([rectPath(4, 4, 4, 4)]));
  app.activeLayer().locked = true;
  selectFrame(app, 0, 0, 16, 16);
  eq(app.state.selPathIds, []);
  app.activeLayer().locked = false; app.activeLayer().visible = false;
  selectFrame(app, 0, 0, 16, 16);
  eq(app.state.selPathIds, []);
});

test("every object tool creates editable geometry with default styling, despite previous style changes", () => {
  for (const kind of [...Object.keys(IM.Tools.shapeNames), "line"]) {
    const app = makeApp(docWith([]));
    Object.assign(app.state, { fillKind: "gradient", fillColor: "#ff0000", fillOpacity: 0.2,
      strokeColor: "#00ff00", strokeWidth: 9, shapeWidth: 7, strokeOpacity: 0.3, dash: "dot" });
    IM.Tools[kind].activate?.(app);
    down(app, kind, 24, 20);
    move(app, kind, 4, 4);
    const preview = M.clone(app.state.ghost);
    up(app, kind, 4, 4);
    const p = app.activeLayer().paths[0];
    ok(p && p.points.length >= 2, kind);
    eq(p.points, preview.points, kind + " preview matches result");
    eq(p.closed, kind !== "line");
    eq(p.fill, { kind: kind === "line" ? "none" : "color", color: "#000000", opacity: 1, gradient: null });
    eq(p.stroke.color, "#000000"); eq(p.stroke.opacity, 1);
    eq(p.stroke.width, kind === "line" ? 2 : 0); eq(p.dash, null);
    ok(p.points.every(pt => Object.values(pt).every(Number.isFinite)));
    app.history.undo(); eq(app.activeLayer().paths.length, 0);
    app.history.redo(); eq(app.activeLayer().paths.length, 1);
  }
});

test("Ctrl temporarily pans the view, restores the previous tool, and preserves Ctrl shortcuts", () => {
  const sandbox = vm.createContext({ console, Math, JSON, Date, IM });
  sandbox.window = sandbox;
  sandbox.requestAnimationFrame = () => {};
  sandbox.addEventListener = () => {};
  sandbox.document = { readyState: "loading", addEventListener() {}, querySelector() { return null; } };
  // Expose the real event handlers in this test context without booting a DOM.
  const source = fs.readFileSync(path.join(ROOT, "main.js"), "utf8").replace(
    '  if (document.readyState === "loading")',
    '  app.testInput = { down: onKeyDown, up: onKeyUp, wire: wireCanvas };\n  if (document.readyState === "loading")');
  vm.runInContext(source, sandbox, { filename: "main.js" });
  const app = sandbox.IM.App, handlers = {}, classes = new Set();
  app.canvas = { svg: {
    addEventListener(name, handler) { handlers[name] = handler; },
    setPointerCapture() {}, releasePointerCapture() {},
    classList: {
      add(...names) { names.forEach(n => classes.add(n)); },
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
    }
  } };
  app.doc = docWith([rectPath(2, 2, 4, 4)]);
  app.state.tool = "rect";
  app.testInput.wire();
  const key = { key: "Control", ctrlKey: true, preventDefault() {} };
  app.testInput.down(key);
  ok(classes.has("space"));
  handlers.pointerdown({ button: 0, pointerId: 1, ctrlKey: true, clientX: 10, clientY: 20, preventDefault() {} });
  handlers.pointermove({ clientX: 35, clientY: 55 });
  eq([app.view.panX, app.view.panY], [25, 35]);
  ok(classes.has("grabbing"));
  handlers.pointerup({ pointerId: 1 });
  app.testInput.up({ key: "Control" });
  ok(!classes.has("space") && !classes.has("grabbing"));
  eq(app.state.tool, "rect");
  eq(app.doc.layers[0].paths.length, 1, "panning does not draw an object");
  let prevented = false;
  let undid = false;
  app.history = { undo() { undid = true; return false; } };
  app.toast = () => {};
  app.testInput.down({ key: "z", ctrlKey: true, preventDefault() { prevented = true; } });
  ok(undid && prevented, "Ctrl+Z still works");
});

test("release history matches VERSION and the changelog, with valid versions and dates", () => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, "releases.js"), "utf8"), ctx, { filename: "releases.js" });
  const releases = ctx.IM.Releases;
  ok(releases.length > 0);
  eq(fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim(), releases[0].version);
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const seen = new Set();
  releases.forEach((release, i) => {
    ok(/^\d+\.\d+\.\d+$/.test(release.version));
    ok(!seen.has(release.version)); seen.add(release.version);
    eq(new Date(release.date).toISOString().slice(0, 10), release.date);
    if (i) ok(release.date <= releases[i - 1].date, "newest releases first");
    ok(changelog.includes(release.version + " — " + release.date));
    ok(release.changes.length > 0);
    release.changes.forEach(change => ok(changelog.includes(change)));
  });
});

/* ---------- report ---------- */

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) {
  console.log("\nFailures:\n  - " + failures.join("\n  - "));
  process.exitCode = 1;
}
