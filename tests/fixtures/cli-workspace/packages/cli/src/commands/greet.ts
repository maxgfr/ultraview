import { format } from "../../../core/src/index.js";

export function runGreet(args: string[]): number {
  console.log(format(`Hello, ${args.join(" ") || "world"}!`));
  return 0;
}
