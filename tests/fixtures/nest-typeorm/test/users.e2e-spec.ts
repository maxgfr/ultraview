import { Controller, Get } from "@nestjs/common";

@Controller("test-only")
export class FakeController {
  @Get()
  ping() {
    return "pong";
  }
}
