CREATE TABLE public.audit_log (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER,
  action TEXT NOT NULL,
  at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT audit_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
);
