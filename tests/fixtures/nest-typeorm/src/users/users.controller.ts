import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post } from "@nestjs/common";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body("email") email: string) {
    return this.usersService.create(email);
  }

  // @Get('ghost')
  // ghost() {}

  @Delete(":id")
  async remove(@Param("id", ParseIntPipe) id: number) {
    await this.usersService.remove(id);
  }
}
