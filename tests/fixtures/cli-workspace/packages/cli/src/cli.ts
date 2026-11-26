#!/usr/bin/env node
import { runCount } from "./commands/count.js";
import { runGreet } from "./commands/greet.js";

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "greet") return runGreet(rest);
  if (command === "count") return runCount(rest);
  console.error("usage: tool greet <name> | tool count <text>");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
