/**
 * rgui WebGPU renderer — first increment: background + readable-grid
 * dots/field on the GPU.
 *
 * The grid is the one element whose instance count scales without bound
 * (every readable grid point on screen, ×2 levels, plus field tails), so it
 * moves to instanced SDF quads first. Graph content keeps rendering on the
 * 2D canvas above with a transparent background; later increments can move
 * wires and node blocks behind this same seam.
 */
import { gridLevels, gridRange, type ViewTransform } from "../core/grid.js";
import { DEFAULT_RULE, type RgRule } from "../core/rule.js";
import type { FieldSource } from "./canvas2d.js";

const BG = { r: 0.11, g: 0.129, b: 0.149, a: 1 }; // #1c2126

// per-instance: cx, cy, radius, alpha, tailDx, tailDy, pad, pad (CSS px)
const STRIDE = 8;

const WGSL = /* wgsl */ `
struct Uniforms {
  resolution: vec2f, // CSS px
  zdir: f32,         // field-arrow z: +1 = at viewer (⊙ purple), -1 = away (⊗ gold cross)
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct Inst {
  @location(0) center: vec2f,
  @location(1) rAlpha: vec2f,   // radius, alpha
  @location(2) tail: vec2f,     // tail vector (px), 0 = none
};

fn toNdc(p: vec2f) -> vec4f {
  let ndc = p / u.resolution * 2.0 - 1.0;
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}

const GOLD = vec3f(1.0, 0.839, 0.039);   // #ffd60a — arrows into the screen
const PURPLE = vec3f(0.698, 0.361, 0.878); // #b25ce0 — arrows at the viewer

// --- field arrows: instanced quad; SDF circle (⊙) or cross (⊗) --------------
struct DotOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) rAlpha: vec2f,
};

@vertex
fn dotVert(@builtin(vertex_index) vi: u32, in: Inst) -> DotOut {
  let corner = vec2f(
    select(-1.0, 1.0, (vi & 1u) == 1u),
    select(-1.0, 1.0, (vi >> 1u) == 1u),
  );
  let ext = in.rAlpha.x * 1.6 + 1.0; // room for the cross arms + 1px feather
  var out: DotOut;
  out.pos = toNdc(in.center + corner * ext);
  out.local = corner * ext;
  out.rAlpha = in.rAlpha;
  return out;
}

@fragment
fn dotFrag(in: DotOut) -> @location(0) vec4f {
  let d = length(in.local);
  var a: f32;
  if (u.zdir >= 0.0) {
    // ⊙ arrowhead seen head-on: filled circle
    a = in.rAlpha.y * (1.0 - smoothstep(in.rAlpha.x - 0.5, in.rAlpha.x + 0.5, d));
  } else {
    // ⊗ fletching seen from behind: diagonal cross
    let arm = min(
      abs(in.local.x - in.local.y),
      abs(in.local.x + in.local.y),
    ) * 0.7071;
    let reach = in.rAlpha.x * 1.4;
    a = in.rAlpha.y
      * (1.0 - smoothstep(0.5, 1.0, arm))
      * (1.0 - smoothstep(reach - 0.5, reach + 0.5, d));
  }
  let col = select(GOLD, PURPLE, u.zdir >= 0.0);
  return vec4f(col * a, a); // premultiplied
}

// --- tails: instanced quad along the field vector ---------------------------
struct TailOut {
  @builtin(position) pos: vec4f,
  @location(0) alpha: f32,
};

@vertex
fn tailVert(@builtin(vertex_index) vi: u32, in: Inst) -> TailOut {
  var out: TailOut;
  let len = length(in.tail);
  if (len < 0.01) { // no field here: degenerate quad
    out.pos = vec4f(0.0, 0.0, 0.0, 1.0);
    out.alpha = 0.0;
    return out;
  }
  let dir = in.tail / len;
  let n = vec2f(-dir.y, dir.x) * 0.5; // 1px-wide line
  let along = select(vec2f(0.0), in.tail, (vi >> 1u) == 1u);
  let side = select(-n, n, (vi & 1u) == 1u);
  out.pos = toNdc(in.center + along + side);
  out.alpha = in.rAlpha.y * 0.7;
  return out;
}

@fragment
fn tailFrag(in: TailOut) -> @location(0) vec4f {
  let col = select(GOLD, PURPLE, u.zdir >= 0.0);
  return vec4f(col * in.alpha, in.alpha);
}
`;

export interface WebGPUGridRenderer {
  /** resolves true when the pipeline is live, false when unavailable */
  ready: Promise<boolean>;
  render(t: ViewTransform): void;
  resize(): void;
  destroy(): void;
}

