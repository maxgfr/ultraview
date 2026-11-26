import { countWords } from "../../../core/src/index.js";

export function runCount(args: string[]): number {
  console.log(String(countWords(args.join(" "))));
  return 0;
}
