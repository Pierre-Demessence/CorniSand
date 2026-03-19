import * as THREE from 'three';
import { displayFragShader } from './shaders/display.frag';
import { fullscreenVertShader } from './shaders/fullscreen.vert';
import type { Vec2 } from './input';

export interface DisplayOptions {
  mousePos: Vec2;
  brushSize: number;
  showBrush: boolean;
  erasing: boolean;
}

export class Display {
  private readonly material: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;

  constructor(simWidth: number, simHeight: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        u_state: { value: null },
        u_simResolution: { value: new THREE.Vector2(simWidth, simHeight) },
        u_screenResolution: { value: new THREE.Vector2(simWidth, simHeight) },
        u_mousePos: { value: new THREE.Vector2(-1, -1) },
        u_brushSize: { value: 10.0 },
        u_showBrush: { value: 1.0 },
        u_erasing: { value: 0.0 },
      },
      vertexShader: fullscreenVertShader,
      fragmentShader: displayFragShader,
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.material,
    ));
  }

  render(renderer: THREE.WebGLRenderer, stateTexture: THREE.Texture, opts: DisplayOptions): void {
    const u = this.material.uniforms;
    u.u_state.value = stateTexture;
    u.u_mousePos.value.set(opts.mousePos.x, opts.mousePos.y);
    u.u_brushSize.value = opts.brushSize;
    u.u_showBrush.value = opts.showBrush ? 1.0 : 0.0;
    u.u_erasing.value = opts.erasing ? 1.0 : 0.0;
    u.u_screenResolution.value.set(
      renderer.domElement.width,
      renderer.domElement.height,
    );

    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}