export function createWebGPUGridRenderer(
  canvas: HTMLCanvasElement,
  rule: RgRule = DEFAULT_RULE,
  field?: () => FieldSource[],
  /** z of the field arrows: +1 = at the viewer (⊙), -1 = into the screen (⊗) */
  zDir?: () => number,
  /** global lateral field direction from the viewport 3-D rotation */
  fieldTilt?: () => readonly [number, number],
  maxDpr?: number,
): WebGPUGridRenderer {
  let device: GPUDevice | null = null;
  let ctx: GPUCanvasContext | null = null;
  let dots: GPURenderPipeline | null = null;
  let tails: GPURenderPipeline | null = null;
  let uniformBuf: GPUBuffer | null = null;
  let bind: GPUBindGroup | null = null;
  let instBuf: GPUBuffer | null = null;
  let instCap = 0;
  let destroyed = false;
  let width = 0;
  let height = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr ?? Infinity);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
  }

  const ready = (async () => {
    if (typeof navigator === "undefined" || !navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter || destroyed) return false;
      device = await adapter.requestDevice();
      if (destroyed) return false;
      ctx = canvas.getContext("webgpu");
      if (!ctx) return false;
      const format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: "opaque" });

      const module = device.createShaderModule({ code: WGSL });
      // explicit shared layout: one bind group must serve BOTH pipelines
      // ("auto" would generate incompatible layouts per pipeline)
      const bgl = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });
      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bgl],
      });
      const blend: GPUBlendState = {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      };
      const buffers: GPUVertexBufferLayout[] = [
        {
          arrayStride: STRIDE * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "float32x2" },
          ],
        },
      ];
      const mk = (vs: string, fs: string) =>
        device!.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module, entryPoint: vs, buffers },
          fragment: {
            module,
            entryPoint: fs,
            targets: [{ format, blend }],
          },
          primitive: { topology: "triangle-strip" },
        });
      dots = mk("dotVert", "dotFrag");
      tails = mk("tailVert", "tailFrag");
      uniformBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      bind = device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
      });
      resize();
      return true;
    } catch (err) {
      console.warn("[rgui] WebGPU unavailable, falling back:", err);
      return false;
    }
  })();

  // growable scratch buffer reused across frames (allocation-free steady state)
  let scratch = new Float32Array(4096 * STRIDE);
  let scratchLen = 0;
  const pushInst = (
    sx: number,
    sy: number,
    r: number,
    a: number,
    tx: number,
    ty: number,
  ) => {
    if (scratchLen + STRIDE > scratch.length) {
      const bigger = new Float32Array(scratch.length * 2);
      bigger.set(scratch);
      scratch = bigger;
    }
    scratch[scratchLen] = sx;
    scratch[scratchLen + 1] = sy;
    scratch[scratchLen + 2] = r;
    scratch[scratchLen + 3] = a;
    scratch[scratchLen + 4] = tx;
    scratch[scratchLen + 5] = ty;
    scratchLen += STRIDE;
  };

  /** build per-instance data — same math as the Canvas 2D grid layer */
  function buildInstances(t: ViewTransform): Float32Array {
    const levels = gridLevels(t.k, rule.minGridPx, rule.ladder);
    const attractors = (field?.() ?? []).slice(0, 128).map((a) => ({
      x: a.x * t.k + t.x,
      y: a.y * t.k + t.y,
    }));
    scratchLen = 0;
    // dots keep their screen positions under viewport rotation — only the
    // arrow directions lean (global field tilt)
    const gt = fieldTilt?.() ?? ([0, 0] as const);
    const bx0 = 0;
    const bx1 = width;
    const by0 = 0;
    const by1 = height;
    for (const level of [...levels].reverse()) {
      if (level.alpha <= 0.01) continue;
      const major = level.step === levels[0]!.step;
      const r = major ? 2.5 : 1.5;
      const alpha = level.alpha * (major ? 0.55 : 0.3);
      const { start: x0, end: x1 } = gridRange(t, bx0, bx1, t.x, level.step);
      const { start: y0, end: y1 } = gridRange(t, by0, by1, t.y, level.step);
      for (let wx = x0; wx <= x1; wx += level.step) {
        const sx = wx * t.k + t.x;
        for (let wy = y0; wy <= y1; wy += level.step) {
          const sy = wy * t.k + t.y;
          let dotR = r;
          let tx = 0;
          let ty = 0;
          if (major) {
            let ax = gt[0];
            let ay = gt[1];
            if (attractors.length) {
              let vx = 0;
              let vy = 0;
              for (const a of attractors) {
                const dx = a.x - sx;
                const dy = a.y - sy;
                const d2 = dx * dx + dy * dy;
                if (d2 < 1) continue;
                vx += dx / d2;
                vy += dy / d2;
              }
              const mag = Math.hypot(vx, vy);
              if (mag > 1e-4) {
                const p = Math.min(1, mag * 900);
                ax += (vx / mag) * p;
                ay += (vy / mag) * p;
              }
            }
            const tmag = Math.hypot(ax, ay);
            if (tmag > 1e-4) {
              const tilt = Math.min(1, tmag);
              const len = 3 + 11 * tilt;
              dotR = r * (1 - 0.55 * tilt);
              tx = (ax / tmag) * len;
              ty = (ay / tmag) * len;
            }
          }
          pushInst(sx, sy, dotR, alpha, tx, ty);
        }
      }
    }
    return scratch.subarray(0, scratchLen) as Float32Array;
  }

  function render(t: ViewTransform) {
    if (!device || !ctx || !dots || !tails || !uniformBuf || !bind) return;
    const data = buildInstances(t);
    const count = data.length / STRIDE;
    if (!instBuf || instCap < data.byteLength) {
      instBuf?.destroy();
      instCap = Math.max(data.byteLength, 64 * 1024);
      instBuf = device.createBuffer({
        size: instCap,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (count) device.queue.writeBuffer(instBuf, 0, data);
    const z = Math.max(-1, Math.min(1, zDir?.() ?? 1));
    device.queue.writeBuffer(
      uniformBuf,
      0,
      new Float32Array([width, height, z, 0]),
    );

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          clearValue: BG,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (count) {
      pass.setBindGroup(0, bind);
      pass.setVertexBuffer(0, instBuf);
      pass.setPipeline(tails);
      pass.draw(4, count);
      pass.setPipeline(dots);
      pass.draw(4, count);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  return {
    ready,
    render,
    resize,
    destroy() {
      destroyed = true;
      instBuf?.destroy();
      uniformBuf?.destroy();
      device?.destroy();
    },
  };
}
