// Shared by the row cells, sticky headings, week ruler and dependency overlay.
export const LABEL_W = 372
export const GUTTER_W = 56
export const GRID_X = LABEL_W + GUTTER_W
export const ROW_H = { track: 40, sub: 30, task: 34, unsched: 34 } as const
export const HEAD_STICK = 0
export const SUB_STICK = HEAD_STICK + ROW_H.track + 1
