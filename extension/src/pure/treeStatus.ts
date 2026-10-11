import type { WikiEvent } from './events.js';

export interface TreeStatus { message: string; badge?: number }

export function createTreeStatus(): {
  step: (event: WikiEvent) => TreeStatus | null;
  summary: (stats: { generated: number; degraded: number; skipped: number }, model: string) => TreeStatus;
  clear: () => TreeStatus;
} {
  let total = 0;
  let done = 0;
  let running = false;
  return {
    step(event) {
      switch (event.type) {
        case 'run_started': { total = 0; done = 0; running = true; return { message: '⚡ Starting engine…', badge: 0 }; }
        case 'plan_ready': {
          total = Array.isArray(event.pages) ? event.pages.length : 0;
          done = 0;
          return { message: `⚡ Writing wiki — 0/${total} pages`, badge: 0 };
        }
        case 'page_done': case 'page_fail': {
          if (!running) return null;
          done += 1;
          const label = event.type === 'page_fail' ? `⚠ ${event.path}` : event.path;
          return { message: `⚡ ${done}/${total || '?'} · ${label}`, badge: done };
        }
        case 'run_finished': { running = false; return null; }
        default: return null;
      }
    },
    summary(stats, model) {
      const parts = [`✓ ${stats.generated + stats.skipped} pages`];
      if (stats.degraded) parts.push(`${stats.degraded} degraded`);
      return { message: `${parts.join(' · ')} · ${model}` };
    },
    clear() { return { message: '' }; },
  };
}
