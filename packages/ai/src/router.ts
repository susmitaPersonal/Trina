import type { LLMProvider } from './provider';
import { TemplateProvider } from './providers/template';

/**
 * Picks the first available provider in priority order:
 * on-device (if installed & device capable) → self-hosted server → template (no AI).
 */
export class AIRouter {
  private readonly fallback = new TemplateProvider();

  constructor(private readonly providers: LLMProvider[]) {}

  async pick(): Promise<LLMProvider> {
    for (const p of this.providers) {
      try {
        if (await p.isAvailable()) return p;
      } catch {
        /* try next */
      }
    }
    return this.fallback;
  }
}
