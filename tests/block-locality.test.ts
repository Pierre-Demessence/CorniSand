import { describe, expect, it } from 'vitest';
import type { AirData } from '../src/air-grid';
import { CELL_FIELDS, emptyCellData, kindWord, type CellData } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementHoldsHeat, type ElementDef } from '../src/elements';
import { packHalf2 } from '../src/half';
import { mulberry32 } from '../src/random';
import { caWGSL } from '../src/shaders/ca.wgsl';
import { RULES } from '../src/shaders/rules';
import { Simulation } from '../src/simulation';
import { device } from './gpu';
import { MOLTEN_TABLE } from './molten-table';

// The CA updates cells in place, so a rule that reads a cell outside its own 2x2 block still gives a deterministic
// result and the rerun tests cannot see it. This test runs single CA dispatches on a random scene
// and on a copy with one cell changed per 4x4 tile: outside the blocks of the changed cells the two must come out
// bit-identical, field by field. A phase that reads across a block border breaks that wherever the changed cell is its
// neighbor. It catches a violation only when the read changes a result for the cells drawn; a continuous phase
// (conduction) changes something for nearly any out-of-block read, a discrete one is caught with high probability over
// the 32 rounds, not with certainty. Both scenes run on the same random air state (pressure, wind and temperature
// changing from one air cell to the next): the CA reads the air, which only the air passes write, so that is no
// violation.

type Rand = () => number;
type CellWords = Record<string, number>;
type FieldGenerator = (e: ElementDef, variant: number, rand: Rand, table: readonly ElementDef[]) => number;

const falls = (e: ElementDef): boolean => e.state === 'powder' || e.state === 'liquid';

const floatBits = new Float32Array(1);
const floatWord = new Uint32Array(floatBits.buffer);
const f32Word = (x: number): number => {
  floatBits[0] = x;
  return floatWord[0];
};

// One generator per cell field, by field name. Only powders and liquids move (the CA's inert skip relies on zero motion
// for everything else); a liquid's life is its direction.
const FIELD_GENERATORS: Partial<Record<string, FieldGenerator>> = {
  // A molten cell carries the ctype of a row that melts into it, or none.
  kind: (e, variant, rand, table) => {
    const melts = e.molten ? table.filter((row) => row.above?.becomes === e.key) : [];
    const ctype = melts.length > 0 ? Math.floor(rand() * (melts.length + 1)) : 0;
    return kindWord(e.id, variant, ctype === 0 ? 0 : melts[ctype - 1].id);
  },
  life: (e, _variant, rand) => {
    if (e.life) return 1 + Math.floor(rand() * e.life.start);
    return e.state === 'liquid' ? Math.floor(rand() * 3) : 0;
  },
  // Length at most 1 in a random direction, the most a cell in the grid moves per dispatch.
  velocity: (e, _variant, rand) => {
    if (!falls(e)) return 0;
    const angle = rand() * 2 * Math.PI;
    const length = rand();
    return packHalf2(Math.cos(angle) * length, Math.sin(angle) * length);
  },
  remainder: (e, _variant, rand) => (falls(e) ? packHalf2(rand() * 1.998 - 0.999, rand() * 1.998 - 0.999) : 0),
  // -50 to 1,600 °C: from cold to past the melting point of metal. A cell that holds no heat has no temperature.
  temp: (e, _variant, rand) => (elementHoldsHeat(e) ? f32Word(-50 + rand() * 1650) : 0),
};

// A random cell of the table: about a quarter empty, the rest any row.
function drawCell(table: readonly ElementDef[], rand: Rand): CellWords {
  const e = rand() < 0.25 ? elementByKey(table, 'EMPTY') : table[Math.floor(rand() * table.length)];
  const variant = Math.floor(rand() * 256);
  const words: CellWords = {};
  for (const { name } of CELL_FIELDS) {
    const generate = FIELD_GENERATORS[name];
    if (!generate) throw new Error(`no random generator for cell field "${name}": add one to FIELD_GENERATORS`);
    words[name] = generate(e, variant, rand, table);
  }
  return words;
}

// A random state for every air cell: pressure up to 2 either way, wind up to 1.5 cells per dispatch, any temperature
// from cold to hot. The same for the same `rand`.
function randomAir(sim: Simulation, rand: Rand): AirData {
  const n = sim.air.columns * sim.air.rows;
  const field = (scale: number, offset: number): Float32Array => Float32Array.from({ length: n }, () => offset + scale * rand());
  return { pressure: field(4, -2), velocityX: field(3, -1.5), velocityY: field(3, -1.5), temperature: field(300, -50) };
}

