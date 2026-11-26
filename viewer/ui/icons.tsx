// One small hand-drawn icon set: 16×16 grid, 1.5 stroke, round caps, no fill
// unless the shape needs it. Used both inside HTML (<Icon/>) and inside the
// map's SVG (<KindGlyph/> draws the same paths at an offset).

import type { JSX } from "preact";

const P: Record<string, string> = {
  // node kinds
  cap: "M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5M8 4.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5ZM8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  actor: "M8 2.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5ZM2.75 14c.4-2.75 2.6-4.5 5.25-4.5s4.85 1.75 5.25 4.5",
  sys: "M2.25 2.75h11.5v4H2.25zM2.25 9.25h11.5v4H2.25zM4.75 4.75h.01M4.75 11.25h.01M7.5 4.75h3.5M7.5 11.25h3.5",
  mod: "M1.75 4.25 8 1.5l6.25 2.75v7.5L8 14.5l-6.25-2.75zM1.75 4.25 8 7l6.25-2.75M8 7v7.5",
  file: "M4 1.75h5l3.25 3.25v9.25H4zM9 1.75V5h3.25M6 8.5h4M6 11h4",
  sym: "M5.5 2.5C4 2.5 4 3.5 4 5s-.5 2.25-1.75 3C3.5 8.75 4 9.5 4 11s0 2.5 1.5 2.5M10.5 2.5c1.5 0 1.5 1 1.5 2.5s.5 2.25 1.75 3C12.5 8.75 12 9.5 12 11s0 2.5-1.5 2.5",
  route: "M2 8h7.5M7 4.75 10.25 8 7 11.25M12 3v10",
  screen: "M1.75 2.75h12.5v8.5H1.75zM5.5 14h5M8 11.25V14",
  entity:
    "M2.75 4c0-1.25 2.35-2.25 5.25-2.25s5.25 1 5.25 2.25v8c0 1.25-2.35 2.25-5.25 2.25S2.75 13.25 2.75 12zM2.75 4c0 1.25 2.35 2.25 5.25 2.25S13.25 5.25 13.25 4M2.75 8c0 1.25 2.35 2.25 5.25 2.25S13.25 9.25 13.25 8",
  job: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM8 4.5V8l2.5 1.5",
  ext: "M4.5 12.75a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.7-1.03 3.5 3.5 0 0 1 .2 7z",
  infra: "M8 1.75 13.75 5v6L8 14.25 2.25 11V5zM2.25 5 8 8.25 13.75 5M8 8.25v6",
  cluster: "M3 5.25h10v8H3zM4.5 3.25h7M6 1.5h4",
  folder: "M1.75 3.25h4.5l1.5 1.75h6.5v8H1.75zM1.75 6.5h12.5",
  // interface
  search: "M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5ZM10.5 10.5l3.25 3.25",
  sun: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06",
  moon: "M13.25 9.5A5.75 5.75 0 0 1 6.5 2.75a5.75 5.75 0 1 0 6.75 6.75Z",
  gear: "M8 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5ZM8 1.5l1.2 1.6 2-.3.5 1.95 1.85.85-.6 1.9 1.05 1.5-1.05 1.5.6 1.9-1.85.85-.5 1.95-2-.3L8 14.5l-1.2-1.6-2 .3-.5-1.95-1.85-.85.6-1.9L2 8l1.05-1.5-.6-1.9 1.85-.85.5-1.95 2 .3z",
  close: "M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5",
  chevronRight: "M6 3.5 10.5 8 6 12.5",
  chevronLeft: "M10 3.5 5.5 8 10 12.5",
  chevronDown: "M3.5 6 8 10.5 12.5 6",
  fit: "M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  map: "M1.75 3.5 5.75 2l4.5 1.75 4-1.5v10.25l-4 1.5-4.5-1.75-4 1.5zM5.75 2v10.25M10.25 3.75V14",
  play: "M4.5 2.75v10.5L13 8z",
  copy: "M5.5 5.5h8v8.25h-8zM10.5 5.5V2.25h-8v8.25h3",
  open: "M9 2.25h4.75V7M13.75 2.25 7.5 8.5M11.5 9.5v4.25h-9.25V4.5H6.5",
  warning: "M8 2 14.5 13.5h-13zM8 6.5v3.25M8 11.75h.01",
  refresh: "M13.5 3v3.5H10M13.25 6.5A5.5 5.5 0 1 0 13 10",
  ask: "M2.25 3h11.5v8H7l-3 2.5V11H2.25zM5.5 6.25h5M5.5 8.25h3",
  drill: "M2.25 2.25h5v5h-5zM8.75 8.75h5v5h-5zM7.25 4.75h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5",
  data: "M2.75 4c0-1.25 2.35-2.25 5.25-2.25s5.25 1 5.25 2.25v8c0 1.25-2.35 2.25-5.25 2.25S2.75 13.25 2.75 12zM2.75 4c0 1.25 2.35 2.25 5.25 2.25S13.25 5.25 13.25 4",
  flow: "M3 3.25h3v3H3zM10 9.75h3v3h-3zM6 4.75h2.5a1.5 1.5 0 0 1 1.5 1.5v3.5",
  lens: "M6.75 2.25a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10 10l3.75 3.75M5 6.75h3.5",
  changes: "M8 1.75v12.5M3.5 5.5h3M5 4v3M9.5 10.5h3",
  insights: "M8 1.75a4.25 4.25 0 0 0-2.5 7.7V11.5h5V9.45A4.25 4.25 0 0 0 8 1.75ZM6 13.75h4",
  link: "M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6",
  key: "M5.25 7a3.25 3.25 0 1 0 0 .01M8.25 7.5h6M12 7.5v2.25M14.25 7.5v1.5",
  dot: "M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
};

export type IconName = keyof typeof P;

export function iconPath(name: string): string {
  return P[name] ?? P.dot!;
}

export function Icon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }): JSX.Element {
  return (
    <svg class={`icon${cls ? ` ${cls}` : ""}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={iconPath(name)} />
    </svg>
  );
}

/** The same glyph drawn inside the map's SVG at (x, y). */
export function Glyph({ name, x, y, size = 16 }: { name: string; x: number; y: number; size?: number }): JSX.Element {
  const s = size / 16;
  return (
    <g class="glyph" transform={`translate(${x} ${y}) scale(${s})`}>
      <path d={iconPath(name)} />
    </g>
  );
}
