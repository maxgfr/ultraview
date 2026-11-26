import { Controller, Get } from "@nestjs/common";

@Controller("spec-only")
export class SpecController {
  @Get()
  ping() {
    return "pong";
  }
}
