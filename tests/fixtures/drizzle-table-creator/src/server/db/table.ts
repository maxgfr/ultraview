import { pgTableCreator } from "drizzle-orm/pg-core";

const PREFIX = "board";

export const createTable = pgTableCreator((name) => `${PREFIX}_${name}`);
