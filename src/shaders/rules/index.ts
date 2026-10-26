import { fireRule } from './fire.wgsl';

// WGSL of the optional element rules, by the name an `ElementDef.rule` carries. Each source defines
// `fn rule_<name>(i: u32, block: ptr<function, array<Cell, 4>>)`.
export const RULES: Readonly<Record<string, string>> = {
  fire: fireRule,
};
