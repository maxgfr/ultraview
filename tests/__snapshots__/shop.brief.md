# Shop

A small online store where customers browse products and place orders. [README.md:3]

## Systems

| System | Kind | Files | Lines | Summary |
|---|---|---|---|---|
| Main server | service | 4 | 81 | The web server that answers the shop's requests, with the order routes under /api. [src/server.ts:7] |
| Database | data | 2 | 57 | The shop's data model and the client the server reaches it with. [prisma/schema.prisma:36] [src/db.ts:3] |
| Unassigned | — | 3 | 30 | — |

## Capabilities

### Health check

Monitoring asks the server whether it is up and gets ok back. [src/server.ts:9-11]

- Used by: operator
- Systems: Main server
- Routes: `GET /health`
- Size: 18 lines; evidence: `src/server.ts:9-11`

### Following orders

Customers list their orders with their items, open one, or cancel it. [src/services/orders.ts:8-10] [src/routes/orders.ts:14-21]

- Used by: customer
- Systems: Main server
- Routes: `DELETE /api/orders/:id`, `GET /api/orders`, `GET /api/orders/:id`
- Size: 53 lines; evidence: `src/services/orders.ts:8-10`, `src/routes/orders.ts:14-21`

### Placing an order

A customer orders a list of products, and an order naming an unknown product is refused. [src/services/orders.ts:12-15] The order is stored with one line per product. [src/services/orders.ts:16-21]

- Used by: customer
- Systems: Main server, Database
- Routes: `POST /api/orders`
- Data: Order, OrderItem, Product
- Size: 107 lines; evidence: `src/services/orders.ts:12-15`, `src/services/orders.ts:16-21`

### Shared foundations

- Systems: Unassigned, Database
- Size: 33 lines

## Data

| Entity | Fields | Defined at |
|---|---|---|
| Order | id, user → User, userId, status, items → OrderItem, createdAt | `prisma/schema.prisma:36` |
| OrderItem | id, order → Order, orderId, product → Product, productId, quantity | `prisma/schema.prisma:47` |
| Product | id, sku, title, priceCents, items → OrderItem | `prisma/schema.prisma:27` |
| User | id, email, name, orders → Order, createdAt | `prisma/schema.prisma:19` |

## Flows

### What happens when someone places an order

1. **POST /api/orders**: The server mounts the order routes under /api. [src/server.ts:7] A POST to /api/orders answers 201 with the new order. [src/routes/orders.ts:10-12]
2. **placeOrder**: placeOrder first checks that every product exists. [src/services/orders.ts:14-15]
3. **Order**: The order and its items are written in one create call. [src/services/orders.ts:16-21]

## Insights

- **medium** Import cycle: src → src/routes → src/services → src: 3 modules import each other in a loop (src → src/routes → src/services → src): none of them can change or be tested alone.

_Coverage: 100.0% of code files in systems, 100.0% of modules in capabilities._
