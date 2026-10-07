/* Globals the Convex V8 isolate provides. This tree has no @types/node on
 * purpose (the runtime is not Node) — declare the few we use, minimally. */
declare const process: { env: Record<string, string | undefined> }
declare class URLSearchParams {
  constructor(init?: string)
  get(name: string): string | null
  getAll(name: string): string[]
  has(name: string): boolean
  append(name: string, value: string): void
  set(name: string, value: string): void
  [Symbol.iterator](): IterableIterator<[string, string]>
  toString(): string
}
declare class URL {
  constructor(url: string, base?: string)
  readonly hostname: string
  readonly origin: string
  readonly pathname: string
  readonly search: string
  readonly searchParams: URLSearchParams
  toString(): string
}
/* Fetch-API surface the /files//avatars gateway (http.ts) touches. Convex's
 * own d.ts references these names too (skipLibCheck), so these minimal shapes
 * become the shared globals — extend, never fork, if more members are needed. */
declare class Headers {
  constructor(init?: Headers | Record<string, string>)
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}
declare class Blob {
  readonly size: number
  readonly type: string
}
declare class Request {
  constructor(input: Request, init?: { headers?: Headers | Record<string, string> })
  readonly url: string
  readonly method: string
  readonly headers: Headers
  text(): Promise<string>
  clone(): Request
}
declare function atob(value: string): string
declare class Response {
  constructor(
    body?: Blob | string | null,
    init?: { status?: number; headers?: Headers | Record<string, string> },
  )
  readonly status: number
  readonly headers: Headers
  text(): Promise<string>
  clone(): Response
}
declare const console: {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}
