// The "code changed" banner of a served map (docs/design.md §8): the index
// went stale since the map was built. Renders nothing on a static page. (The
// questions go through the chat panel, ui/Chat.tsx.)

import type { JSX } from "preact";
import { num, t } from "../lib/i18n.js";
import { showStale, staleCount } from "../lib/live.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";

/** A non-blocking strip under the top bar: the map is older than the code. */
export function StaleBanner(): JSX.Element | null {
  const { live, dismissLive } = useApp();
  if (!showStale(live) || !live.stale) return null;
  const n = staleCount(live.stale);
  const files = live.stale.files;
  return (
    <div class="live-banner" role="status">
      <Icon name="warning" size={14} />
      <span>
        {n ? t("live.stale", { count: n, n: num(n) }) : t("live.staleNoCount")} <code class="cmd">ultraview build</code>
      </span>
      {files.length ? (
        <span class="live-files" title={files.join("\n")}>
          {files.slice(0, 3).join(", ")}
          {files.length > 3 || n > 3 ? "…" : ""}
        </span>
      ) : null}
      <button type="button" class="icon-btn small" aria-label={t("live.dismiss")} title={t("live.dismiss")} onClick={() => dismissLive("stale")}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
