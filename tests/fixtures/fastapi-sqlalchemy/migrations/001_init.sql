-- Initial schema.
-- CREATE TABLE ghost (id int);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'open',
  total NUMERIC(10, 2) NOT NULL
);

/* CREATE TABLE commented_out (id int); */
CREATE TEMPORARY TABLE scratch (id int);
