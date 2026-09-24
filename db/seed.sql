-- Optional demo data. Run after schema.sql, against the same database (see
-- schema.sql's own header for why neither file hardcodes a database name):
--   mysql -u root -p your_db_name < db/seed.sql
--
-- Prices are IQD, the platform's only currency (see saas_project/CLAUDE.md).
-- Dinars have no minor unit here, so every amount is a whole number. These were
-- USD until the db:convert-iqd migration; they are now seeded as dinars
-- directly, so `npm run db:bootstrap` records 'convert-prices-to-iqd' as
-- already applied — otherwise a fresh install that later runs the remaining
-- db:* scripts would multiply these by 1300 a second time.

INSERT INTO merchants (id, business_name, owner_name, email, phone, plan, status, branches, working_hours)
VALUES
  (1024, 'The Olive Branch', 'Layla Haddad', 'layla@olivebranch.com', '+964 770 123 4567', 'Enterprise', 'active', 8,
   JSON_ARRAY(
     JSON_OBJECT('day','Monday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Tuesday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Wednesday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Thursday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Friday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Saturday','open','09:00','close','22:00','closed',false),
     JSON_OBJECT('day','Sunday','open','09:00','close','22:00','closed',true)
   ));

INSERT INTO categories (id, merchant_id, name, position) VALUES
  (1, 1024, 'Appetizers', 0),
  (2, 1024, 'Main Courses', 1),
  (3, 1024, 'Beverages', 2);

INSERT INTO products (merchant_id, category_id, name, description, price) VALUES
  (1024, 1, 'Hummus', 'Creamy chickpea dip with olive oil and warm pita.', 5000),
  (1024, 1, 'Falafel (6 pcs)', 'Crispy herbed chickpea fritters with tahini sauce.', 6000),
  (1024, 2, 'Grilled Chicken Platter', 'Marinated chicken, rice, grilled vegetables and garlic sauce.', 15000),
  (1024, 2, 'Lamb Kofta', 'Char-grilled spiced lamb skewers with fresh salad.', 20000),
  (1024, 3, 'Fresh Orange Juice', 'Cold-pressed, no added sugar.', 3000);

INSERT INTO reviews (merchant_id, customer_name, rating, comment, created_at) VALUES
  (1024, 'Sarah Al-Amin', 5, 'Loved the grilled chicken platter — generous and hot.', '2026-07-11'),
  (1024, 'Noor Abdulkarim', 4, 'Great food and friendly service.', '2026-07-09'),
  (1024, 'Omar Hassan', 2, 'Order arrived cold. Taste was otherwise fine.', '2026-06-18');
