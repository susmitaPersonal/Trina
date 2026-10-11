import { z } from 'zod';
import type { ModuleDef, TaskTypeDef } from '../types';

export const noParams = z.object({}).loose() as unknown as z.ZodType<Record<string, unknown>>;

export function defineModule(def: ModuleDef): ModuleDef {
  return def;
}

export function taskType(def: Omit<TaskTypeDef, 'paramsSchema'> & { paramsSchema?: TaskTypeDef['paramsSchema'] }): TaskTypeDef {
  return { paramsSchema: noParams, ...def };
}

export const quantityParams = z
  .object({ quantity: z.int().min(1).max(100).default(1) })
  .loose() as unknown as z.ZodType<Record<string, unknown>>;
