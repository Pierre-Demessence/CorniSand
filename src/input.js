export class InputHandler {
  constructor(canvas, simWidth, simHeight) {
    this.canvas = canvas;
    this.simWidth = simWidth;
    this.simHeight = simHeight;
    this.mousePos = { x: -1, y: -1 };
    this.leftDown = false;
    this.rightDown = false;
    this.brushSize = 10;
    this.particleType = 1;

    this._setupPointerEvents();
    this._setupKeyboard();
    this._setupWheel();
  }

  get mouseActive() {
    return this.leftDown || this.rightDown;
  }

  get erasing() {
    return this.rightDown && !this.leftDown;
  }

  _toSimCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = 1.0 - (clientY - rect.top) / rect.height;
    this.mousePos.x = nx * this.simWidth;
    this.mousePos.y = ny * this.simHeight;
  }

  _setupPointerEvents() {
    const c = this.canvas;

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.button === 0) this.leftDown = true;
      if (e.button === 2) this.rightDown = true;
      this._toSimCoords(e.clientX, e.clientY);
    });

    c.addEventListener('pointermove', (e) => {
      this._toSimCoords(e.clientX, e.clientY);
    });

    c.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    });

    c.addEventListener('pointerleave', () => {
      this.leftDown = false;
      this.rightDown = false;
    });
  }

  _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.key === '1') this.particleType = 1;
      else if (e.key === '2') this.particleType = 2;
    });
  }

  _setupWheel() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      this.brushSize = Math.max(1, Math.min(200, this.brushSize + delta * 2));
    }, { passive: false });
  }
}
