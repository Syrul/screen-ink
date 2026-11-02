// The build panel: the step of the instructions the user is building from, as the overlay shows it.

export interface BuildPanel {
  title: string
  /** Where it is: "Step 12 of 48", "After step 19", "Finished". */
  label: string
  /** The view's place among all of them (from 0), for the progress bar and the buttons. */
  index: number
  total: number
  /** The page as a data: URL, and the part of it to show, as fractions of its width and height. */
  image?: string
  crop?: [number, number, number, number]
  parts?: number
  times?: number
  /** What the step asks, shown under its picture and read out. */
  say?: string
  /** In place of a step: what is happening (fetching the instructions) or what went wrong. */
  status?: string
  /** The ink's colour, for the panel's buttons. */
  ink?: string
  /** The step in 3D, when there's a model of the set that lines up with the instructions. */
  model?: BuildModel
  /** Whether the panel shows it, rather than the page. */
  in3d?: boolean
  /** Meanwhile, what is happening with the 3D model: being looked for, its parts being fetched. */
  modelStatus?: string
}

export interface BuildModel {
  /** Which model it is: the page asks for its parts once, by this. */
  key: string
  /** The parts placed before the step, and the step's own, as LDraw lines. */
  old: string
  added: string
  /** Who made the model, to credit. */
  credit: string
}

/** A model's parts, as one MPD of every file they use, and the LDraw colours they come in. */
export interface BuildParts {
  pack: string
  colours: string
}

export const BUILD_MOVES = ['next', 'back', 'again', 'close', '3d', 'page'] as const
export type BuildMove = (typeof BUILD_MOVES)[number]
