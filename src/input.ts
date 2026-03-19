export interface Vec2 {
  x: number;
  y: number;
}

export class InputHandler {
  readonly canvas: HTMLCanvasElement;
  readonly simWidth: number;
  readonly simHeight: number;
  mousePos: Vec2 = { x: -1, y: -1 };
  leftDown = false;
  rightDown = false;
  brushSize = 10;
  particleType = 1;

  constructor(canvas: HTMLCanvasElement, simWidth: number, simHeight: number) {
    this.canvas = canvas;
    this.simWidth = simWidth;
    this.simHeight = simHeight;

    this._setupPointerEvents();
    this._setupKeyboard();
    this._setupWheel();
  }

  get mouseActive(): boolean {
    return this.leftDown || this.rightDown;
  }

  get erasing(): boolean {
    return this.rightDown && !this.leftDown;
  }

  private _toSimCoords(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = 1.0 - (clientY - rect.top) / rect.height;
    this.mousePos.x = nx * this.simWidth;
    this.mousePos.y = ny * this.simHeight;
  }

  private _setupPointerEvents(): void {
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

  private _setupKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key === '1') this.particleType = 1;
      else if (e.key === '2') this.particleType = 2;
      else if (e.key === '3') this.particleType = 3;
      else if (e.key === '4') this.particleType = 4;
    });
  }

  private _setupWheel(): void {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      this.brushSize = Math.max(1, Math.min(200, this.brushSize + delta * 2));
    }, { passive: false });
  }
}
