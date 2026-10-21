import type { ServerOptions } from 'vite'

/** The server.watch and server.fs options for the checkout at `root`. */
export function devServerFiles(root: string): Required<Pick<ServerOptions, 'watch' | 'fs'>>
