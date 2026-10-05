export type PageStatus = 'generated' | 'degraded' | 'protected' | 'skipped';
export type PageDoneEvent = { type: 'page_done'; ts: string; path: string; status: PageStatus; chars?: number; files?: number; reason?: string; codes?: string; operation?: string };
export type WikiEvent =
  | { type: 'run_started'; ts: string; repo?: string; model?: string; provider?: string; modelId?: string; configPath?: string; outDir?: string; mode?: string }
  | { type: 'env_loaded'; ts: string; count: number }
  | { type: 'scan_started'; ts: string }
  | { type: 'scan_done'; ts: string; files: number }
  | { type: 'scan_warning'; ts: string; message: string }
  | { type: 'plan_file_loaded'; ts: string; file?: string; documents?: number; scope?: { include: number; exclude: number } }
  | { type: 'plan_started'; ts: string }
  | { type: 'plan_retry'; ts: string; attempt?: number; codes?: string }
  | { type: 'plan_ready'; ts: string; pages?: Array<{ path: string; title: string }>; coverage?: number; strict?: boolean }
  | { type: 'dry_run'; ts: string }
  | { type: 'page_start'; ts: string; path?: string }
  | { type: 'page_retry'; ts: string; path?: string; attempt?: number; codes?: string }
  | { type: 'page_note'; ts: string; path?: string; message?: string }
  | PageDoneEvent
  | { type: 'page_fail'; ts: string; path?: string; message?: string }
  | { type: 'stale_removed'; ts: string; path?: string }
  | { type: 'catalog_written'; ts: string; metaDir?: string }
  | { type: 'knowledge_started'; ts: string }
  | { type: 'knowledge_card_fail'; ts: string; path?: string; message?: string }
  | { type: 'knowledge_done'; ts: string; generated?: number; duplicates?: number; removed?: number; dir?: string }
  | { type: 'knowledge_failed_run'; ts: string; failed?: number }
  | { type: 'run_note'; ts: string; message?: string }
  | { type: 'run_aborted'; ts: string; ok?: number; skipped?: number; failed?: number; subject?: string }
  | { type: 'run_finished'; ts: string; stats?: { generated: number; degraded: number; skipped: number; failed: number; knowledgeFailed: number }; outDir?: string; tip?: string }
  | { type: 'run_error'; ts: string; code?: string; message?: string }
  | { type: 'cleanup_warning'; ts: string; target?: string; message?: string }
  | { type: 'model_profile'; ts: string; name?: string; default?: boolean; provider?: string; model?: string };

const TYPES: ReadonlySet<string> = new Set([
  'run_started','env_loaded','scan_started','scan_done','scan_warning','plan_file_loaded',
  'plan_started','plan_retry','plan_ready','dry_run','page_start','page_retry','page_note',
  'page_done','page_fail','stale_removed','catalog_written','knowledge_started',
  'knowledge_card_fail','knowledge_done','knowledge_failed_run','run_note','run_aborted',
  'run_finished','run_error','cleanup_warning','model_profile',
]);

export function isWikiEvent(value: unknown): value is WikiEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && TYPES.has(v.type) && typeof v.ts === 'string' && v.ts.length > 0;
}

export function parseNdjsonLine(line: string): WikiEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isWikiEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
