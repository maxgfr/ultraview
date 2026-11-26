import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Order } from "./orders/order.entity";
import { OrdersController } from "./orders/orders.controller";
import { OrdersService } from "./orders/orders.service";
import { User } from "./users/user.entity";
import { UsersController } from "./users/users.controller";
import { UsersService } from "./users/users.service";

@Module({
  imports: [TypeOrmModule.forRoot({ type: "postgres", entities: [User, Order] }), TypeOrmModule.forFeature([User, Order])],
  controllers: [UsersController, OrdersController],
  providers: [UsersService, OrdersService],
})
export class AppModule {}
