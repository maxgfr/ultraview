// Prompts the viewer copies for the user's coding agent. They are
// instructions to an agent that reads English, not interface text, so they
// stay in English whatever the interface language.

export function askAboutNode(id: string, label: string): string {
  return `Using ultraview, explain ${id} (${label}): what it does for the app, what it depends on and what depends on it. Run \`ultraview show ${id}\` and \`ultraview dossier ${id}\` first, and cite [path:line] for every claim.`;
}

export function reaskLens(id: string, question: string): string {
  return `Use ultraview to re-answer the lens "${question}" (id ${id}): its cited files changed since it was saved. Run \`ultraview lens new "${question}"\`, rewrite the answer with fresh citations, then \`ultraview lens save\` and \`ultraview check\`.`;
}

export function retraceFlow(id: string, title: string): string {
  return `Use ultraview to re-trace the flow "${title}" (id ${id}): its cited files changed since it was saved. Update each step's note with fresh citations, then \`ultraview flow save\` and \`ultraview check\`.`;
}

export function askAboutInsight(title: string, nodes: readonly string[]): string {
  const where = nodes.length ? ` It involves ${nodes.slice(0, 8).join(", ")}.` : "";
  return `Using ultraview, look into this insight: "${title}".${where} Explain whether it is a real problem, cite [path:line] for every claim, and propose the smallest fix.`;
}

export function businessMapPrompt(app: string): string {
  return `Use ultraview (/ultraview) to write the business map of ${app}: run \`ultraview status\` and follow it to describe the capabilities, who uses them and the systems in .ultraview/model.json, with a [path:line] citation for every claim. Then run \`ultraview check\` and \`ultraview render\`.`;
}

export function askAboutEdge(from: string, to: string): string {
  return `Using ultraview, explain the link from ${from} to ${to}: why ${from} depends on ${to} and what goes through it. Run \`ultraview show ${from}\` and \`ultraview show ${to}\` first, and cite [path:line] for every claim.`;
}

export function askAboutStep(flow: string, title: string, n: number, node: string): string {
  return `Using ultraview, explain step ${n} of the flow "${title}" (id ${flow}), on ${node}: what happens there and why. Run \`ultraview show ${node}\` first, and cite [path:line] for every claim.`;
}
