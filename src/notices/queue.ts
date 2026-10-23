// The notice queue: what waits to be told to the model, and the delivery rules that decide when a turn starts for it.
//
// The module holds the state (is a turn running, when did the last wake go, is one waited for or refused) and the
// rules; everything that touches the plugin API arrives as `NoticePorts`, which hooks/register.tsx builds from `$`
// (the engine follows `$` only within the hooks module). Producers add notices; the hooks tell it when a turn starts
// and ends and call `deliver` on a tick.

import { requeue, wakeText, wakeVerdict, type Notice } from './notice'

/** What the queue needs from the plugin API, built per call from `$` in hooks/register.tsx. */
export type NoticePorts = {
  now: () => Promise<number>
  /** Reads the stored queue (anything: it is checked). */
  load: () => Promise<unknown>
  save: (list: Notice[]) => Promise<void>
  /** The text in the prompt box. */
  draft: () => Promise<string>
  /** Submits a wake as a prompt; the engine answers `{ drop: <reason> }` for one it refuses. */
  submit: (text: string) => Promise<unknown>
  log: (text: string) => void
  toast: (text: string) => void
  /** Called when what the status line shows (a refusal held, a wake sent) may have changed. */
  changed: () => Promise<void>
}

/** The delivery settings, read from the config at each call so a reload applies. */
export type WakeRules = {
  gapSeconds: number
  deferMinutes: number
  resendAfterMinutes: number
  preamble: string
  /** Under plainOutput a refusal is told without the engine's reason. */
  plain: boolean
}

/** What runs when nothing is queued (the idle wake): the time, and whether a wake is held. */
export type WhenEmpty = (now: number, held: boolean) => Promise<void>

/**
 * The queue of notices and the state of the wakes sent for them. One instance lives as long as the hooks module,
 * so it survives /clear; the notices themselves are kept through `NoticePorts.save`, so a reload loses none.
 */
export class Notices {
  /** Whether a main-loop turn is running. */
  busy = false
  /** When the last wake was sent (-Infinity: none; a refused one is taken back). */
  lastWakeAt = -Infinity
  /** When the main loop's last turn ended (or the plugin started): a lost wake and the idle wake count from it. */
  idleSince = 0
  /** How many notices waited at the last read of the store (not after a write), so a status line need not read it. */
  count = 0

  /** True while a delivery is deciding or submitting, so two ticks cannot send the same notices. */
  private delivering = false
  /**
   * A wake submitted that no main-loop turn has started for yet, with the notices it named: the next turn start
   * clears it; while the session sits idle `resendAfterMinutes` past it, its notices go back to be sent again.
   */
  private awaiting: { at: number; pending: Notice[] } | undefined
  /** Until when a wake the engine refused holds the next one (0: none); the next main-loop turn lifts it. */
  private heldUntil = 0
  /** The last refusal's reason, so each new reason is told once. */
  private refusal = ''

  /** Whether a wake is waited for or refused, so no other goes meanwhile. */
  get held(): boolean {
    return this.awaiting !== undefined || this.heldUntil > 0
  }

  /** Whether a refused wake still holds the next one (the status line says `wake refused`). */
  get refused(): boolean {
    return this.heldUntil > 0
  }

  /** The notices not yet told, from the store. */
  async pending(ports: NoticePorts): Promise<Notice[]> {
    const v = await ports.load()
    const list = Array.isArray(v) ? (v as Notice[]) : []
    this.count = list.length
    return list
  }

  /** Queues a notice after the ones waiting, however many alike: each is told. */
  async append(ports: NoticePorts, add: Notice): Promise<void> {
    await ports.save([...(await this.pending(ports)), add])
  }

  /** Queues notices that join the ones waiting, telling each producer's key once. */
  async merge(ports: NoticePorts, add: Notice[]): Promise<void> {
    await ports.save(requeue(await this.pending(ports), add))
  }

