import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  findOne(id: number): Promise<User | null> {
    return this.usersRepository.findOneBy({ id });
  }

  create(email: string): Promise<User> {
    const user = this.usersRepository.create({ email });
    return this.usersRepository.save(user);
  }

  async remove(id: number): Promise<void> {
    // await this.usersRepository.clear();
    await this.usersRepository.delete(id);
  }
}
