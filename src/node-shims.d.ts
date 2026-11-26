// 轻量 Node.js 运行时类型补充，使 `tsc --noEmit` 在不安装额外 npm 依赖时也能严格校验 worker 源码。
declare const process: {
  readonly env: Record<string, string | undefined>
  kill(pid: number, signal?: string | number): boolean
}

declare class Buffer extends Uint8Array {
  static allocUnsafe(size: number): Buffer
  subarray(start?: number, end?: number): Buffer
  toString(encoding?: string): string
}

declare module 'node:path' {
  export function basename(p: string): string
  export function join(...paths: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:fs' {
  export function existsSync(p: string): boolean
}

declare module 'node:fs/promises' {
  export interface FileHandle {
    stat(): Promise<{ size: number; mtimeMs: number }>
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }
  export function open(p: string, flags: string): Promise<FileHandle>
  export function stat(p: string): Promise<{ size: number; mtimeMs: number }>
  export function readFile(p: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:child_process' {
  export interface ExecFileOptions {
    timeout?: number
    maxBuffer?: number
    env?: Record<string, string | undefined>
    signal?: AbortSignal
  }
  export interface SpawnOptions {
    detached?: boolean
    stdio?: Array<'ignore' | 'pipe'>
    env?: Record<string, string | undefined>
  }
  export interface ChildStream {
    on(event: 'data', listener: (chunk: Buffer | string) => void): this
  }
  export interface ChildProcessLike {
    readonly pid?: number
    readonly stdout: ChildStream | null
    readonly stderr: ChildStream | null
    on(event: 'close', listener: (code: number | null) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    unref(): void
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void
  export function spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions
  ): ChildProcessLike
}

declare module 'node:util' {
  export function promisify(
    fn: (
      file: string,
      args: readonly string[],
      options: import('node:child_process').ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => void
  ): (
    file: string,
    args: readonly string[],
    options?: import('node:child_process').ExecFileOptions
  ) => Promise<{ stdout: string; stderr: string }>
  export function promisify<TArgs extends unknown[], TRes>(
    fn: (...args: [...TArgs, (err: unknown, res: TRes) => void]) => void
  ): (...args: TArgs) => Promise<TRes>
}