function setCell(scene: CellData, i: number, words: CellWords): void {
  for (const { name } of CELL_FIELDS) scene[name][i] = words[name];
}

function randomScene(width: number, height: number, table: readonly ElementDef[], rand: Rand): CellData {
  const scene = emptyCellData(width * height);
  for (let i = 0; i < width * height; i++) setCell(scene, i, drawCell(table, rand));
  return scene;
}

// The scene with one random cell of every 4x4 tile (of the grid's edge tiles, as far as they reach) replaced by another.
function perturbedScene(scene: CellData, width: number, height: number, table: readonly ElementDef[], rand: Rand): CellData {
  const copy = Object.fromEntries(CELL_FIELDS.map(({ name }) => [name, scene[name].slice()])) as CellData;
  for (let ty = 0; ty < height; ty += 4) {
    for (let tx = 0; tx < width; tx += 4) {
      const x = tx + Math.floor(rand() * Math.min(4, width - tx));
      const y = ty + Math.floor(rand() * Math.min(4, height - ty));
      setCell(copy, y * width + x, drawCell(table, rand));
    }
  }
  return copy;
}

// The cells of the blocks (of the dispatch at `offset`) that hold a cell where the scenes differ: the only place the
// results may differ.
function allowedMask(a: CellData, b: CellData, width: number, height: number, offset: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (!CELL_FIELDS.some(({ name }) => a[name][i] !== b[name][i])) continue;
    const x0 = Math.floor(((i % width) + offset) / 2) * 2 - offset;
    const y0 = Math.floor((Math.floor(i / width) + offset) / 2) * 2 - offset;
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + 2); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + 2); x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

async function validated<R>(work: () => Promise<R> | R): Promise<R> {
  const dev = device!;
  dev.pushErrorScope('validation');
  const result = await work();
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
  return result;
}

interface Check {
  width: number;
  height: number;
  table: readonly ElementDef[];
  // WGSL of extra rules by name, added to the built-in ones.
  rules?: Readonly<Record<string, string>>;
  // Rewrites the CA's generated source, for a control that plants a violation.
  patch?: (source: string) => string;
  // Changes the two scenes of every round, for a control that plants a violation.
  edit?: (reference: CellData, copy: CellData) => void;
  rounds: number;
  seed: number;
}

interface Result {
  // Cells that differ outside the allowed mask, summed over the rounds, for the dispatch at offset 0 and at offset 1.
  violations: [number, number];
  example: string;
}

// Runs one CA dispatch, at offset 0 and then (on fresh copies) at offset 1, on a random scene and on its perturbed copy.
// The dispatch is the one `Simulation.simulate` records, built here from the generated source and the simulation's
// layouts, so the production code is not touched.
async function checkLocality(check: Check): Promise<Result> {
  const dev = device!;
  const { width, height, table } = check;
  const options = { elements: table, rules: check.rules, maxFlyers: 1024 };
  const simA = new Simulation(dev, width, height, { ...options, seedSource: mulberry32(1) });
  const simB = new Simulation(dev, width, height, { ...options, seedSource: mulberry32(1) });
  const generated = caWGSL(width, height, simA.elements.elements, { ...RULES, ...check.rules }, simA.flyers.maxFlyers, simA.air.shape);
  const source = check.patch ? check.patch(generated) : generated;

  const stepBuffer = dev.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const stepLayout = dev.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
  });
  const stepBindGroup = dev.createBindGroup({ layout: stepLayout, entries: [{ binding: 0, resource: { buffer: stepBuffer } }] });
  const module = dev.createShaderModule({ code: source });
  const dispatcher = (sim: Simulation): ((encoder: GPUCommandEncoder, offset: number) => void) => {
    const pipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [stepLayout, sim.fields.writeLayout, sim.elements.layout, sim.flyers.launchLayout] }),
      compute: { module, entryPoint: 'main' },
    });
    return (encoder, offset) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, stepBindGroup);
      pass.setBindGroup(1, sim.fields.writeBindGroup);
      pass.setBindGroup(2, sim.elements.bindGroup);
      pass.setBindGroup(3, sim.flyers.launchBindGroup);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil((width + offset) / 2) / 8), Math.ceil(Math.ceil((height + offset) / 2) / 8));
      pass.end();
    };
  };
  const [dispatchA, dispatchB] = await validated(() => [dispatcher(simA), dispatcher(simB)]);

  const result: Result = { violations: [0, 0], example: '' };
  for (let round = 0; round < check.rounds; round++) {
    const seed = mulberry32(check.seed + round);
    const rand: Rand = () => seed() / 2 ** 32;
    const reference = randomScene(width, height, table, rand);
    const copy = perturbedScene(reference, width, height, table, rand);
    check.edit?.(reference, copy);
    const stepSeed = seed();

    for (const offset of [0, 1]) {
      const mask = allowedMask(reference, copy, width, height, offset);
      simA.load(reference);
      simB.load(copy);
      const airSeed = mulberry32(check.seed + round);
      simA.air.load(randomAir(simA, () => airSeed() / 2 ** 32));
      const airSeedB = mulberry32(check.seed + round);
      simB.air.load(randomAir(simB, () => airSeedB() / 2 ** 32));
      await validated(() => {
        dev.queue.writeBuffer(stepBuffer, 0, new Uint32Array([offset, stepSeed]));
        const encoder = dev.createCommandEncoder();
        dispatchA(encoder, offset);
        dispatchB(encoder, offset);
        dev.queue.submit([encoder.finish()]);
      });

      const differing = new Set<number>();
      for (const { name } of CELL_FIELDS) {
        const a = await simA.fields.read(name);
        const b = await simB.fields.read(name);
        for (let i = 0; i < a.length; i++) {
          if (mask[i] === 0 && a[i] !== b[i] && !differing.has(i)) {
            differing.add(i);
            if (result.example === '') {
              result.example = `round ${round}, offset ${offset}: cell (${i % width}, ${Math.floor(i / width)}) differs in ${name}`;
            }
          }
        }
      }
      result.violations[offset] += differing.size;
    }
  }
  return result;
}

