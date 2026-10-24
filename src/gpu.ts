export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

const BANNER_STYLE =
  'position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:min(90vw,640px);' +
  'background:#1f1f26;color:#f3f4f6;border:1px solid rgba(255,255,255,0.3);border-radius:6px;' +
  'padding:8px 12px;font:13px sans-serif;white-space:pre-line;z-index:9998;display:flex;gap:12px;align-items:flex-start;';

let banner: HTMLDivElement | null = null;

// Small dismissable message; a second call replaces the text instead of stacking.
export function showBanner(message: string): void {
  if (!banner) {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText = BANNER_STYLE;
    const text = document.createElement('span');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Dismiss';
    close.style.cssText = 'flex-shrink:0;cursor:pointer;';
    close.addEventListener('click', () => {
      el.remove();
      banner = null;
    });
    el.append(text, close);
    document.body.appendChild(el);
    banner = el;
  }
  (banner.firstElementChild as HTMLElement).textContent = message;
}

export function showReloadOverlay(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:sans-serif;font-size:18px;z-index:9999;text-align:center;padding:2rem;';
  overlay.textContent = 'GPU connection lost. Reload the page to restart.';
  document.body.appendChild(overlay);
}

// onDeviceLost runs for every loss except an intentional device.destroy().
export async function initGPU(
  canvas: HTMLCanvasElement,
  onDeviceLost: (info: GPUDeviceLostInfo) => void,
): Promise<GPUContext> {
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

  // The defaults (128 MiB per binding) are below what most adapters offer and cap the grid size.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.onuncapturederror = (event) => {
    console.error('WebGPU error:', event.error.message);
    showBanner(`WebGPU error: ${event.error.message}`);
  };

  void device.lost.then((info) => {
    console.error('WebGPU device lost:', info.reason, info.message);
    if (info.reason !== 'destroyed') onDeviceLost(info);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Could not get WebGPU canvas context.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format };
}
