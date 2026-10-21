import type { Plugin, ServerOptions } from 'vite'

/** The server.watch and server.fs options for the checkout at `root`. */
export function devServerFiles(root: string): Required<Pick<ServerOptions, 'watch' | 'fs'>>

/** Refuses dev server requests for a file whose real path server.fs refuses. */
export function refuseLinkedFiles(): Plugin
