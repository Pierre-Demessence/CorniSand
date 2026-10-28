/** Bench only: GPU timestamps for the passes of a frame. */
export interface PassTimer {
  // True: every group of dispatches gets a compute pass of its own, timed under its label. False: the frame's one
  // compute pass is timed as 'frame', as the game records it.
  perPass: boolean;
  // The same shape serves a render pass (`GPURenderPassTimestampWrites`): the renderer stamps its passes under
  // labels starting with `render:`.
  stamp(label: string): GPUComputePassTimestampWrites;
}

// Hands out the compute pass to record into: the frame's one pass, or under a per-pass timer a new timed pass per
// label. A new pass starts with no pipeline or bind group set, so every caller sets its own.
export class PassRecorder {
  private current: GPUComputePassEncoder | undefined;

  constructor(
    private readonly encoder: GPUCommandEncoder,
    private readonly timer?: PassTimer,
  ) {}

  pass(label: string): GPUComputePassEncoder {
    if (this.timer?.perPass) {
      this.current?.end();
      this.current = this.encoder.beginComputePass({ timestampWrites: this.timer.stamp(label) });
      return this.current;
    }
    this.current ??= this.encoder.beginComputePass(this.timer ? { timestampWrites: this.timer.stamp('frame') } : {});
    return this.current;
  }

  end(): void {
    this.current?.end();
    this.current = undefined;
  }
}
