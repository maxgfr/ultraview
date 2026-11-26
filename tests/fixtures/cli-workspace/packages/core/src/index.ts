import { wrap } from "./text/wrap.js";

export function format(message: string, width = 40): string {
  return wrap(message.trim(), width);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
