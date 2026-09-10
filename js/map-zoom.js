// Lightweight pan/zoom controller for an inline SVG, driven purely by viewBox
// changes (no CSS transforms, so hit-testing on the underlying paths stays exact).
//
// Dispatches a "country-click" CustomEvent on the svg (detail: { iso }) whenever
// a tap/click lands without having dragged, so callers don't need to fight with
// pointer capture redirecting the native "click" event mid-drag.
class MapZoom {
  constructor(svg, { minScale = 1, maxScale = 30, initialView = null } = {}) {
    this.svg = svg;
    const [x, y, w, h] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    // this.base is the outer pan/zoom-out bound (the full world, or the full
    // continent extent) - it must stay the *un*cropped box, not fitted to the
    // container's aspect ratio. this.defaultView is what's actually shown at
    // rest, cropped to the container's aspect (e.g. full north-south extent
    // with some east-west trimmed on a portrait phone). Keeping these two
    // distinct is what leaves _clampView real slack to pan sideways at the
    // default zoom - if defaultView == base, panning has nowhere to go until
    // the user zooms in first.
    this.base = { x, y, w, h };
    // The default/"reset" view can differ from the pan/zoom clamp bounds (e.g. a
    // continent mode starts zoomed in, but can still zoom back out to the world).
    this.defaultView = this._fitToContainer(
      initialView ? { x: initialView[0], y: initialView[1], w: initialView[2], h: initialView[3] } : this.base
    );
    this.view = { ...this.defaultView };
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.pointers = new Map();
    this.moved = false;
    this.pinchStartDist = null;
    this.pinchStartView = null;
    this._animFrame = null;
    // "slice" (crop-to-fill) instead of the default "meet" (letterbox) lets a
    // container whose aspect ratio doesn't match the viewBox (e.g. a tall
    // mobile map) fill its full box by auto-zooming in, rather than adding
    // empty bars. On a container that does share the viewBox aspect (desktop)
    // this renders identically to "meet".
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    this._bind();
    this._apply();
  }

  // Returns the largest centered crop of `box` that shares the svg element's
  // currently rendered aspect ratio (e.g. full north-south extent with some
  // east-west trimmed off on a portrait phone). Falls back to `box` as-is if
  // the element isn't laid out yet (0-size rect).
  _fitToContainer(box) {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return { ...box };
    const containerAspect = rect.width / rect.height;
    const boxAspect = box.w / box.h;
    let w = box.w;
    let h = box.h;
    if (containerAspect < boxAspect) {
      w = box.h * containerAspect;
    } else {
      h = box.w / containerAspect;
    }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  }

  _apply() {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  _cancelAnim() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  // Smoothly tweens the viewBox to the given {x,y,w,h}, e.g. to pan/zoom onto
  // a quiz target rather than snapping there instantly.
  animateTo(targetView, duration = 700) {
    this._cancelAnim();
    const target = this._clampView(targetView);
    const start = { ...this.view };
    const startTime = performance.now();
    const step = (now) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.view = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        w: start.w + (target.w - start.w) * eased,
        h: start.h + (target.h - start.h) * eased,
      };
      this._apply();
      this._animFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    this._animFrame = requestAnimationFrame(step);
  }

  // Animates the view to fit the given SVG-space bounding box (e.g. a
  // country's path.getBBox()), padded and cropped to the map's aspect ratio.
  zoomToBBox(bbox, { padding = 2.2, duration = 700 } = {}) {
    // Match the container's own aspect (defaultView, not the uncropped
    // base) so the padded box isn't immediately re-cropped by the "slice"
    // preserveAspectRatio once applied.
    const aspect = this.defaultView.w / this.defaultView.h;
    let w = bbox.width * (1 + padding * 2);
    let h = bbox.height * (1 + padding * 2);
    if (w / h > aspect) {
      h = w / aspect;
    } else {
      w = h * aspect;
    }
    const minW = this.base.w / 8;
    if (w < minW) {
      w = minW;
      h = w / aspect;
    }
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    this.animateTo({ x: cx - w / 2, y: cy - h / 2, w, h }, duration);
  }

  _clientToSvg(clientX, clientY) {
    const pt = this.svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this.svg.getScreenCTM().inverse();
    const svgPt = pt.matrixTransform(ctm);
    return { x: svgPt.x, y: svgPt.y };
  }

  _clampView(v) {
    let { x, y, w, h } = v;
    if (w > this.base.w) w = this.base.w;
    if (h > this.base.h) h = this.base.h;
    if (x < this.base.x) x = this.base.x;
    if (y < this.base.y) y = this.base.y;
    if (x + w > this.base.x + this.base.w) x = this.base.x + this.base.w - w;
    if (y + h > this.base.y + this.base.h) y = this.base.y + this.base.h - h;
    return { x, y, w, h };
  }

  zoomAt(clientX, clientY, factor) {
    this._cancelAnim();
    const { x: cx, y: cy } = this._clientToSvg(clientX, clientY);
    const minW = this.base.w / this.maxScale;
    const maxW = this.base.w / this.minScale;
    let newW = Math.min(Math.max(this.view.w / factor, minW), maxW);
    const ratio = newW / this.view.w;
    const newH = this.view.h * ratio;
    const newX = cx - (cx - this.view.x) * ratio;
    const newY = cy - (cy - this.view.y) * ratio;
    this.view = this._clampView({ x: newX, y: newY, w: newW, h: newH });
    this._apply();
  }

  panBy(dxClient, dyClient) {
    this._cancelAnim();
    // Converts the screen-pixel delta to an svg-space delta via the CTM
    // rather than a plain rect/view ratio, since with preserveAspectRatio
    // "slice" the screen->svg scale can differ per axis.
    const origin = this._clientToSvg(0, 0);
    const moved = this._clientToSvg(dxClient, dyClient);
    const dx = moved.x - origin.x;
    const dy = moved.y - origin.y;
    this.view = this._clampView({ x: this.view.x - dx, y: this.view.y - dy, w: this.view.w, h: this.view.h });
    this._apply();
  }

  zoomIn() {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.5);
  }

  zoomOut() {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.5);
  }

  reset() {
    this._cancelAnim();
    this.view = { ...this.defaultView };
    this._apply();
  }

  _bind() {
    this.svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 1 / 1.25);
      },
      { passive: false }
    );

    this.svg.addEventListener("pointerdown", (e) => {
      this.svg.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        this.pinchStartView = { ...this.view };
      }
    });

    this.svg.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchStartDist) {
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          this.view = { ...this.pinchStartView };
          this._apply();
          this.zoomAt(midX, midY, dist / this.pinchStartDist);
        }
        this.moved = true;
        return;
      }

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.moved = true;
      if (this.moved) this.panBy(dx, dy);
    });

    const onPointerUp = (e) => {
      const wasSingleTap = this.pointers.size === 1 && !this.moved;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStartDist = null;

      if (wasSingleTap) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const country = el && el.closest ? el.closest(".country") : null;
        this.svg.dispatchEvent(
          new CustomEvent("country-click", { detail: { iso: country ? country.dataset.iso : null } })
        );
      }
      if (this.pointers.size === 0) this.moved = false;
    };
    this.svg.addEventListener("pointerup", onPointerUp);
    this.svg.addEventListener("pointercancel", onPointerUp);

    this.svg.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, 1.8);
    });
  }
}

window.MapZoom = MapZoom;
