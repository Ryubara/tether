// The slash commands Tether registers: one table, so the names, the descriptions and the `(PANE)` marker
// are held in one place. Every name carries the `tether-` prefix so Tether's commands sort together in the
// typeahead and never clash with another plugin's or Claude Code's own. (`$.command.register` takes letters,
// digits, `_` and `-` only, so the prefix is `tether-`, not `tether:`.)

/** One command Tether registers. */
export type TetherCommand = {
  /** The name typed after the slash, prefix included. */
  name: string
  /** What the command list shows; ends with `(PANE)` when the command opens or shows something in the pane. */
  description: string
  /** Whether the command opens or shows something in the pane (then its description says `(PANE)`). */
  pane: boolean
  argumentHint?: string
}

/** The marker a description carries when its command works in the pane. */
export const PANE_MARK = '(PANE)'

/** Builds a command whose description gets the pane marker exactly when `pane` is true. */
function command(name: string, text: string, pane: boolean, argumentHint?: string): TetherCommand {
  return { name: `tether-${name}`, description: pane ? `${text} ${PANE_MARK}` : text, pane, ...(argumentHint ? { argumentHint } : {}) }
}

/** `/tether-fleet` opens the Tether pane (agents on top, watch's boxes under them); `/tether-fleet text` prints the table. */
export const FLEET = command('fleet', 'Agents, context, cache and usage', true, '[text]')
/** `/tether-watch` reports the pollers and opens the Tether pane beside the report; `pane` opens and focuses it. */
export const WATCH = command('watch', 'Pollers and what they found', true, '[run [id] | forget [id] | reload | pane]')
/** `/tether-guards` prints the open PR problems and undecided agents as text. */
export const GUARDS = command('guards', 'PR problems and stopped agents nobody has dealt with', false)

/** `/tether-checkpoint` starts the checkpoint now: the handoff asked for, checked, then the clear and the continue. */
export const CHECKPOINT = command('checkpoint', 'Write and check the handoff, then clear and continue, now', false)

/** Every command Tether registers. */
export const COMMANDS: TetherCommand[] = [FLEET, WATCH, GUARDS, CHECKPOINT]

/** What `$.command.register` takes for a command: it refuses any other field (`pane`). */
export function registration(c: TetherCommand): { name: string; description: string; argumentHint?: string } {
  return { name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }
}
