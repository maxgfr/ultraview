import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Order } from "./order.entity";

@Injectable()
export class OrdersService {
  private readonly orders = this.dataSource.getRepository(Order);

  constructor(private readonly dataSource: DataSource) {}

  list() {
    return this.orders.find({ relations: { user: true } });
  }

  async place(totalCents: number) {
    return this.dataSource.manager.save(Order, { totalCents });
  }
}
