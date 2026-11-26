// Performance marks behind the `?perf` query flag: time to the first painted
// map, and from each map navigation (level switch, drill) to its painted
// layout, logged to the console. Off by default: every call is a no-op.

const enabled = typeof location !== "undefined" && /[?&]perf(?:[=&]|$)/.test(location.search);

interface Pending {
  label: string;
  start: number;
  /** Named intermediate times, relative to start. */
  steps: [string, number][];
}

let pending: Pending | undefined = enabled ? { label: "first paint", start: 0, steps: [] } : undefined;

export const perfEnabled = (): boolean => enabled;

/** Start timing a navigation; the next painted map ends it. */
export function perfStart(label: string): void {
  if (!enabled) return;
  pending = { label, start: performance.now(), steps: [] };
}

/** Note an intermediate step of the running measure (parse, index, scene, layout). */
export function perfStep(name: string): void {
  if (!enabled || !pending) return;
  pending.steps.push([name, performance.now() - pending.start]);
}

/** Time a synchronous piece of work as a step. */
export function perfTime<T>(name: string, fn: () => T): T {
  if (!enabled || !pending) return fn();
  const t0 = performance.now();
  const out = fn();
  pending.steps.push([`${name} (${(performance.now() - t0).toFixed(1)} ms)`, performance.now() - pending.start]);
  return out;
}

/** The map painted a layout: close the running measure after the frame is on screen. */
export function perfPainted(what: string): void {
  if (!enabled || !pending) return;
  const p = pending;
  pending = undefined;
  requestAnimationFrame(() =>
    setTimeout(() => {
      const total = performance.now() - p.start;
      const steps = p.steps.map(([n, t]) => `${n} @${t.toFixed(0)}`).join(", ");
      console.info(`[ultraview perf] ${p.label}: ${total.toFixed(0)} ms (${what})${steps ? ` — ${steps}` : ""}`);
    }, 0),
  );
}
