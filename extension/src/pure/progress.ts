import type { WikiEvent } from './events.js';

export interface ProgressUpdate { message: string; increment: number }

export function createRunProgress(): (event: WikiEvent) => ProgressUpdate | null {
  let total = 0;
  let done = 0;
  return (event) => {
    switch (event.type) {
      case 'plan_ready': {
        total = Array.isArray(event.pages) ? event.pages.length : 0;
        return null; // message set by the caller via plan summary if desired
      }
      case 'page_done': {
        done += 1;
        const where = ` (${done}/${total > 0 ? total : '?'})`;
        return { message: `${event.path}${where}`, increment: total > 0 ? 85 / total : 10 };
      }
      case 'page_fail': {
        done += 1;
        const where = ` (${done}/${total > 0 ? total : '?'})`;
        return { message: `failed: ${event.path}${where}`, increment: total > 0 ? 85 / total : 10 };
      }
      case 'knowledge_started':
        return { message: 'generating knowledge cards', increment: 2 };
      default:
        return null;
    }
  };
}
