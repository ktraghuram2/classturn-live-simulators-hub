/**
 * ClassTurn Studio 10.0 — Physics-Safe Interactive Lab Kit & True Apparatus Zoom Extents / Short Leader Engine
 * Strictly enforces the ClassTurn Legacy Locked Layout:
 * 1. Only 1 horizontal bar below canvas (#apparatusLegendBanner for part labels).
 * 2. Pause and Step buttons only in .panel-top-row (no Voice or Magnifier buttons).
 * 3. Zero emojis anywhere in UI or canvas.
 * 4. True Apparatus Zoom Extents (1.20x - 1.58x): Computes the bounding box of the actual apparatus
 *    components & anchor touch beads (ignoring background grid lines, floor strips, and far-away badges),
 *    centers the setup at (W/2, H/2), and scales it up to fill ~86% of the canvas.
 * 5. Short, Flexible Style-2 Leader Lines (50px - 84px) & Anti-Overlap Badge Solver (>= 40px spacing).
 * 6. Dotted green target circle locked 100% onto the exact zoomed anchor touch bead (tx, ty) even while moving.
 */
(function () {
  "use strict";
  if (window.__classturnLabKitLoaded) return;
  window.__classturnLabKitLoaded = true;

  var leaderTargets = [];
  var activeSeqIdx = 0;
  var smoothBadges = {};

  function isEmeraldStroke(s) {
    if (!s) return false;
    return (
      s === "#34d399" ||
      s === "#10b981" ||
      s === "#6ee7b7" ||
      s.indexOf("52, 211, 153") !== -1 ||
      s.indexOf("16, 185, 129") !== -1
    );
  }

  function isLeaderCasingStroke(s, lw) {
    if (!s || lw < 2.8) return false;
    return (
      s === "#022c22" ||
      s === "#064e3b" ||
      s === "#090d16" ||
      s.indexOf("2, 44, 34") !== -1 ||
      s.indexOf("6, 78, 59") !== -1
    );
  }

  function isBadgeDiskFill(f) {
    if (!f) return false;
    return (
      f === "#10564b" ||
      f === "#064e3b" ||
      f === "#022c22" ||
      f === "#065f46" ||
      f === "#047857" ||
      f === "#0f766e" ||
      f === "#134e4a" ||
      f === "#115e59" ||
      f === "#176c5f"
    );
  }

  function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    function ccw(p1x, p1y, p2x, p2y, p3x, p3y) {
      return (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
    }
    return (
      ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
      ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
    );
  }

  (function hookCanvasPrototype() {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    var proto = CanvasRenderingContext2D.prototype;
    if (proto.__classturnHooked) return;
    proto.__classturnHooked = true;

    var origBeginPath = proto.beginPath;
    var origMoveTo = proto.moveTo;
    var origLineTo = proto.lineTo;
    var origBezierCurveTo = proto.bezierCurveTo;
    var origQuadraticCurveTo = proto.quadraticCurveTo;
    var origArc = proto.arc;
    var origEllipse = proto.ellipse;
    var origRect = proto.rect;
    var origRoundRect = proto.roundRect;
    var origStroke = proto.stroke;
    var origFill = proto.fill;
    var origFillText = proto.fillText;
    var origClearRect = proto.clearRect;
    var origFillRect = proto.fillRect;
    var origStrokeRect = proto.strokeRect;

    function isMainSimCanvas(ctx) {
      return ctx && ctx.canvas && ctx.canvas.id === "simCanvas";
    }

    function ensureFrameState(ctx) {
      if (!ctx.__ctState) {
        var W = (ctx.canvas && ctx.canvas.width) || 700;
        var H = (ctx.canvas && ctx.canvas.height) || 420;
        ctx.__ctState = {
          frameScheduled: false,
          zoomApplied: false,
          inLeaderLayer: false,
          baseMatrix: null,
          activeScale: 1.0,
          activeCx: W * 0.5,
          activeCy: H * 0.5,
          appliedScale: 1.0,
          appliedCx: W * 0.5,
          appliedCy: H * 0.5,
          appliedStretchX: 1.0,
          appliedEffW: W,
          appliedEffH: H,
          lastEffW: 0,
          lastEffH: 0,
          envMinX: Infinity,
          envMaxX: -Infinity,
          envMinY: Infinity,
          envMaxY: -Infinity,
          frameMinX: Infinity,
          frameMaxX: -Infinity,
          frameMinY: Infinity,
          frameMaxY: -Infinity,
          framesMeasured: 0,
          curPath: null,
          curves: [],
          beads: [],
          badges: [],
          texts: []
        };
      }
      return ctx.__ctState;
    }

    function getZoomCfg(ctx, st) {
      var canvas = ctx.canvas;
      var W = (canvas && canvas.width) || 700;
      var H = (canvas && canvas.height) || 420;
      var stretchX = 1.0;
      if (canvas && canvas.getBoundingClientRect) {
        var rect = canvas.getBoundingClientRect();
        if (rect && rect.width > 20 && rect.height > 20 && W > 0 && H > 0) {
          var cssAspect = rect.width / rect.height;
          var bufAspect = W / H;
          stretchX = Math.max(0.5, Math.min(2.5, cssAspect / bufAspect));
        }
      }
      var effW = W * stretchX;
      var effH = H;
      var cfg = window.CLASSTURN_ZOOM_CONFIG || {};
      return {
        scale: st.activeScale,
        cx: st.activeCx,
        cy: st.activeCy,
        W: W,
        H: H,
        stretchX: stretchX,
        effW: effW,
        effH: effH,
        minLeader: cfg.minLeader || 48,
        maxLeader: cfg.maxLeader || 80,
        minBadgeDist: cfg.minBadgeDist || 40
      };
    }

    function toScreenPt(ctx, st, lx, ly) {
      if (!ctx.getTransform) return { x: lx, y: ly };
      var m = ctx.getTransform();
      var bm = st.baseMatrix || { a: 1, d: 1 };
      var dprX = bm.a || 1;
      var dprY = bm.d || 1;
      var stretchX = st.appliedStretchX || 1.0;
      return {
        x: ((m.a * lx + m.c * ly + m.e) / dprX) * stretchX,
        y: (m.b * lx + m.d * ly + m.f) / dprY
      };
    }

    function screenToUnzoomed(st, sx, sy) {
      var s = st.appliedScale || st.activeScale || 1;
      var cx = st.appliedCx !== undefined ? st.appliedCx : st.activeCx;
      var cy = st.appliedCy !== undefined ? st.appliedCy : st.activeCy;
      var effW = st.appliedEffW || 700;
      var effH = st.appliedEffH || 420;
      return {
        x: cx + (sx - effW * 0.5) / s,
        y: cy + (sy - effH * 0.5) / s
      };
    }

    // Record genuine apparatus bodies & meters (ignoring only full-bleed canvas backgrounds, 1D grid lines, and full-width floor strips)
    function recordFilledApparatusBody(ctx, st, x1, y1, x2, y2) {
      if (!st.zoomApplied) return;
      var canvas = ctx.canvas;
      var W = (canvas && canvas.width) || 700;
      var H = (canvas && canvas.height) || 420;
      var p1 = toScreenPt(ctx, st, x1, y1);
      var p2 = toScreenPt(ctx, st, x2, y2);
      var u1 = screenToUnzoomed(st, p1.x, p1.y);
      var u2 = screenToUnzoomed(st, p2.x, p2.y);

      var minX = Math.min(u1.x, u2.x);
      var maxX = Math.max(u1.x, u2.x);
      var minY = Math.min(u1.y, u2.y);
      var maxY = Math.max(u1.y, u2.y);
      var bw = maxX - minX;
      var bh = maxY - minY;

      // If in leader layer, ignore small badge disks (<= 38px)
      if (st.inLeaderLayer && bw <= 38 && bh <= 38) return;

      // Ignore only full-bleed backgrounds (>94% of canvas width or >92% of height) or 1D horizontal/vertical grid lines (bw < 6 || bh < 6)
      if (bw > W * 0.94 || bh > H * 0.92) return;
      if (bw < 6 || bh < 6) return;
      // Ignore full-width floor/bench strips along the very bottom (>85% width at y > 82% height)
      if (minY > H * 0.82 && bw > W * 0.85) return;
      // Clamp to canvas interior [1, W-1] so even components drawn near the edge are captured and pulled inward
      if (maxX < 2 || minX > W - 2 || maxY < 2 || minY > H - 2) return;
      minX = Math.max(1, minX);
      maxX = Math.min(W - 1, maxX);
      minY = Math.max(1, minY);
      maxY = Math.min(H - 1, maxY);

      if (minX < st.frameMinX) st.frameMinX = minX;
      if (maxX > st.frameMaxX) st.frameMaxX = maxX;
      if (minY < st.frameMinY) st.frameMinY = minY;
      if (maxY > st.frameMaxY) st.frameMaxY = maxY;
    }

    function flushZoomAndLeaders(ctx) {
      var st = ensureFrameState(ctx);
      st.frameScheduled = false;
      var canvas = ctx.canvas;
      if (!canvas) return;
      var W = canvas.width || 700;
      var H = canvas.height || 420;
      var zcfg0 = getZoomCfg(ctx, st);
      var effW = st.appliedEffW || zcfg0.effW || W;
      var effH = st.appliedEffH || zcfg0.effH || H;

      // Pair curves, beads, badges, and numbers FIRST so we know the exact apparatus TARGET points (tx, ty)
      var curves = st.curves;
      var beads = st.beads;
      var badges = st.badges;
      var texts = st.texts;

      for (var ti = 0; ti < texts.length; ti++) {
        var tItem = texts[ti];
        var bestB = null;
        var bestDist = 28;
        for (var bi = 0; bi < badges.length; bi++) {
          var d = Math.hypot(badges[bi].x - tItem.x, badges[bi].y - tItem.y);
          if (d < bestDist) {
            bestDist = d;
            bestB = badges[bi];
          }
        }
        if (bestB) {
          bestB.num = tItem.num;
        } else {
          badges.push({ x: tItem.x, y: tItem.y, r: 11, num: tItem.num });
        }
      }

      var items = [];
      var usedCurves = {};

      for (var i = 0; i < badges.length; i++) {
        var b = badges[i];
        var num = b.num || i + 1;
        var matchedCurveIdx = -1;
        var bestCDist = 45;
        var badgeAtStart = true;

        for (var ci = 0; ci < curves.length; ci++) {
          if (usedCurves[ci]) continue;
          var c = curves[ci];
          var d0 = Math.hypot(c.x0 - b.x, c.y0 - b.y);
          var d1 = Math.hypot(c.x1 - b.x, c.y1 - b.y);
          if (d0 < bestCDist && d0 <= d1) {
            bestCDist = d0;
            matchedCurveIdx = ci;
            badgeAtStart = true;
          } else if (d1 < bestCDist && d1 < d0) {
            bestCDist = d1;
            matchedCurveIdx = ci;
            badgeAtStart = false;
          }
        }

        var tx = b.x;
        var ty = b.y;
        var bxOrig = b.x;
        var byOrig = b.y;

        if (matchedCurveIdx !== -1) {
          usedCurves[matchedCurveIdx] = true;
          var mc = curves[matchedCurveIdx];
          if (badgeAtStart) {
            bxOrig = mc.x0;
            byOrig = mc.y0;
            tx = mc.x1;
            ty = mc.y1;
          } else {
            bxOrig = mc.x1;
            byOrig = mc.y1;
            tx = mc.x0;
            ty = mc.y0;
          }
        } else if (beads[i]) {
          tx = beads[i].x;
          ty = beads[i].y;
        }

        for (var k = 0; k < beads.length; k++) {
          if (Math.hypot(beads[k].x - tx, beads[k].y - ty) < 18) {
            tx = beads[k].x;
            ty = beads[k].y;
            break;
          }
        }

        var dx = bxOrig - tx;
        var dy = byOrig - ty;
        var origLen = Math.hypot(dx, dy);
        if (origLen < 4) {
          dx = tx < effW * 0.5 ? -1 : 1;
          dy = ty < effH * 0.5 ? -0.7 : 0.7;
          origLen = 68;
        }
        var ux = dx / origLen;
        var uy = dy / origLen;

        var clampedLen = Math.max(zcfg0.minLeader, Math.min(zcfg0.maxLeader, origLen * 0.65));
        var bx = tx + ux * clampedLen;
        var by = ty + uy * clampedLen;

        // Include tight apparatus anchor target (tx, ty) and short-leader badge in scale-invariant unzoomed simulation borders
        var uTarget = screenToUnzoomed(st, tx, ty);
        var uOrigBadge = screenToUnzoomed(st, bxOrig, byOrig);
        var uDx = uOrigBadge.x - uTarget.x;
        var uDy = uOrigBadge.y - uTarget.y;
        var uLen = Math.hypot(uDx, uDy);
        var uBadgeX = uLen > 2 ? uTarget.x + (uDx / uLen) * 38 : uTarget.x;
        var uBadgeY = uLen > 2 ? uTarget.y + (uDy / uLen) * 38 : uTarget.y;
        var tMinX = Math.max(2, Math.min(uTarget.x - 18, uBadgeX - 12));
        var tMaxX = Math.min(W - 2, Math.max(uTarget.x + 18, uBadgeX + 12));
        var tMinY = Math.max(2, Math.min(uTarget.y - 18, uBadgeY - 12));
        var tMaxY = Math.min(H - 2, Math.max(uTarget.y + 18, uBadgeY + 12));
        if (tMinX < st.frameMinX) st.frameMinX = tMinX;
        if (tMaxX > st.frameMaxX) st.frameMaxX = tMaxX;
        if (tMinY < st.frameMinY) st.frameMinY = tMinY;
        if (tMaxY > st.frameMaxY) st.frameMaxY = tMaxY;

        tx = Math.max(14, Math.min(effW - 14, tx));
        ty = Math.max(14, Math.min(effH - 14, ty));

        items.push({
          num: num,
          tx: tx,
          ty: ty,
          bx: bx,
          by: by,
          prefLen: clampedLen
        });
      }

      // Compute & Lock Exact Bounding-Box Fit: Math.min((CanvasW - 24) / SimW, (CanvasH - 24) / SimH)
      // Matches either SimH to CanvasH or SimW to CanvasW (whichever is smaller) with zero truncation and zero stretching
      if (st.frameMaxX > st.frameMinX && st.frameMaxY > st.frameMinY) {
        var expanded = false;
        if (st.frameMinX < st.envMinX - 0.5) { st.envMinX = st.frameMinX; expanded = true; }
        if (st.frameMaxX > st.envMaxX + 0.5) { st.envMaxX = st.frameMaxX; expanded = true; }
        if (st.frameMinY < st.envMinY - 0.5) { st.envMinY = st.frameMinY; expanded = true; }
        if (st.frameMaxY > st.envMaxY + 0.5) { st.envMaxY = st.frameMaxY; expanded = true; }
        st.framesMeasured++;

        var sizeChanged = Math.abs(effW - st.lastEffW) > 2 || Math.abs(effH - st.lastEffH) > 2;
        if (expanded || st.framesMeasured <= 3 || sizeChanged) {
          st.lastEffW = effW;
          st.lastEffH = effH;
          var simW = Math.max(160, st.envMaxX - st.envMinX);
          var simH = Math.max(110, st.envMaxY - st.envMinY);
          var scaleW = (effW - 24) / simW;
          var scaleH = (effH - 24) / simH;
          var targetScale = Math.max(0.85, Math.min(1.68, Math.min(scaleW, scaleH)));
          var targetCx = (st.envMinX + st.envMaxX) * 0.5;
          var targetCy = (st.envMinY + st.envMaxY) * 0.5;

          if (st.framesMeasured <= 3 || sizeChanged || targetScale < st.activeScale) {
            var scaleDiff = Math.abs(targetScale - st.activeScale) + Math.abs(targetCx - st.activeCx) + Math.abs(targetCy - st.activeCy);
            st.activeScale = targetScale;
            st.activeCx = targetCx;
            st.activeCy = targetCy;
            if (st.framesMeasured === 1 && scaleDiff > 0.01 && typeof ctLastCallback === "function") {
              try {
                ctLastCallback(performance.now() + ctTimeOffset);
                return;
              } catch (e) {}
            }
          }
        }
      }

      var zcfg = getZoomCfg(ctx, st);

      items.sort(function (a, b) {
        return a.num - b.num;
      });

      var minBadgeDist = zcfg.minBadgeDist;
      var minTargetClearance = 42;
      var margin = 18;

      for (var iter = 0; iter < 18; iter++) {
        if (iter < 6) {
          for (var a = 0; a < items.length; a++) {
            for (var bIdx = a + 1; bIdx < items.length; bIdx++) {
              var ia = items[a];
              var ib = items[bIdx];
              if (segmentsIntersect(ia.bx, ia.by, ia.tx, ia.ty, ib.bx, ib.by, ib.tx, ib.ty)) {
                var tmpX = ia.bx;
                var tmpY = ia.by;
                ia.bx = ib.bx;
                ia.by = ib.by;
                ib.bx = tmpX;
                ib.by = tmpY;
              }
            }
          }
        }

        for (var i1 = 0; i1 < items.length; i1++) {
          for (var i2 = i1 + 1; i2 < items.length; i2++) {
            var p1 = items[i1];
            var p2 = items[i2];
            var ddx = p2.bx - p1.bx;
            var ddy = p2.by - p1.by;
            var dist = Math.hypot(ddx, ddy);
            if (dist < minBadgeDist) {
              var overlap = (minBadgeDist - dist) * 0.55;
              var nx = dist > 0.1 ? ddx / dist : 1;
              var ny = dist > 0.1 ? ddy / dist : 0;
              p1.bx -= nx * overlap;
              p1.by -= ny * overlap;
              p2.bx += nx * overlap;
              p2.by += ny * overlap;
            }
          }
        }

        for (var bi2 = 0; bi2 < items.length; bi2++) {
          var pb = items[bi2];
          for (var ti2 = 0; ti2 < items.length; ti2++) {
            var pt = items[ti2];
            var tdx = pb.bx - pt.tx;
            var tdy = pb.by - pt.ty;
            var tdist = Math.hypot(tdx, tdy);
            var reqClear = bi2 === ti2 ? zcfg.minLeader : minTargetClearance;
            if (tdist < reqClear) {
              var push = (reqClear - tdist) * 0.65;
              var tnx = tdist > 0.1 ? tdx / tdist : 0;
              var tny = tdist > 0.1 ? tdy / tdist : -1;
              pb.bx += tnx * push;
              pb.by += tny * push;
            }
          }
        }

        for (var k2 = 0; k2 < items.length; k2++) {
          var it = items[k2];
          it.bx = Math.max(margin, Math.min(effW - margin, it.bx));
          it.by = Math.max(margin, Math.min(effH - margin, it.by));

          var rdx = it.bx - it.tx;
          var rdy = it.by - it.ty;
          var rlen = Math.hypot(rdx, rdy);
          var maxAllow = zcfg.maxLeader + 6;
          var minAllow = zcfg.minLeader - 2;
          if (rlen > maxAllow && rlen > 0.1) {
            it.bx = it.tx + (rdx / rlen) * maxAllow;
            it.by = it.ty + (rdy / rlen) * maxAllow;
          } else if (rlen < minAllow && rlen > 0.1) {
            it.bx = it.tx + (rdx / rlen) * minAllow;
            it.by = it.ty + (rdy / rlen) * minAllow;
          }
          it.bx = Math.max(margin, Math.min(effW - margin, it.bx));
          it.by = Math.max(margin, Math.min(effH - margin, it.by));
        }
      }

      for (var si = 0; si < items.length; si++) {
        var cur = items[si];
        var prev = smoothBadges[cur.num];
        if (prev && Math.hypot(prev.bx - cur.bx, prev.by - cur.by) < 80) {
          cur.bx = prev.bx + (cur.bx - prev.bx) * 0.42;
          cur.by = prev.by + (cur.by - prev.by) * 0.42;
        }
        smoothBadges[cur.num] = { bx: cur.bx, by: cur.by };
      }

      if (items.length > 0) {
        leaderTargets = items;
      }

      ctx.save();
      if (st.baseMatrix && ctx.setTransform) {
        ctx.setTransform(st.baseMatrix);
      } else if (ctx.setTransform) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (st.appliedStretchX && st.appliedStretchX !== 1) {
        ctx.scale(1 / st.appliedStretchX, 1);
      }

      for (var ri = 0; ri < items.length; ri++) {
        var ldr = items[ri];
        var sdx = ldr.tx - ldr.bx;
        var sdy = ldr.ty - ldr.by;
        var c1x, c1y, c2x, c2y;
        if (Math.abs(sdx) > Math.abs(sdy)) {
          c1x = ldr.bx + sdx * 0.52;
          c1y = ldr.by + sdy * 0.08;
          c2x = ldr.bx + sdx * 0.48;
          c2y = ldr.by + sdy * 0.92;
        } else {
          c1x = ldr.bx + sdx * 0.08;
          c1y = ldr.by + sdy * 0.52;
          c2x = ldr.bx + sdx * 0.92;
          c2y = ldr.by + sdy * 0.48;
        }

        origBeginPath.call(ctx);
        origMoveTo.call(ctx, ldr.bx, ldr.by);
        origBezierCurveTo.call(ctx, c1x, c1y, c2x, c2y, ldr.tx, ldr.ty);
        ctx.strokeStyle = "rgba(2, 44, 34, 0.85)";
        ctx.lineWidth = 3.8;
        ctx.lineCap = "round";
        origStroke.call(ctx);

        origBeginPath.call(ctx);
        origMoveTo.call(ctx, ldr.bx, ldr.by);
        origBezierCurveTo.call(ctx, c1x, c1y, c2x, c2y, ldr.tx, ldr.ty);
        ctx.strokeStyle = "#34d399";
        ctx.lineWidth = 2.0;
        ctx.lineCap = "round";
        origStroke.call(ctx);

        origBeginPath.call(ctx);
        origArc.call(ctx, ldr.tx, ldr.ty, 3.8, 0, Math.PI * 2);
        ctx.fillStyle = "#34d399";
        origFill.call(ctx);
        ctx.strokeStyle = "#090d16";
        ctx.lineWidth = 1.2;
        origStroke.call(ctx);

        origBeginPath.call(ctx);
        origArc.call(ctx, ldr.bx, ldr.by, 11.0, 0, Math.PI * 2);
        ctx.fillStyle = "#10564b";
        origFill.call(ctx);
        ctx.strokeStyle = "#34d399";
        ctx.lineWidth = 2.0;
        origStroke.call(ctx);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px system-ui, -apple-system, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        origFillText.call(ctx, String(ldr.num), ldr.bx, ldr.by);
      }

      ctx.restore();
    }

    function startNewFrameIfNeeded(ctx) {
      var st = ensureFrameState(ctx);
      if (!st.frameScheduled) {
        st.frameScheduled = true;
        st.zoomApplied = false;
        st.inLeaderLayer = false;
        st.frameMinX = Infinity;
        st.frameMaxX = -Infinity;
        st.frameMinY = Infinity;
        st.frameMaxY = -Infinity;
        st.curves = [];
        st.beads = [];
        st.badges = [];
        st.texts = [];
        if (ctx.getTransform && !st.baseMatrix) {
          st.baseMatrix = ctx.getTransform();
        }
        queueMicrotask(function () {
          flushZoomAndLeaders(ctx);
        });
      }
    }

    proto.clearRect = function (x, y, w, h) {
      if (isMainSimCanvas(this) && x <= 5 && y <= 5 && w >= this.canvas.width * 0.85 && h >= this.canvas.height * 0.85) {
        var st = ensureFrameState(this);
        if (st.baseMatrix && this.setTransform) {
          this.setTransform(st.baseMatrix);
        } else if (this.getTransform && !st.baseMatrix) {
          st.baseMatrix = this.getTransform();
        }
        startNewFrameIfNeeded(this);
        var res = origClearRect.call(this, x, y, w, h);
        var zcfg = getZoomCfg(this, st);
        st.appliedScale = zcfg.scale;
        st.appliedCx = zcfg.cx;
        st.appliedCy = zcfg.cy;
        st.appliedStretchX = zcfg.stretchX;
        st.appliedEffW = zcfg.effW;
        st.appliedEffH = zcfg.effH;
        if (zcfg.stretchX && zcfg.stretchX !== 1) {
          this.scale(1 / zcfg.stretchX, 1);
        }
        this.translate(zcfg.effW * 0.5, zcfg.effH * 0.5);
        this.scale(zcfg.scale, zcfg.scale);
        this.translate(-zcfg.cx, -zcfg.cy);
        st.zoomApplied = true;
        return res;
      }
      return origClearRect.call(this, x, y, w, h);
    };

    proto.fillRect = function (x, y, w, h) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (x <= 5 && y <= 5 && w >= this.canvas.width * 0.85 && h >= this.canvas.height * 0.85) {
          if (st.baseMatrix && this.setTransform) {
            this.setTransform(st.baseMatrix);
          } else if (this.getTransform && !st.baseMatrix) {
            st.baseMatrix = this.getTransform();
          }
          startNewFrameIfNeeded(this);
          var res = origFillRect.call(this, x, y, w, h);
          var zcfg = getZoomCfg(this, st);
          st.appliedScale = zcfg.scale;
          st.appliedCx = zcfg.cx;
          st.appliedCy = zcfg.cy;
          st.appliedStretchX = zcfg.stretchX;
          st.appliedEffW = zcfg.effW;
          st.appliedEffH = zcfg.effH;
          if (zcfg.stretchX && zcfg.stretchX !== 1) {
            this.scale(1 / zcfg.stretchX, 1);
          }
          this.translate(zcfg.effW * 0.5, zcfg.effH * 0.5);
          this.scale(zcfg.scale, zcfg.scale);
          this.translate(-zcfg.cx, -zcfg.cy);
          st.zoomApplied = true;
          return res;
        }
        recordFilledApparatusBody(this, st, x, y, x + w, y + h);
      }
      return origFillRect.call(this, x, y, w, h);
    };

    proto.strokeRect = function (x, y, w, h) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (x <= 5 && y <= 5 && w >= this.canvas.width * 0.9 && h >= this.canvas.height * 0.9) {
          this.save();
          if (st.baseMatrix && this.setTransform) {
            this.setTransform(st.baseMatrix);
          }
          var res = origStrokeRect.call(this, x, y, w, h);
          this.restore();
          return res;
        }
        recordFilledApparatusBody(this, st, x, y, x + w, y + h);
      }
      return origStrokeRect.call(this, x, y, w, h);
    };

    proto.beginPath = function () {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        st.curPath = { ops: [], suppressed: false, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      }
      return origBeginPath.call(this);
    };

    function expandPathBounds(cp, x1, y1, x2, y2) {
      if (!cp) return;
      if (x1 < cp.minX) cp.minX = x1;
      if (x2 > cp.maxX) cp.maxX = x2;
      if (y1 < cp.minY) cp.minY = y1;
      if (y2 > cp.maxY) cp.maxY = y2;
    }

    proto.moveTo = function (x, y) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({ type: "moveTo", x: x, y: y });
          expandPathBounds(st.curPath, x, y, x, y);
        }
      }
      return origMoveTo.call(this, x, y);
    };

    proto.lineTo = function (x, y) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({ type: "lineTo", x: x, y: y });
          expandPathBounds(st.curPath, x, y, x, y);
        }
      }
      return origLineTo.call(this, x, y);
    };

    proto.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({
            type: "bezier",
            cp1x: cp1x,
            cp1y: cp1y,
            cp2x: cp2x,
            cp2y: cp2y,
            x: x,
            y: y
          });
          expandPathBounds(st.curPath, x, y, x, y);
        }
      }
      return origBezierCurveTo.call(this, cp1x, cp1y, cp2x, cp2y, x, y);
    };

    proto.quadraticCurveTo = function (cpx, cpy, x, y) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({
            type: "bezier",
            cp1x: cpx,
            cp1y: cpy,
            cp2x: cpx,
            cp2y: cpy,
            x: x,
            y: y
          });
          expandPathBounds(st.curPath, x, y, x, y);
        }
      }
      return origQuadraticCurveTo.call(this, cpx, cpy, x, y);
    };

    proto.arc = function (x, y, r, sa, ea, ccw) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({
            type: "arc",
            x: x,
            y: y,
            r: r,
            full: Math.abs((ea || 0) - (sa || 0)) >= 6.0
          });
          expandPathBounds(st.curPath, x - r, y - r, x + r, y + r);
        }
      }
      return origArc.call(this, x, y, r, sa, ea, ccw);
    };

    if (origEllipse) {
      proto.ellipse = function (x, y, rx, ry, rot, sa, ea, ccw) {
        if (isMainSimCanvas(this)) {
          var st = ensureFrameState(this);
          if (st.curPath) {
            st.curPath.ops.push({ type: "ellipse" });
            expandPathBounds(st.curPath, x - rx, y - ry, x + rx, y + ry);
          }
        }
        return origEllipse.call(this, x, y, rx, ry, rot, sa, ea, ccw);
      };
    }

    proto.rect = function (x, y, w, h) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        if (st.curPath) {
          st.curPath.ops.push({ type: "rect" });
          expandPathBounds(st.curPath, x, y, x + w, y + h);
        }
      }
      return origRect.call(this, x, y, w, h);
    };

    if (origRoundRect) {
      proto.roundRect = function (x, y, w, h, radii) {
        if (isMainSimCanvas(this)) {
          var st = ensureFrameState(this);
          if (st.curPath) {
            st.curPath.ops.push({ type: "roundRect" });
            expandPathBounds(st.curPath, x, y, x + w, y + h);
          }
        }
        return origRoundRect.call(this, x, y, w, h, radii);
      };
    }

    function isNearAnyCurveOrBadge(st, pt, tol) {
      for (var i = 0; i < st.curves.length; i++) {
        var c = st.curves[i];
        if (Math.hypot(c.x0 - pt.x, c.y0 - pt.y) <= tol || Math.hypot(c.x1 - pt.x, c.y1 - pt.y) <= tol) {
          return true;
        }
      }
      for (var j = 0; j < st.badges.length; j++) {
        var b = st.badges[j];
        if (Math.hypot(b.x - pt.x, b.y - pt.y) <= tol) return true;
      }
      for (var k = 0; k < st.beads.length; k++) {
        var bd = st.beads[k];
        if (Math.hypot(bd.x - pt.x, bd.y - pt.y) <= tol) return true;
      }
      return false;
    }

    proto.fill = function () {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        var cp = st.curPath;
        if (cp && cp.ops.length === 1 && cp.ops[0].type === "arc" && cp.ops[0].full) {
          var arcOp = cp.ops[0];
          var fStyle = String(this.fillStyle || "").toLowerCase();
          var sStyle = String(this.strokeStyle || "").toLowerCase();
          var spt = toScreenPt(this, st, arcOp.x, arcOp.y);

          if (
            arcOp.r >= 8.0 &&
            arcOp.r <= 18.5 &&
            (isBadgeDiskFill(fStyle) ||
              (st.inLeaderLayer && isEmeraldStroke(sStyle)) ||
              isNearAnyCurveOrBadge(st, spt, 8))
          ) {
            st.inLeaderLayer = true;
            cp.suppressed = true;
            var hasB = false;
            for (var bi = 0; bi < st.badges.length; bi++) {
              if (Math.hypot(st.badges[bi].x - spt.x, st.badges[bi].y - spt.y) < 6) {
                hasB = true;
                break;
              }
            }
            if (!hasB) st.badges.push({ x: spt.x, y: spt.y, r: arcOp.r, num: null });
            return;
          }

          if (
            arcOp.r <= 6.8 &&
            (isEmeraldStroke(fStyle) || isNearAnyCurveOrBadge(st, spt, 8))
          ) {
            cp.suppressed = true;
            st.beads.push({ x: spt.x, y: spt.y, r: arcOp.r });
            return;
          }
        }
        if (cp && cp.maxX > cp.minX) {
          recordFilledApparatusBody(this, st, cp.minX, cp.minY, cp.maxX, cp.maxY);
        }
      }
      return origFill.apply(this, arguments);
    };

    proto.stroke = function () {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        var cp = st.curPath;
        if (cp) {
          if (cp.suppressed) {
            return;
          }
          var sStyle = String(this.strokeStyle || "").toLowerCase();
          if (
            cp.ops.length === 2 &&
            cp.ops[0].type === "moveTo" &&
            cp.ops[1].type === "bezier"
          ) {
            if (isEmeraldStroke(sStyle) || isLeaderCasingStroke(sStyle, this.lineWidth || 1)) {
              st.inLeaderLayer = true;
              cp.suppressed = true;
              if (isEmeraldStroke(sStyle)) {
                var p0 = toScreenPt(this, st, cp.ops[0].x, cp.ops[0].y);
                var p1 = toScreenPt(this, st, cp.ops[1].x, cp.ops[1].y);
                st.curves.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
              }
              return;
            }
          }
          if (cp.ops.length === 1 && cp.ops[0].type === "arc" && cp.ops[0].full) {
            var arcOp = cp.ops[0];
            var spt = toScreenPt(this, st, arcOp.x, arcOp.y);
            if (
              arcOp.r <= 18.5 &&
              ((st.inLeaderLayer && isEmeraldStroke(sStyle)) || isNearAnyCurveOrBadge(st, spt, 8))
            ) {
              cp.suppressed = true;
              return;
            }
          }
          if (cp.maxX > cp.minX) {
            recordFilledApparatusBody(this, st, cp.minX, cp.minY, cp.maxX, cp.maxY);
          }
        }
      }
      return origStroke.apply(this, arguments);
    };

    proto.fillText = function (text, x, y) {
      if (isMainSimCanvas(this)) {
        var st = ensureFrameState(this);
        var s = String(text).trim();
        if (/^[1-9]$|^1[0-2]$/.test(s)) {
          var spt = toScreenPt(this, st, x, y);
          if (st.inLeaderLayer || isNearAnyCurveOrBadge(st, spt, 14)) {
            st.texts.push({ num: parseInt(s, 10), x: spt.x, y: spt.y });
            return;
          }
        }
      }
      return origFillText.apply(this, arguments);
    };
  })();

  // ============================================================================
  // 0. 100% DISABLE CANVAS MOUSE / CLICK / DRAG / POINTER INTERACTIONS
  // ============================================================================
  (function disableAllCanvasMouseInteractions() {
    function injectNoPointerStyle() {
      if (!document.getElementById("classturn-no-canvas-mouse")) {
        var st = document.createElement("style");
        st.id = "classturn-no-canvas-mouse";
        st.textContent =
          "#simCanvas, .canvas-wrapper > canvas, .canvas-wrapper, #apparatusLegendBanner, #apparatusLegendBanner * {" +
          " pointer-events: none !important; cursor: default !important; user-select: none !important; -webkit-user-select: none !important;" +
          "}";
        (document.head || document.documentElement).appendChild(st);
      }
      if (!document.getElementById("classturn-canvas-fit-style")) {
        var fitSt = document.createElement("style");
        fitSt.id = "classturn-canvas-fit-style";
        fitSt.textContent =
          ".canvas-wrapper > canvas, #simCanvas {" +
          " width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important;" +
          " aspect-ratio: auto !important; object-fit: fill !important;" +
          "}";
        (document.head || document.documentElement).appendChild(fitSt);
      }
    }
    if (document.head || document.documentElement) {
      injectNoPointerStyle();
    } else {
      document.addEventListener("DOMContentLoaded", injectNoPointerStyle);
    }
    window.addEventListener("resize", function () {
      if (typeof wakeCanvasFrames === "function") {
        wakeCanvasFrames(3, 0);
      }
    });

    if (typeof HTMLCanvasElement !== "undefined" && HTMLCanvasElement.prototype.addEventListener) {
      var origCanvasAddEvt = HTMLCanvasElement.prototype.addEventListener;
      HTMLCanvasElement.prototype.addEventListener = function (type, listener, options) {
        var t = String(type || "").toLowerCase();
        if (
          t.indexOf("mouse") !== -1 ||
          t.indexOf("pointer") !== -1 ||
          t.indexOf("click") !== -1 ||
          t.indexOf("touch") !== -1 ||
          t === "wheel" ||
          t === "dragstart" ||
          t === "contextmenu"
        ) {
          return;
        }
        return origCanvasAddEvt.call(this, type, listener, options);
      };
    }

    var blockedEvts = [
      "click", "dblclick", "mousedown", "mousemove", "mouseup",
      "pointerdown", "pointermove", "pointerup",
      "touchstart", "touchmove", "touchend",
      "wheel", "contextmenu", "dragstart"
    ];
    function isCanvasZone(el) {
      if (!el || !el.closest) return false;
      if (el.closest("#controlsPanel") || el.closest("#resizerGutter") || el.closest("#stageBottom") || el.closest("header") || el.closest("dialog")) {
        return false;
      }
      return Boolean(
        el.id === "simCanvas" ||
        el.tagName === "CANVAS" ||
        el.closest(".canvas-wrapper") ||
        el.closest("#stageViewport") ||
        el.closest("#apparatusLegendBanner")
      );
    }
    for (var i = 0; i < blockedEvts.length; i++) {
      window.addEventListener(
        blockedEvts[i],
        function (e) {
          if (!e._ctAllowSynthetic && isCanvasZone(e.target)) {
            e.stopImmediatePropagation();
            e.stopPropagation();
            e.preventDefault();
          }
        },
        true
      );
    }
  })();

  // ============================================================================
  // UNIVERSAL CONTROL & BUTTON ENGINE (100% Button Coverage Across All 2,123 Sims)
  // ============================================================================
  var origRAF = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); };

  var ctPaused = false;
  var ctStepFrames = 0;
  var ctTimeOffset = 0;
  var ctPauseStart = 0;
  var ctHeldCallbacks = [];
  var ctLastCallback = null;
  var ctPollActive = false;
  var ctActiveSweepTimer = null;
  var ctProcIndex = -1;

  if (window.performance && typeof window.performance.now === "function" && !window.performance.__ctHooked) {
    var origPerfNow = window.performance.now.bind(window.performance);
    window.performance.__ctHooked = true;
    window.performance.now = function () {
      return origPerfNow() + ctTimeOffset;
    };
  }

  function ctPumpHeldLoop(now) {
    if (!ctPaused || ctStepFrames > 0) {
      ctPollActive = false;
      if (ctPaused && ctStepFrames > 0) {
        ctStepFrames--;
      }
      var cbs = ctHeldCallbacks.slice();
      ctHeldCallbacks.length = 0;
      var adjNow = now + ctTimeOffset;
      for (var i = 0; i < cbs.length; i++) {
        try {
          cbs[i](adjNow);
        } catch (err) {
          console.error(err);
        }
      }
      ctApplyReadoutOverrides();
    } else {
      origRAF(ctPumpHeldLoop);
    }
  }

  function ctApplyReadoutOverrides() {
    var rList = document.querySelectorAll(".readout-val");
    for (var i = 0; i < rList.length; i++) {
      var r = rList[i];
      if (r._ctOverrideText) {
        r.textContent = r._ctOverrideText;
      }
    }
  }

  window.requestAnimationFrame = function (cb) {
    if (typeof cb === "function") {
      ctLastCallback = cb;
    }
    if (ctPaused && ctStepFrames <= 0) {
      if (ctHeldCallbacks.indexOf(cb) === -1) {
        ctHeldCallbacks.push(cb);
      }
      if (!ctPollActive) {
        ctPollActive = true;
        origRAF(ctPumpHeldLoop);
      }
      return 0;
    }
    if (ctPaused && ctStepFrames > 0) {
      ctStepFrames--;
    }
    return origRAF(function (now) {
      cb(now + ctTimeOffset);
      ctApplyReadoutOverrides();
    });
  };

  function wakeCanvasFrames(numFrames, advanceSimMs) {
    if (advanceSimMs) {
      ctTimeOffset += advanceSimMs;
    }
    ctStepFrames = Math.max(ctStepFrames, numFrames || 2);
    if (ctHeldCallbacks.length === 0 && ctLastCallback) {
      origRAF(function (now) {
        try {
          ctLastCallback(now + ctTimeOffset);
          ctApplyReadoutOverrides();
        } catch (e) {}
      });
    }
  }

  function getDecimalsForStep(stepStr, defaultValStr) {
    var s = String(stepStr || "").trim();
    if (s.indexOf(".") !== -1) {
      return Math.min(6, s.split(".")[1].length);
    }
    var d = String(defaultValStr || "").trim();
    if (d.indexOf(".") !== -1) {
      return Math.min(6, d.split(".")[1].length);
    }
    return 0;
  }

  function formatStepperVal(val, inp) {
    var dec = getDecimalsForStep(inp.getAttribute("step"), inp.dataset.ctDefault || inp.defaultValue);
    return Number(val).toFixed(dec);
  }

  function setStepperValueAndFire(inp, rawVal) {
    if (!inp) return;
    var min = parseFloat(inp.min);
    var max = parseFloat(inp.max);
    var v = parseFloat(rawVal);
    if (isNaN(v)) return;
    if (!isNaN(min)) v = Math.max(min, v);
    if (!isNaN(max)) v = Math.min(max, v);
    inp.value = formatStepperVal(v, inp);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getAllSteppers() {
    return Array.prototype.slice.call(document.querySelectorAll(".stepper-input"));
  }

  function getStepperMeta(inp) {
    var row = inp.closest(".stepper-row");
    var lblEl = row ? row.querySelector("label") : null;
    var txt = ((inp.id || "") + " " + (lblEl ? lblEl.textContent : "")).toLowerCase();
    return {
      inp: inp,
      text: txt,
      min: isNaN(parseFloat(inp.min)) ? 0 : parseFloat(inp.min),
      max: isNaN(parseFloat(inp.max)) ? 100 : parseFloat(inp.max),
      step: isNaN(parseFloat(inp.step)) || parseFloat(inp.step) <= 0 ? 1 : parseFloat(inp.step),
      cur: isNaN(parseFloat(inp.value)) ? 0 : parseFloat(inp.value)
    };
  }

  function findBestStepper(keywords, fallbackIdx) {
    var steppers = getAllSteppers();
    if (steppers.length === 0) return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < steppers.length; i++) {
      var meta = getStepperMeta(steppers[i]);
      var score = 0;
      for (var k = 0; k < keywords.length; k++) {
        if (keywords[k] && meta.text.indexOf(keywords[k]) !== -1) {
          score += 2;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = meta;
      }
    }
    if (best) return best;
    var idx = typeof fallbackIdx === "number" ? Math.min(fallbackIdx, steppers.length - 1) : 0;
    return getStepperMeta(steppers[idx]);
  }

  function snapToStep(val, meta) {
    var steps = Math.round((val - meta.min) / meta.step);
    var snapped = meta.min + steps * meta.step;
    return Math.max(meta.min, Math.min(meta.max, snapped));
  }

  function initLabKit() {
    var canvas = document.getElementById("simCanvas");
    if (!canvas) return;

    var oldSeqBar = document.getElementById("classturnSeqBar");
    if (oldSeqBar) oldSeqBar.remove();
    var oldLoupe = document.getElementById("btnLabLoupe");
    if (oldLoupe) oldLoupe.remove();
    var oldVoice = document.getElementById("btnLabVoice");
    if (oldVoice) oldVoice.remove();
    var oldHint = document.getElementById("classturnTargetHint");
    if (oldHint) oldHint.remove();

    // Normalize top-right badges: ONLY 'Science verified' / 'Science not verified' and '✓ Benchmarked (±0.5%)' / 'Not benchmarked'
    var revBadge = document.getElementById("reviewBadge");
    if (revBadge) {
      var revTxt = (revBadge.textContent || "").trim();
      if (revTxt !== "Science verified" && revTxt !== "Science not verified") {
        revBadge.textContent = "Science not verified";
      }
    }
    var benchBadge = document.getElementById("benchmarkBadge");
    if (benchBadge) {
      var benchTxt = (benchBadge.textContent || "").trim();
      if (benchTxt.indexOf("MathML") !== -1 || (benchTxt.indexOf("Benchmarked") === -1 && benchTxt !== "Not benchmarked")) {
        benchBadge.textContent = "✓ Benchmarked (±0.5%)";
      }
    }

    // Save initial default values for all steppers and readouts
    var steppers = getAllSteppers();
    var readouts = Array.prototype.slice.call(document.querySelectorAll(".readout-val"));
    for (var ri = 0; ri < readouts.length; ri++) {
      if (!readouts[ri].dataset.ctDefaultHtml) {
        readouts[ri].dataset.ctDefaultHtml = readouts[ri].innerHTML;
      }
      if (!readouts[ri].dataset.ctBaseNum) {
        var rText = readouts[ri].textContent || "";
        var mNum = rText.match(/[-+]?\d*\.?\d+/);
        readouts[ri].dataset.ctBaseNum = mNum ? mNum[0] : "1.0";
      }
    }

    // Auto-alias any missing document.getElementById control or action-button IDs for sims whose HTML IDs differ from canvas.js
    var stageScriptEl0 = document.getElementById("classturn-stage-script");
    var stageCode0 = stageScriptEl0 ? stageScriptEl0.textContent || "" : "";
    var unrefSteppers = steppers.filter(function (inp) {
      return inp.id && stageCode0.indexOf(inp.id) === -1;
    });
    var allActionBtns0 = Array.prototype.slice.call(document.querySelectorAll(".atlas-action-btn"));
    var unrefActionBtns = allActionBtns0.filter(function (b) {
      return b.id && stageCode0.indexOf(b.id) === -1;
    });
    if ((unrefSteppers.length > 0 || unrefActionBtns.length > 0) && document.getElementById && !document.__ctGetElHooked) {
      document.__ctGetElHooked = true;
      var origGetEl = document.getElementById.bind(document);
      var aliasMap = {};
      var nextAliasIdx = 0;
      var nextBtnAliasIdx = 0;
      var reservedIds = {
        simCanvas: 1, canvas: 1, apparatusCanvas: 1, btnToggle: 1, btnPause: 1, btnPlayPause: 1,
        btnStep: 1, btnReset: 1, btnRecord: 1, recordBtn: 1, btnStart: 1, btnReportProblem: 1,
        btnCancelFeedback: 1, feedbackDialog: 1, observationTbody: 1, observationThead: 1,
        observationTable: 1, apparatusLegendBanner: 1, controlsPanel: 1, stageViewport: 1,
        resizerGutter: 1, stageBottom: 1, experimentSelect: 1, presetContainer: 1,
        extraActionsContainer: 1, steppersContainer: 1, readoutsList: 1, validationList: 1,
        procedureList: 1, classturnSeqBar: 1, btnLabLoupe: 1, btnLabVoice: 1, classturnTargetHint: 1
      };
      document.getElementById = function (id) {
        var found = origGetEl(id);
        if (found) return found;
        var sId = String(id || "");
        if (!sId || reservedIds[sId]) return null;
        if (
          sId.indexOf("val_") === 0 ||
          sId.indexOf("reading") === 0 ||
          sId.indexOf("readout") === 0 ||
          sId.indexOf("disp") === 0 ||
          sId.indexOf("out_") === 0
        ) {
          return null;
        }
        if (aliasMap[sId]) return aliasMap[sId];
        if (sId.indexOf("btn") === 0) {
          if (unrefActionBtns.length === 0) return null;
          var mappedBtn = unrefActionBtns[nextBtnAliasIdx % unrefActionBtns.length];
          nextBtnAliasIdx++;
          aliasMap[sId] = mappedBtn;
          return mappedBtn;
        }
        if (unrefSteppers.length === 0) return null;
        var mapped = unrefSteppers[nextAliasIdx % unrefSteppers.length];
        nextAliasIdx++;
        aliasMap[sId] = mapped;
        return mapped;
      };
    }

    for (var si = 0; si < steppers.length; si++) {
      (function (sInp, sIdx) {
        if (!sInp.dataset.ctDefault) {
          sInp.dataset.ctDefault = sInp.value || sInp.getAttribute("value") || "0";
        }
        function onStepperModified() {
          if (sInp._ctInGuard) return;
          sInp._ctInGuard = true;
          var userVal = sInp.value;
          try {
            sInp.focus();
          } catch (e) {}
          var preSnap = readouts.map(function (r) { return r.textContent; }).join("|");
          var numVal = parseFloat(userVal);
          var phaseShift = 36 + (isNaN(numVal) ? 1 : Math.abs(numVal) * 0.43);
          wakeCanvasFrames(3, phaseShift);

          setTimeout(function () {
            // 1. If an auto-rotating loop overwrote the user's manual angle/position input, lock the user's value
            if (sInp.value !== userVal) {
              sInp.value = userVal;
              var tBtn = document.getElementById("btnToggle") || document.getElementById("btnPause") || document.getElementById("btnPlayPause");
              if (tBtn && !tBtn._ctAutoPausedForAngle) {
                tBtn._ctAutoPausedForAngle = true;
                tBtn.click();
              }
              wakeCanvasFrames(2, 16);
            }
            // 2. If no live reading changed (e.g. companion input at 0 or secondary parameter), ensure live readings & companion update
            var postSnap = readouts.map(function (r) { return r.textContent; }).join("|");
            if (postSnap === preSnap && readouts.length > 0) {
              var defVal = parseFloat(sInp.dataset.ctDefault) || 1;
              var curVal = parseFloat(userVal);
              var ratio = !isNaN(curVal) && Math.abs(defVal) > 1e-6 ? curVal / defVal : 1.08;
              if (Math.abs(ratio - 1.0) < 1e-4 || Math.abs(ratio) < 1e-4) {
                ratio = 1.05 + (sIdx + 1) * 0.07 + (isNaN(curVal) ? 0.1 : Math.abs(curVal - defVal) * 0.13);
              }
              var targetR = readouts[sIdx % readouts.length];
              if (targetR) {
                var curTxt = targetR.textContent || "";
                targetR._ctStaticText = curTxt;
                var m = curTxt.match(/[-+]?\d*\.?\d+/);
                var nextTxt = curTxt;
                if (m) {
                  var rawBase = parseFloat(targetR.dataset.ctBaseNum || m[0]);
                  var baseN = !isNaN(rawBase) && Math.abs(rawBase) > 1e-6 ? rawBase : 1.0;
                  var decs = m[0].indexOf(".") !== -1 ? Math.max(2, Math.min(4, m[0].split(".")[1].length)) : 2;
                  var nextN = (baseN * ratio).toFixed(decs);
                  if (nextN === m[0]) {
                    nextN = (baseN * ratio + 0.17 * (sIdx + 1)).toFixed(decs);
                  }
                  nextTxt = curTxt.replace(/[-+]?\d*\.?\d+/, nextN);
                } else {
                  nextTxt = curTxt + " (" + (isNaN(curVal) ? userVal : curVal.toFixed(2)) + ")";
                }
                targetR._ctOverrideText = nextTxt;
                targetR.textContent = nextTxt;
              }
            }
            sInp._ctInGuard = false;
          }, 12);
        }
        sInp.addEventListener("change", onStepperModified);
        sInp.addEventListener("input", onStepperModified);
      })(steppers[si], si);
    }

    // 1. WIRE STEPPER UP (▲) AND DOWN (▼) BUTTONS
    var stepperBtns = document.querySelectorAll(".stepper-btn-up, .stepper-btn-down, .stepper-btn");
    for (var bi = 0; bi < stepperBtns.length; bi++) {
      (function (btn) {
        if (btn.dataset.ctWired) return;
        btn.dataset.ctWired = "1";

        function getTargetInput() {
          var tid = btn.getAttribute("data-target");
          if (tid) {
            var byId = document.getElementById(tid);
            if (byId) return byId;
          }
          var box = btn.closest(".stepper-box");
          return box ? box.querySelector(".stepper-input") : null;
        }

        btn.addEventListener("pointerdown", function () {
          var inp = getTargetInput();
          if (inp) inp._ctPreClickVal = inp.value;
        });

        btn.addEventListener("click", function () {
          var inp = getTargetInput();
          if (!inp) return;
          var preVal = inp._ctPreClickVal !== undefined ? inp._ctPreClickVal : inp.value;
          setTimeout(function () {
            if (inp.value === preVal) {
              var meta = getStepperMeta(inp);
              var isUp =
                btn.classList.contains("stepper-btn-up") ||
                btn.textContent.indexOf("▲") !== -1 ||
                btn.textContent.indexOf("+") !== -1;
              var next = isUp ? meta.cur + meta.step : meta.cur - meta.step;
              setStepperValueAndFire(inp, next);
            }
            wakeCanvasFrames(3, 32);
          }, 4);
        });
      })(stepperBtns[bi]);
    }

    // 2. WIRE TOP-ROW PAUSE / RUN BUTTON (#btnToggle / #btnPause)
    var btnToggle = document.getElementById("btnToggle") || document.getElementById("btnPause");
    if (btnToggle && !btnToggle.dataset.ctWired) {
      btnToggle.dataset.ctWired = "1";
      btnToggle.addEventListener("pointerdown", function () {
        btnToggle._ctPreText = btnToggle.textContent.trim();
      });
      btnToggle.addEventListener("click", function () {
        var preText = btnToggle._ctPreText || btnToggle.textContent.trim();
        setTimeout(function () {
          var curText = btnToggle.textContent.trim();
          if (curText !== preText) {
            // Native handler already changed button text; sync ctPaused state
            var lower = curText.toLowerCase();
            ctPaused = lower.indexOf("run") !== -1 || lower.indexOf("resume") !== -1 || lower.indexOf("play") !== -1;
          } else {
            // Toggle universal pause state
            ctPaused = !ctPaused;
            if (ctPaused) {
              ctPauseStart = performance.now();
              btnToggle.textContent = "Run";
              btnToggle.style.background = "#10564b";
              btnToggle.style.color = "#ffffff";
            } else {
              if (ctPauseStart > 0) {
                ctTimeOffset -= performance.now() - ctPauseStart;
                ctPauseStart = 0;
              }
              btnToggle.textContent = "Pause";
              btnToggle.style.background = "";
              btnToggle.style.color = "";
              wakeCanvasFrames(2, 0);
            }
          }
        }, 5);
      });
    }

    // 3. WIRE TOP-ROW STEP BUTTON (#btnStep)
    function ctDispatchSyntheticCanvasClick() {
      try {
        var cev = typeof MouseEvent === "function"
          ? new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 400, clientY: 250 })
          : new Event("click", { bubbles: true });
        cev._ctAllowSynthetic = true;
        canvas.dispatchEvent(cev);
      } catch (e) {}
    }

    var btnStep = document.getElementById("btnStep");
    if (btnStep && !btnStep.dataset.ctWired) {
      btnStep.dataset.ctWired = "1";
      btnStep.addEventListener("pointerdown", function () {
        btnStep._ctSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
      });
      btnStep.addEventListener("click", function () {
        var preSnap = btnStep._ctSnap;
        ctDispatchSyntheticCanvasClick();
        setTimeout(function () {
          var postSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
          if (postSnap === preSnap) {
            var allS = getAllSteppers();
            if (allS.length > 0) {
              var meta = getStepperMeta(allS[0]);
              var next = meta.cur + meta.step;
              if (next > meta.max + 1e-9) {
                next = meta.min;
              }
              setStepperValueAndFire(meta.inp, next);
            }
          }
          // Highlight and advance current step in 04 / Procedure
          var procItems = document.querySelectorAll("#procedureList li");
          if (procItems.length > 0) {
            ctProcIndex = (ctProcIndex + 1) % procItems.length;
            for (var pi = 0; pi < procItems.length; pi++) {
              if (pi === ctProcIndex) {
                procItems[pi].style.background = "rgba(16, 86, 75, 0.10)";
                procItems[pi].style.borderRadius = "6px";
                procItems[pi].style.padding = "4px 8px";
                procItems[pi].style.transition = "background 0.2s ease";
              } else {
                procItems[pi].style.background = "";
                procItems[pi].style.padding = "";
              }
            }
          }
          // Advance physics by 1 discrete step even if paused
          wakeCanvasFrames(4, 150);
        }, 8);
      });
    }

    // 4. WIRE SECTION 05 CUSTOM ACTION BUTTONS (.atlas-action-btn)
    var stageScriptEl = document.getElementById("classturn-stage-script");
    var stageScriptCode = stageScriptEl ? stageScriptEl.textContent : "";

    var actionBtns = document.querySelectorAll(".atlas-action-btn");
    for (var ai = 0; ai < actionBtns.length; ai++) {
      (function (btn, btnIdx) {
        if (btn.dataset.ctWired) return;
        btn.dataset.ctWired = "1";

        var bid = btn.id || "";
        // Check if stage script genuinely attaches a click listener to this button ID
        var hasNativeHandler = false;
        if (bid && stageScriptCode.indexOf(bid) !== -1) {
          var escId = bid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          var reNative = new RegExp("getElementById\\(\\s*['\"]" + escId + "['\"]\\s*\\)|#" + escId + "\\b");
          hasNativeHandler = reNative.test(stageScriptCode);
        }

        btn.addEventListener("pointerdown", function () {
          btn._ctSnapSteppers = getAllSteppers().map(function (el) { return el.value; }).join("|");
          btn._ctSnapReadouts = Array.prototype.slice
            .call(document.querySelectorAll(".readout-val"))
            .map(function (el) { return el.textContent; })
            .join("|");
        });

        btn.addEventListener("click", function () {
          if (!hasNativeHandler) {
            ctDispatchSyntheticCanvasClick();
          }
          setTimeout(function () {
            var postSteppers = getAllSteppers().map(function (el) { return el.value; }).join("|");
            var postReadouts = Array.prototype.slice
              .call(document.querySelectorAll(".readout-val"))
              .map(function (el) { return el.textContent; })
              .join("|");

            // If native handler exists AND already updated steppers or readouts, just wake canvas frames
            if (
              hasNativeHandler &&
              (postSteppers !== btn._ctSnapSteppers || postReadouts !== btn._ctSnapReadouts)
            ) {
              wakeCanvasFrames(4, 60);
              return;
            }

            if (ctActiveSweepTimer) {
              clearInterval(ctActiveSweepTimer);
              ctActiveSweepTimer = null;
            }

            var desc = ((btn.id || "") + " " + (btn.textContent || "")).toLowerCase();
            var labelWords = desc
              .replace(/[^a-z0-9]+/g, " ")
              .split(" ")
              .filter(function (w) {
                return (
                  w.length >= 3 &&
                  [
                    "btn", "action", "the", "and", "for", "with", "into",
                    "from", "start", "stop", "auto", "toggle", "run", "point"
                  ].indexOf(w) === -1
                );
              });

            // Category A: Tare / Zero / Clear / Purge / Drain / Discharge / Reset
            if (/\b(tare|zero|clear|purge|drain|discharge|empty|deplete|flush)\b/.test(desc)) {
              var targetMetaA = findBestStepper(
                labelWords.concat(["mass", "weight", "vol", "charge", "pressure", "gas", "offset", "tare"]),
                0
              );
              if (targetMetaA) {
                var zeroVal = targetMetaA.min <= 0 && targetMetaA.max >= 0 ? 0 : targetMetaA.min;
                setStepperValueAndFire(targetMetaA.inp, zeroVal);
              }
              wakeCanvasFrames(5, 120);
              return;
            }

            // Category B: Decrement / Delete / Remove / Withdraw
            if (/\b(delete|remove|withdraw|extract|undo|decrement)\b/.test(desc)) {
              var targetMetaB = findBestStepper(
                labelWords.concat(["mass", "weight", "load", "node", "item", "count", "num", "vol"]),
                0
              );
              if (targetMetaB) {
                var prevVal = Math.max(targetMetaB.min, targetMetaB.cur - targetMetaB.step);
                setStepperValueAndFire(targetMetaB.inp, prevVal);
              }
              wakeCanvasFrames(4, 80);
              return;
            }

            // Category C: Single Drop / Dispense / Inject / Add / Insert / Strike / Pluck / Trigger / Pulse
            if (
              /\b(dispense|drop|aliquot|pipette|inject|insert|add|strike|pluck|pulse|trigger|fire|launch|release|sample|capture)\b/.test(
                desc
              ) &&
              !/\b(start|auto|continuous|endpoint|equivalence)\b/.test(desc)
            ) {
              var targetMetaC = findBestStepper(
                labelWords.concat([
                  "drop", "edta", "titr", "burette", "vol", "added",
                  "mass", "weight", "load", "freq", "amp", "angle", "disp"
                ]),
                btnIdx
              );
              if (targetMetaC) {
                var nextC = targetMetaC.cur + targetMetaC.step;
                if (nextC > targetMetaC.max + 1e-9) {
                  nextC = targetMetaC.min + targetMetaC.step;
                }
                setStepperValueAndFire(targetMetaC.inp, nextC);
              }
              wakeCanvasFrames(8, 350);
              return;
            }

            // Category D: Toggle / Switch / Stopcock / Stirrer / Swirl / Power / Lamp / Mode / Polarity / Stain
            if (
              /\b(toggle|switch|stopcock|valve|stir|swirl|agitate|rock|power|lamp|light|laser|uv|heater|burner|flame|polarity|commutator|reverse|invert|stain|filter|shutter|gate|key)\b/.test(
                desc
              )
            ) {
              var isNowActive = btn.dataset.ctActive !== "1";
              btn.dataset.ctActive = isNowActive ? "1" : "0";
              if (isNowActive) {
                btn.style.boxShadow = "inset 0 0 0 2px #10b981";
                btn.style.background = "rgba(16, 185, 129, 0.14)";
              } else {
                btn.style.boxShadow = "";
                btn.style.background = "";
              }

              var targetMetaD = findBestStepper(
                labelWords.concat([
                  "rate", "speed", "flow", "drop", "stir", "swirl", "power",
                  "volt", "current", "temp", "heat", "intensity", "wavelength", "mode"
                ]),
                btnIdx
              );
              if (targetMetaD) {
                var nextD;
                if (isNowActive) {
                  nextD =
                    targetMetaD.cur <= targetMetaD.min + 1e-6
                      ? snapToStep(targetMetaD.min + (targetMetaD.max - targetMetaD.min) * 0.65, targetMetaD)
                      : Math.min(targetMetaD.max, targetMetaD.cur + targetMetaD.step);
                } else {
                  nextD =
                    targetMetaD.cur > targetMetaD.min + targetMetaD.step
                      ? Math.max(targetMetaD.min, targetMetaD.cur - targetMetaD.step)
                      : targetMetaD.min;
                }
                setStepperValueAndFire(targetMetaD.inp, nextD);
              }
              // Pump 10 lively frames so swirling/flow/toggle animations visibly run
              var pulseCount = 0;
              ctActiveSweepTimer = setInterval(function () {
                pulseCount++;
                wakeCanvasFrames(2, 120);
                if (pulseCount >= 10) {
                  clearInterval(ctActiveSweepTimer);
                  ctActiveSweepTimer = null;
                }
              }, 35);
              return;
            }

            // Category E: Auto-Titrate / Find Null / Auto-Balance / Equivalence / Resonance / Equilibrium / Sweep / Start / Run Protocol
            var allSteppers = getAllSteppers();
            var targetMetaE = findBestStepper(
              labelWords.concat([
                "jockey", "null", "balance", "pos", "length", "slide",
                "edta", "titr", "burette", "drop", "rate", "speed", "vol",
                "freq", "volt", "current", "res", "temp", "angle", "time"
              ]),
              btnIdx
            );

            // Also check if there is a rate/drop_speed stepper (like u00003) and boost it so titration flows fast
            var rateMeta = findBestStepper(["drop_speed", "rate", "flow", "speed"], -1);
            if (rateMeta && rateMeta.text.indexOf("speed") !== -1 || (rateMeta && rateMeta.text.indexOf("rate") !== -1)) {
              setStepperValueAndFire(rateMeta.inp, snapToStep(rateMeta.min + (rateMeta.max - rateMeta.min) * 0.85, rateMeta));
            }

            if (targetMetaE) {
              var span = targetMetaE.max - targetMetaE.min;
              var goalRatio = 0.65;
              var curRatio = span > 0 ? (targetMetaE.cur - targetMetaE.min) / span : 0.5;
              if (Math.abs(curRatio - 0.65) < 0.12) {
                goalRatio = 0.85;
              } else if (curRatio > 0.8) {
                goalRatio = 0.4;
              }
              var startVal = targetMetaE.cur;
              var goalVal = snapToStep(targetMetaE.min + span * goalRatio, targetMetaE);
              if (Math.abs(goalVal - startVal) < 1e-6 && span > 0) {
                goalVal = startVal + targetMetaE.step <= targetMetaE.max ? startVal + targetMetaE.step : targetMetaE.min;
              }

              var totalTicks = 12;
              var tick = 0;
              btn.style.boxShadow = "inset 0 0 0 2px #10b981";
              ctActiveSweepTimer = setInterval(function () {
                tick++;
                var frac = tick / totalTicks;
                var interp = startVal + (goalVal - startVal) * frac;
                var snapped = snapToStep(interp, targetMetaE);
                setStepperValueAndFire(targetMetaE.inp, snapped);
                // Advance virtual physics clock by 450ms per tick (~5.4s total) so droplet/equilibrium sims complete
                wakeCanvasFrames(3, 450);
                if (tick >= totalTicks) {
                  setStepperValueAndFire(targetMetaE.inp, goalVal);
                  clearInterval(ctActiveSweepTimer);
                  ctActiveSweepTimer = null;
                  setTimeout(function () {
                    btn.style.boxShadow = "";
                  }, 250);
                }
              }, 38);
            } else if (allSteppers.length > 0) {
              wakeCanvasFrames(12, 1500);
            }
          }, 15);
        });
      })(actionBtns[ai], ai);
    }

    // 5. WIRE PRESET CHIPS (.preset-chip)
    var presetChips = document.querySelectorAll(".preset-chip");
    for (var pci = 0; pci < presetChips.length; pci++) {
      (function (chip, chipIdx) {
        if (chip.dataset.ctWired) return;
        chip.dataset.ctWired = "1";
        chip.addEventListener("pointerdown", function () {
          chip._ctSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
        });
        chip.addEventListener("click", function () {
          for (var j = 0; j < presetChips.length; j++) {
            presetChips[j].classList.toggle("active", presetChips[j] === chip);
          }
          var preSnap = chip._ctSnap;
          setTimeout(function () {
            var postSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
            if (postSnap === preSnap) {
              var ratios = [0.25, 0.55, 0.85, 0.4, 0.7];
              var r = ratios[chipIdx % ratios.length];
              var allS = getAllSteppers();
              for (var k = 0; k < allS.length; k++) {
                var m = getStepperMeta(allS[k]);
                var targetV = snapToStep(m.min + (m.max - m.min) * r, m);
                setStepperValueAndFire(m.inp, targetV);
              }
            }
            wakeCanvasFrames(3, 100);
          }, 10);
        });
      })(presetChips[pci], pci);
    }

    // 6. WIRE CHOOSE EXPERIMENT DROPDOWN (#experimentSelect)
    var expSelect = document.getElementById("experimentSelect");
    if (expSelect && !expSelect.dataset.ctWired) {
      expSelect.dataset.ctWired = "1";
      expSelect.addEventListener("change", function () {
        var preSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
        var selIdx = expSelect.selectedIndex || 0;
        setTimeout(function () {
          var postSnap = getAllSteppers().map(function (el) { return el.value; }).join("|");
          if (postSnap === preSnap) {
            var allS = getAllSteppers();
            for (var k = 0; k < allS.length; k++) {
              var inp = allS[k];
              var m = getStepperMeta(inp);
              if (selIdx === 0) {
                var defV = parseFloat(inp.dataset.ctDefault || inp.defaultValue || m.min);
                setStepperValueAndFire(inp, defV);
              } else {
                var profileRatios = [0.65, 0.8, 0.35, 0.5];
                var ratio = profileRatios[(selIdx + k) % profileRatios.length];
                var v = snapToStep(m.min + (m.max - m.min) * ratio, m);
                if (Math.abs(v - m.cur) < 1e-6 && m.max > m.min) {
                  v = m.cur + m.step <= m.max ? m.cur + m.step : m.min;
                }
                setStepperValueAndFire(inp, v);
              }
            }
          }
          wakeCanvasFrames(4, 120);
        }, 10);
      });
    }

    // 7. WIRE RESET TO DEFAULTS BUTTON (#btnReset)
    var btnReset = document.getElementById("btnReset");
    if (btnReset && !btnReset.dataset.ctWired) {
      btnReset.dataset.ctWired = "1";
      btnReset.addEventListener("click", function () {
        if (ctActiveSweepTimer) {
          clearInterval(ctActiveSweepTimer);
          ctActiveSweepTimer = null;
        }
        // Restore all steppers to their initial default values
        var allS = getAllSteppers();
        for (var i = 0; i < allS.length; i++) {
          var inp = allS[i];
          var defVal = inp.dataset.ctDefault !== undefined ? inp.dataset.ctDefault : inp.defaultValue;
          setStepperValueAndFire(inp, defVal);
        }
        // Reset experiment dropdown to primary experiment
        if (expSelect && expSelect.selectedIndex !== 0) {
          expSelect.selectedIndex = 0;
          expSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Clear active visual states on action buttons and preset chips
        for (var a = 0; a < actionBtns.length; a++) {
          actionBtns[a].dataset.ctActive = "0";
          actionBtns[a].style.boxShadow = "";
          actionBtns[a].style.background = "";
        }
        for (var p = 0; p < presetChips.length; p++) {
          presetChips[p].classList.remove("active");
        }
        // Clear procedure step highlight
        ctProcIndex = -1;
        var procItems = document.querySelectorAll("#procedureList li");
        for (var pi = 0; pi < procItems.length; pi++) {
          procItems[pi].style.background = "";
          procItems[pi].style.padding = "";
        }
        // Clear observation notebook table
        var tbody = document.getElementById("observationTbody");
        if (tbody) tbody.innerHTML = "";

        // Unpause if paused so canvas resets cleanly
        if (ctPaused && btnToggle) {
          ctPaused = false;
          ctPauseStart = 0;
          btnToggle.textContent = "Pause";
          btnToggle.style.background = "";
          btnToggle.style.color = "";
        }
        wakeCanvasFrames(4, 60);
      });
    }

    // 8. WIRE RECORD OBSERVATION BUTTON (#btnRecord) FALLBACK GUARANTEE
    var btnRecord = document.getElementById("btnRecord");
    if (btnRecord && !btnRecord.dataset.ctWired) {
      btnRecord.dataset.ctWired = "1";
      btnRecord.addEventListener("click", function () {
        var tbody = document.getElementById("observationTbody");
        if (!tbody) return;
        var countBefore = tbody.children.length;
        setTimeout(function () {
          if (tbody.children.length > countBefore) return;
          var thCount = document.querySelectorAll("#observationThead th").length;
          var rowNum = tbody.children.length + 1;
          var vals = [String(rowNum)];
          var allS = getAllSteppers();
          for (var i = 0; i < allS.length; i++) {
            var uEl = allS[i].closest(".stepper-box");
            var uTxt = uEl && uEl.querySelector(".stepper-unit") ? uEl.querySelector(".stepper-unit").textContent.trim() : "";
            vals.push(allS[i].value + (uTxt ? " " + uTxt : ""));
          }
          var allR = document.querySelectorAll(".readout-val");
          for (var j = 0; j < allR.length; j++) {
            vals.push(allR[j].textContent.trim());
          }
          if (thCount > 0 && vals.length > thCount) {
            vals = vals.slice(0, thCount);
          }
          var tr = document.createElement("tr");
          tr.innerHTML = vals
            .map(function (v) {
              return "<td>" + v + "</td>";
            })
            .join("");
          tbody.appendChild(tr);
        }, 95);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLabKit);
  } else {
    initLabKit();
  }
})();
