import type { ModuleDef, ModuleRegistry } from '../types';
import { walking } from './walking';
import { running } from './running';
import { cycling } from './cycling';
import { cleanup } from './cleanup';
import { treeCare } from './tree-care';
import { mindful } from './mindful';
import { scavenger } from './scavenger';
import { fitness } from './fitness';
import { compileModuleOrThrow } from './declarative';
import { builtinDescriptor, builtinFactLevels } from './descriptors';
import { OFFICIAL_DATA_DEFINITIONS } from './data/team-sports';

/** THE built-in (TypeScript) module list. Add new modules here (see docs/guides/adding-a-module.md). */
export const BUILTIN_MODULES: ModuleDef[] = [walking, running, cycling, cleanup, treeCare, mindful, scavenger, fitness];

// Every built-in module is also expressed in the Module DSL (validated by the same schema).
for (const m of BUILTIN_MODULES) {
  m.origin = 'builtin';
  m.factLevels = builtinFactLevels(m);
  m.descriptor = builtinDescriptor(m);
}

/** Official DATA modules shipped in the repo (ADR-023): interpreted exactly like runtime modules. */
export const OFFICIAL_DATA_MODULES: ModuleDef[] = OFFICIAL_DATA_DEFINITIONS.map((d) => compileModuleOrThrow(d));

export const DEFAULT_MODULES: ModuleDef[] = [...BUILTIN_MODULES, ...OFFICIAL_DATA_MODULES];

/** Ids no runtime (custom) module may take. */
export const RESERVED_MODULE_IDS: string[] = DEFAULT_MODULES.map((m) => m.id);

export function createRegistry(modules: ModuleDef[] = DEFAULT_MODULES): ModuleRegistry {
  const map = new Map(modules.map((m) => [m.id, m]));
  if (map.size !== modules.length) throw new Error('Duplicate module id in registry');
  const registry: ModuleRegistry = {
    modules: map,
    get: (id) => map.get(id),
    list: () => [...map.values()],
    taskType(fullId) {
      const dot = fullId.indexOf('.');
      const module = dot > 0 ? map.get(fullId.slice(0, dot)) : undefined;
      const taskId = fullId.slice(dot + 1);
      const task = module?.taskTypes.find((t) => t.id === taskId);
      return module && task ? { module, task } : undefined;
    },
    with(extra) {
      const next = [...modules];
      for (const m of extra) {
        const existing = map.get(m.id);
        if (existing) {
          // Same pinned content twice is fine (idempotent); anything else can't shadow a module.
          if (existing.definitionHash && existing.definitionHash === m.definitionHash) continue;
          throw new Error(`Module id "${m.id}" is already registered`);
        }
        if (m.origin !== 'community') throw new Error(`Runtime module "${m.id}" must be a community module`);
        next.push(m);
      }
      return createRegistry(next);
    },
  };
  return registry;
}

export const defaultRegistry = createRegistry();

export { walking, running, cycling, cleanup, treeCare, mindful, scavenger, fitness };
