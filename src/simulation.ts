import * as THREE from 'three';
import { simulationFragShader } from './shaders/simulation.frag';
import { fullscreenVertShader } from './shaders/fullscreen.vert';
import { PARTICLE_TYPES } from './particles';
import type { Vec2 } from './input';

export interface SimulationInput {
  mousePos: Vec2;
  prevMousePos: Vec2;
  mouseActive: boolean;
  erasing: boolean;
  brushSize: number;
  particleType: number;
}

export class Simulation {
  private readonly renderer: THREE.WebGLRenderer;
  readonly width: number;
  readonly height: number;
  private stepCount = 0;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private current: THREE.WebGLRenderTarget;
  private next: THREE.WebGLRenderTarget;
  private readonly simMaterial: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private countBuffer: Uint8Array | null = null;

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;

    const rtOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    this.rtA = new THREE.WebGLRenderTarget(width, height, rtOptions);
    this.rtB = new THREE.WebGLRenderTarget(width, height, rtOptions);
    this.current = this.rtA;
    this.next = this.rtB;

    this.simMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_state: { value: null },
        u_resolution: { value: new THREE.Vector2(width, height) },
        u_offset: { value: 0.0 },
        u_seed: { value: 0.0 },
        u_mousePos: { value: new THREE.Vector2(-1, -1) },
        u_brushSize: { value: 10.0 },
        u_particleType: { value: 1.0 },
        u_prevMousePos: { value: new THREE.Vector2(-1, -1) },
        u_mouseActive: { value: 0.0 },
        u_erasing: { value: 0.0 },
      },
      vertexShader: fullscreenVertShader,
      fragmentShader: simulationFragShader,
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.simMaterial,
    ));

    this.renderer.setClearColor(0x000000, 0);
    this.clear();
  }

  clear(): void {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.clear();
    this.renderer.setRenderTarget(prev);
    this.stepCount = 0;
  }

  private swap(): void {
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
  }

  private step(offset: number, applyInput: boolean): void {
    const u = this.simMaterial.uniforms;
    u.u_state.value = this.current.texture;
    u.u_offset.value = offset;
    u.u_seed.value = Math.random() * 10000;

    if (!applyInput) {
      u.u_mouseActive.value = 0.0;
    }

    this.renderer.setRenderTarget(this.next);
    this.renderer.render(this.scene, this.camera);
    this.swap();
    this.stepCount++;
  }

  simulate(stepsPerFrame: number, input: SimulationInput): void {
    const u = this.simMaterial.uniforms;
    u.u_prevMousePos.value.set(input.prevMousePos.x, input.prevMousePos.y);
    u.u_mousePos.value.set(input.mousePos.x, input.mousePos.y);
    u.u_brushSize.value = input.brushSize;
    u.u_particleType.value = input.particleType;
    u.u_mouseActive.value = input.mouseActive ? 1.0 : 0.0;
    u.u_erasing.value = input.erasing ? 1.0 : 0.0;

    for (let i = 0; i < stepsPerFrame; i++) {
      this.step(0, i === 0 && input.mouseActive);
      this.step(1, false);
    }
  }

  get texture(): THREE.Texture {
    return this.current.texture;
  }

  countParticles(): number {
    if (!this.countBuffer) {
      this.countBuffer = new Uint8Array(this.width * this.height * 4);
    }
    this.renderer.readRenderTargetPixels(
      this.current, 0, 0, this.width, this.height, this.countBuffer,
    );
    let count = 0;
    for (let i = 0; i < this.countBuffer.length; i += 4) {
      const type = this.countBuffer[i];
      if (type > 0 && type !== PARTICLE_TYPES.WALL) count++;
    }
    return count;
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.simMaterial.dispose();
    this.countBuffer = null;
  }
}
