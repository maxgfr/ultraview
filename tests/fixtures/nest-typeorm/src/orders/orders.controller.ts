import { Body, Controller, Get, Post } from "@nestjs/common";
import { OrdersService } from "./orders.service";

@Controller({ path: "api/orders" })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  public async list() {
    return this.orders.list();
  }

  @Post("checkout")
  checkout(@Body() body: { totalCents: number }) {
    return this.orders.place(body.totalCents);
  }
}
