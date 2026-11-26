import { runGreet } from "../src/commands/greet.js";

export function greetSmoke(): boolean {
  return runGreet(["Ada"]) === 0;
}
