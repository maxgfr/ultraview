// "Start here": the model's tour stops, one at a time, each revealed and lit
// on the map with its cited note.

import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { t } from "../lib/i18n.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";
import { Prose } from "./Prose.js";

export function Tour(): JSX.Element | null {
  const { ix, state, update, reveal } = useApp();
  const stops = ix.view.tour ?? [];
  const i = state.tour;
  const card = useRef<HTMLDivElement>(null);
  const stop = i !== undefined ? stops[i] : undefined;

  useEffect(() => {
    if (!stop) return;
    reveal(stop.node, { ids: [stop.node], label: t("tour.spot") }, "replace");
    requestAnimationFrame(() => card.current?.querySelector<HTMLElement>(".tour-next")?.focus({ preventScroll: true }));
  }, [i]);

  useEffect(() => {
    if (i === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") update({ tour: undefined, spotlight: undefined });
      else if (e.key === "ArrowRight" && i < stops.length - 1) update({ tour: i + 1 });
      else if (e.key === "ArrowLeft" && i > 0) update({ tour: i - 1 });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, stops.length]);

  if (!stop || i === undefined) return null;
  const node = ix.byId.get(stop.node);
  const last = i === stops.length - 1;
  return (
    <div class="tour" ref={card} role="dialog" aria-modal="false" aria-labelledby="tour-title">
      <div class="tour-head">
        <span class="muted small">{t("tour.progress", { n: i + 1, total: stops.length })}</span>
        <button
          type="button"
          class="icon-btn small"
          aria-label={t("tour.end")}
          title={t("tour.end")}
          onClick={() => update({ tour: undefined, spotlight: undefined })}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <h2 id="tour-title">{node?.label ?? stop.node}</h2>
      <Prose text={stop.note} />
      <div class="tour-actions">
        <button type="button" class="btn" disabled={i === 0} onClick={() => update({ tour: i - 1 })}>
          <Icon name="chevronLeft" size={14} />
          {t("tour.prev")}
        </button>
        <button
          type="button"
          class="btn btn-primary tour-next"
          onClick={() => (last ? update({ tour: undefined, spotlight: undefined }) : update({ tour: i + 1 }))}
        >
          {last ? t("tour.done") : t("tour.next")}
          {!last ? <Icon name="chevronRight" size={14} /> : null}
        </button>
      </div>
    </div>
  );
}
