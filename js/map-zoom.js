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
    this.base = { x, y, w, h };
    // The default/"reset" view can differ from the pan/zoom clamp bounds (e.g. a
    // continent mode starts zoomed in, but can still zoom back out to the world).
    this.defaultView = initialView
      ? { x: initialView[0], y: initialView[1], w: initialView[2], h: initialView[3] }
      : { ...this.base };
    this.view = { ...this.defaultView };
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.pointers = new Map();
    this.moved = false;
    this.pinchStartDist = null;
    this.pinchStartView = null;
    this._bind();
    this._apply();
  }

  _apply() {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
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
    const rect = this.svg.getBoundingClientRect();
    const dx = dxClient * (this.view.w / rect.width);
    const dy = dyClient * (this.view.h / rect.height);
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
