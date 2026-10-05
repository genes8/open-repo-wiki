import { spawn, type ChildProcess } from 'node:child_process';
import { parseNdjsonLine, type WikiEvent } from './pure/events.js';

export interface RunResult { code: number; errorEvent?: { code?: string; message?: string } }
export interface RunOptions {
  args: string[];
  cwd: string;
  onEvent: (event: WikiEvent) => void;
  onLog?: (line: string) => void;
}

export class EngineRunner {
  private child: ChildProcess | null = null;
  private active: Promise<RunResult> | null = null;

  public isActive(): boolean { return this.active !== null; }

  public async run(command: string, scriptPath: string, prefixArgs: string[], env: NodeJS.ProcessEnv, opts: RunOptions): Promise<RunResult> {
    if (this.active) throw new Error('an engine run is already active');
    this.active = this.spawnRun(command, scriptPath, prefixArgs, env, opts);
    try {
      return await this.active;
    } finally {
      this.active = null;
    }
  }

  public cancel(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      const child = this.child;
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  }

  private spawnRun(command: string, scriptPath: string, prefixArgs: string[], env: NodeJS.ProcessEnv, opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...prefixArgs, scriptPath, ...opts.args], {
        cwd: opts.cwd,
        env: { ...process.env, ...env },
      });
      this.child = child;
      let buffer = '';
      let errorEvent: { code?: string; message?: string } | undefined;
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const event = parseNdjsonLine(line);
          if (event) {
            if (event.type === 'run_error') errorEvent = { code: event.code, message: event.message };
            opts.onEvent(event);
          } else {
            opts.onLog?.(line);
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => opts.onLog?.(chunk.toString('utf8').trimEnd()));
      child.on('error', (err) => {
        this.child = null;
        resolve({ code: -1, errorEvent: { code: 'spawn_failed', message: err.message } });
      });
      child.on('close', (code) => {
        this.child = null;
        resolve({ code: code ?? -1, errorEvent });
      });
    });
  }
}