  /** A main-loop turn started: it takes in the wake sent and lifts a refusal's hold. */
  turnStarted(): void {
    this.busy = true
    this.awaiting = undefined
    this.heldUntil = 0
  }

  /** A main-loop turn ended at `now`. */
  turnEnded(now: number): void {
    this.busy = false
    this.idleSince = now
  }

  /**
   * Starts a turn for the pending notices when the session is idle, nobody is typing and the gap has passed.
   * With nothing pending, `whenEmpty` runs.
   */
  async deliver(ports: NoticePorts, rules: WakeRules, whenEmpty?: WhenEmpty): Promise<void> {
    if (this.delivering) return
    this.delivering = true
    try {
      await this.deliverOnce(ports, rules, whenEmpty)
    } finally {
      this.delivering = false
    }
  }

  /** One delivery attempt; deliver() keeps two from overlapping. */
  private async deliverOnce(ports: NoticePorts, rules: WakeRules, whenEmpty?: WhenEmpty): Promise<void> {
    const now = await ports.now()
    // A wake the engine took but no turn started for, while the session sat idle: what it named is sent again
    if (this.awaiting && !this.busy && now - Math.max(this.awaiting.at, this.idleSince) >= rules.resendAfterMinutes * 60_000) {
      const lost = this.awaiting.pending
      this.awaiting = undefined
      if (lost.length > 0) await ports.save(requeue(lost, await this.pending(ports)))
      ports.log('watch: the last wake started no turn; it is sent again')
    }
    if (this.heldUntil && now >= this.heldUntil) {
      this.heldUntil = 0
      // The status line drops `wake refused` now, not at the next countdown tick (there may be none)
      await ports.changed()
    }
    const held = this.held
    const pending = await this.pending(ports)
    if (pending.length === 0) return whenEmpty ? whenEmpty(now, held) : undefined
    const draft = this.busy ? '' : await ports.draft()
    const verdict = wakeVerdict(pending, { busy: this.busy, draft, now, lastWakeAt: this.lastWakeAt, gapSeconds: rules.gapSeconds, deferMinutes: rules.deferMinutes, held })
    if (verdict !== 'go') return
    // Clear first, so a second tick during the submit cannot send the same notices twice
    await ports.save([])
    await this.submit(ports, rules, now, wakeText(rules.preamble, pending), pending)
    await ports.changed()
  }

  /**
   * Submits one wake naming `pending` (already taken out of the store). It counts as sent until a main-loop turn
   * starts; a refusal (a `drop` answer) or a failed submit puts the notices back and holds the next wake for
   * `resendAfterMinutes`, or until the next turn starts.
   */
  async submit(ports: NoticePorts, rules: WakeRules, now: number, text: string, pending: Notice[]): Promise<void> {
    const before = this.lastWakeAt
    this.lastWakeAt = now
    // Set before the submit, so a turn that starts while it is still being answered clears it
    const mine = { at: now, pending }
    this.awaiting = mine
    let refused: string | undefined
    try {
      const r = await ports.submit(text)
      if (r && typeof r === 'object' && typeof (r as { drop?: unknown }).drop === 'string') refused = (r as { drop: string }).drop
    } catch (err) {
      refused = String(err)
    }
    if (refused === undefined) {
      this.refusal = ''
      return
    }
    if (this.awaiting === mine) this.awaiting = undefined
    // Put them back for the next try, which the gap must not hold up
    if (pending.length > 0) await ports.save(requeue(pending, await this.pending(ports)))
    this.lastWakeAt = before
    this.heldUntil = now + rules.resendAfterMinutes * 60_000
    if (refused !== this.refusal) {
      ports.log(rules.plain ? 'watch: wake refused' : `watch: wake refused: ${refused}`)
      ports.toast(rules.plain ? 'watch: a wake was refused' : `watch: a wake was refused (${refused}); it is tried again in ${rules.resendAfterMinutes} min or after the next turn starts`)
    }
    this.refusal = refused
  }
}
