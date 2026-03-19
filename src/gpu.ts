export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error(
      'WebGPU is not supported in this browser. Please use Chrome 113+, Edge 113+, or Safari 18.2+.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error(
      'Could not find a suitable GPU adapter. Please check your GPU drivers.',
    );
  }

  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error('WebGPU device lost:', info.message);
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font-family:sans-serif;font-size:18px;z-index:9999;text-align:center;padding:2rem;';
    overlay.innerHTML =
      'GPU connection lost.<br>Reload the page to restart.';
    document.body.appendChild(overlay);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Could not get WebGPU canvas context.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format };
}
