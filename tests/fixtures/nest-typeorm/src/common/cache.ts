// Not a controller: a cache with Express-like and Nest-like names.
export class Cache {
  private store = new Map<string, unknown>();

  get(key: string) {
    return this.store.get(key);
  }
}

export const cache = new Cache();
cache.get("/users");
console.log("@Get('/in-a-log') this.usersRepository.save()");
