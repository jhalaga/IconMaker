/* IconMaker — export.js
 * SVG and transparent PNG output. Attaches IM.Export.
 * Coordinates are scaled when a different output size is requested, so the
 * artwork always fills the square.
 */
var IM = (window.IM = window.IM || {});

(function () {
  "use strict";

  var SIZES = [16, 32, 64, 128];

  function esc(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // SVG markup for the document at `size` px (viewBox 0 0 size size).
  function svgString(doc, size) {
    var target = size || doc.size;
    var f = target / doc.size;
    var defs = "", body = "";
    for (var li = 0; li < doc.layers.length; li++) {
      var L = doc.layers[li];
      if (!L.visible) continue;
      var items = "";
      for (var pi = 0; pi < L.paths.length; pi++) {
        var p = IM.Model.clone(L.paths[pi]);
        IM.Model.scalePath(p, f, f, 0, 0);
        var fillAttr = "none", fillOp = 0;
        if (p.fill.kind === "gradient" && p.fill.gradient) {
          var g = p.fill.gradient, gid = "grad_" + p.id, stops = "";
          for (var s = 0; s < g.stops.length; s++) {
            stops += '<stop offset="' + esc(g.stops[s].offset) + '" stop-color="' + esc(g.stops[s].color) +
              '" stop-opacity="' + esc(g.stops[s].opacity) + '"/>';
          }
          defs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse" x1="' + g.x1 + '" y1="' + g.y1 +
            '" x2="' + g.x2 + '" y2="' + g.y2 + '">' + stops + "</linearGradient>";
          fillAttr = "url(#" + gid + ")";
          fillOp = p.fill.opacity;
        } else if (p.fill.kind === "color") {
          fillAttr = esc(p.fill.color);
          fillOp = p.fill.opacity;
        }
        var w = p.stroke.width;
        var pattern = p.dash && p.dash.pattern;
        var dash = IM.Renderer.dashArray(pattern, w);
        var cap = pattern === "dot" ? "round" : p.stroke.cap;
        items += '<path d="' + IM.Renderer.pathD(p) + '" fill="' + fillAttr + '" fill-opacity="' + fillOp +
          '" fill-rule="evenodd" stroke="' + esc(p.stroke.color) + '" stroke-width="' + w +
          '" stroke-opacity="' + p.stroke.opacity + '" stroke-linecap="' + cap +
          '" stroke-linejoin="' + p.stroke.join + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : "") + "/>";
      }
      body += '<g opacity="' + L.opacity + '">' + items + "</g>";
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + target + '" height="' + target +
      '" viewBox="0 0 ' + target + " " + target + '"><defs>' + defs + "</defs>" + body + "</svg>";
  }

  function download(blob, filename) {
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

  function downloadSVG(doc, size) {
    var text = svgString(doc, size || doc.size);
    download(new Blob([text], { type: "image/svg+xml" }), "icon-" + (size || doc.size) + ".svg");
  }

  // Rasterises the SVG at size*scale px. cb(blob) — blob is null on failure.
  function pngBlob(doc, size, scale, cb) {
    var svg = svgString(doc, size);
    var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(size * scale);
      canvas.height = Math.round(size * scale);
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (b) { cb(b); }, "image/png");
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
  }

  function downloadPNG(doc, size, cb) {
    pngBlob(doc, size, 1, function (b) {
      if (b) download(b, "icon-" + size + ".png");
      if (cb) cb(!!b);
    });
  }

  // One PNG per standard size, spaced out so browsers allow every download.
  function exportAll(doc, cb) {
    var i = 0, okCount = 0;
    function next() {
      if (i >= SIZES.length) {
        if (cb) cb(okCount);
        return;
      }
      var size = SIZES[i++];
      downloadPNG(doc, size, function (ok) {
        if (ok) okCount += 1;
        setTimeout(next, 400);
      });
    }
    next();
  }

  IM.Export = {
    svg: svgString,
    svgAt: svgString,
    downloadSVG: downloadSVG,
    pngBlob: pngBlob,
    downloadPNG: downloadPNG,
    exportAll: exportAll,
    sizes: SIZES
  };
})();