describe.skipIf(!device)('M5 block locality', () => {
  const rounds = 32;

  for (const [width, height] of [[128, 96], [33, 31]]) {
    it(`AC1: a dispatch changes nothing outside the blocks of the changed cells, on a ${width}x${height} grid`, async () => {
      const result = await checkLocality({ width, height, table: ELEMENTS, rounds, seed: 1000 });
      expect(result.violations, result.example).toEqual([0, 0]);
    }, 120_000);
  }

  it('M8.1 AC14: molten cells with ctypes of several elements stay inside their blocks', async () => {
    // The default table's lava and molten steel carry stone, steel, glass and gold as ctypes in this one.
    const result = await checkLocality({ width: 128, height: 96, table: MOLTEN_TABLE, rounds, seed: 4000 });
    expect(result.violations, result.example).toEqual([0, 0]);
  }, 120_000);

  it('AC1 control: a rule that reads a far cell fails the check', async () => {
    const PEEK = 200;
    const table: ElementDef[] = [
      ...ELEMENTS,
      { key: 'PEEK', id: PEEK, label: 'Peek', color: [1, 0, 1], state: 'solid', density: 3000, rule: 'peek' },
    ];
    const rules = {
      peek: /* wgsl */`
        fn rule_peek(i: u32, block: ptr<function, array<Cell, 4>>) {
          if ((loadKind(0u) & 0xffu) == EL_SAND) { (*block)[i] = retype((*block)[i], EL_SMOKE, 0u, 0u); }
        }
      `,
    };
    // Cell 0 is the one cell the two scenes differ in that the rule reads.
    const edit = (reference: CellData, copy: CellData): void => {
      for (const { name } of CELL_FIELDS) {
        reference[name][0] = name === 'kind' ? T.SAND : 0;
        copy[name][0] = name === 'kind' ? T.WATER : 0;
      }
    };
    const result = await checkLocality({ width: 128, height: 96, table, rules, edit, rounds, seed: 2000 });
    expect(result.violations[0], 'cells that differ at offset 0').toBeGreaterThan(0);
    expect(result.violations[1], 'cells that differ at offset 1').toBeGreaterThan(0);
  }, 120_000);

  it('AC1 control: a CA that reads the cell right of its block fails the check', async () => {
    const marker = 'var rnd = hash2(gid.x, gid.y, u.seed);';
    const peek = 'if (cellType(readCell(ox + 2, oy)) == EL_SAND) { blk1 = retype(blk1, EL_SMOKE, 0u, 0u); }';
    const patch = (source: string): string => {
      expect(source, 'the line the control patches after').toContain(marker);
      return source.replace(marker, `${marker}\n    ${peek}`);
    };
    const result = await checkLocality({ width: 128, height: 96, table: ELEMENTS, patch, rounds, seed: 3000 });
    expect(result.violations[0], 'cells that differ at offset 0').toBeGreaterThan(0);
    expect(result.violations[1], 'cells that differ at offset 1').toBeGreaterThan(0);
  }, 120_000);
});
