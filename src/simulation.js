import * as THREE from 'three';
import { simulationFragShader } from './shaders/simulation.frag.js';
import { fullscreenVertShader } from './shaders/fullscreen.vert.js';

export class Simulation {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;
    this.stepCount = 0;

    const rtOptions = {
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

  clear() {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.clear();
    this.renderer.setRenderTarget(prev);
    this.stepCount = 0;
  }

  swap() {
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
  }

  step(offset, applyInput) {
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

  simulate(stepsPerFrame, input) {
    const u = this.simMaterial.uniforms;
    u.u_prevMousePos.value.set(input.prevMousePos.x, input.prevMousePos.y);
    u.u_mousePos.value.set(input.mousePos.x, input.mousePos.y);
    u.u_brushSize.value = input.brushSize;
    u.u_particleType.value = input.particleType;
    u.u_mouseActive.value = input.mouseActive ? 1.0 : 0.0;
    u.u_erasing.value = input.erasing ? 1.0 : 0.0;

    for (let i = 0; i < stepsPerFrame; i++) {
      // Superstep: process offset 0, then offset 1 for full coverage
      this.step(0, i === 0 && input.mouseActive);
      this.step(1, false);
    }
  }

  get texture() {
    return this.current.texture;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.simMaterial.dispose();
  }
}
