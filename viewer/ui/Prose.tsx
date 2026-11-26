// Cited prose: the markdown subset as elements (never innerHTML), with every
// [path:line] drawn as a small chip that opens the file in the user's editor.

import type { ComponentChildren, JSX } from "preact";
import { editorUrl } from "../lib/editor.js";
import { t } from "../lib/i18n.js";
import { type Block, type CiteRef, citeLabel, citeWhere, type Inline, parseInline, parseLocation, parseMarkdown } from "../lib/markdown.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";

export function CiteChip({ cite, full }: { cite: CiteRef; full?: boolean }): JSX.Element {
  const { settings, repo, copy } = useApp();
  const href = editorUrl(settings.editor, repo, cite.path, cite.line, cite.end);
  const where = citeWhere(cite);
  const label = full ? where : citeLabel(cite);
  if (!href) {
    return (
      <button
        type="button"
        class="cite"
        title={t("cite.copyPath", { where })}
        aria-label={t("cite.copyPath", { where })}
        onClick={() => copy(where, t("toast.pathCopied"))}
      >
        {label}
      </button>
    );
  }
  const web = href.startsWith("http");
  return (
    <a
      class="cite"
      href={href}
      title={t(web ? "cite.openWeb" : "cite.openEditor", { where })}
      aria-label={t(web ? "cite.openWeb" : "cite.openEditor", { where })}
      {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {label}
    </a>
  );
}

/** A `path:line` location as a chip. */
export function LocationChip({ at, full }: { at: string; full?: boolean }): JSX.Element | null {
  const c = parseLocation(at);
  return c ? <CiteChip cite={c} full={full} /> : null;
}

/** Draws a citation in place of the default chip (the chat panel opens the cited node instead). */
export type CiteRenderer = (cite: CiteRef, key: number) => ComponentChildren;

function renderInline(nodes: readonly Inline[], cite?: CiteRenderer): ComponentChildren[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}>{renderInline(n.c, cite)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c, cite)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c, cite)}
          </a>
        );
      case "cite":
        return cite ? cite(n.cite, i) : <CiteChip key={i} cite={n.cite} />;
    }
  });
}

function renderBlock(b: Block, i: number, cite?: CiteRenderer): JSX.Element {
  switch (b.t) {
    case "p":
      return <p key={i}>{renderInline(b.c, cite)}</p>;
    case "h":
      return (
        <p key={i} class="md-h">
          <strong>{renderInline(b.c, cite)}</strong>
        </p>
      );
    case "ul":
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it, cite)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} start={b.start}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it, cite)}</li>
          ))}
        </ol>
      );
  }
}

/** One line or paragraph of cited prose (summaries, notes). */
export function Prose({ text, class: cls }: { text: string; class?: string }): JSX.Element {
  return <p class={`prose${cls ? ` ${cls}` : ""}`}>{renderInline(parseInline(text))}</p>;
}

/** A block of markdown (lens answers, chat answers). */
export function Markdown({ text, cite }: { text: string; cite?: CiteRenderer }): JSX.Element {
  return <div class="md">{parseMarkdown(text).map((b, i) => renderBlock(b, i, cite))}</div>;
}

export function CopyButton({ text, label, message, icon = "copy" }: { text: string; label: string; message: string; icon?: string }): JSX.Element {
  const { copy } = useApp();
  return (
    <button type="button" class="btn" onClick={() => copy(text, message)}>
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}
