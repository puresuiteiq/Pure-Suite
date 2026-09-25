-- Restaurant SaaS — initial database schema
-- Creates tables in whatever database the connection already has selected —
-- it does NOT create or USE a database of its own, so it works both against
-- a freely-creatable local database and a managed host's single fixed
-- database (Railway, PlanetScale, etc., where you can't create another one).
-- `npm run db:init` (scripts/initDb.js) is what selects the right database
-- (from DB_NAME) before applying this file — run this file directly with
-- `mysql -u root -p your_db_name < db/schema.sql` if not using that script.

-- ---------------------------------------------------------------------------
-- merchants — one row per restaurant tenant. Backs both the Super Admin
-- merchant list and the Merchant Admin profile (name/logo/hours/phone).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchants (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_name VARCHAR(150)    NOT NULL,
  -- Readable storefront URL segment: /r/<slug> instead of /r/<id>. Generated
  -- from business_name on create and editable by the Super Admin. The API
  -- adds this column and backfills it at boot (src/db/ensureSchema.js) on any
  -- database that predates it, so NULL should only ever be momentary —
  -- /r/<id> resolves either way, so printed QR codes never break.
  slug          VARCHAR(80)     NULL,
  -- Business category (a predefined key like 'electronics' or a custom name the
  -- Super Admin types). The app derives a behaviour mode from it — food
  -- categories act as a restaurant (menu), everything else as a store (catalog
  -- + inventory). Free text so new categories need no migration.
  business_type VARCHAR(60)     NOT NULL DEFAULT 'restaurant',
  owner_name    VARCHAR(150)    NULL,
  email         VARCHAR(190)    NULL,
  password_hash VARCHAR(255)    NULL,           -- bcrypt hash for merchant login
  phone         VARCHAR(40)     NULL,
  address       VARCHAR(255)    NULL,           -- basic info: street address
  description   TEXT            NULL,           -- basic info: short about/bio
  -- Plan name, referencing plans.name (VARCHAR(80)) — NOT an enum. The Super
  -- Admin designs plans in the UI, so any name must be assignable here; an
  -- ENUM would reject every plan beyond the three originally seeded ones.
  plan          VARCHAR(80)     NOT NULL DEFAULT 'Starter',
  status        ENUM('active','trial','suspended')     NOT NULL DEFAULT 'trial',
  -- When the subscription runs out. Admin-set + renewable; NULL = untracked.
  -- Drives the "expires in a week" reminder in the admin notifications.
  subscription_expires_at DATE  NULL,
  -- When the current subscription cycle began. Purely admin-set/informational
  -- (renew only ever advances subscription_expires_at); NULL = not set.
  subscription_starts_at  DATE  NULL,
  is_open       BOOLEAN         NOT NULL DEFAULT TRUE, -- merchant-controlled daily availability
  reviews_enabled BOOLEAN       NOT NULL DEFAULT TRUE, -- merchant can turn the customer rating system off
  show_banner   BOOLEAN         NOT NULL DEFAULT TRUE, -- merchant can hide the storefront's top banner entirely
  -- Storefront welcome screen shown before the menu (logo, name, tagline and
  -- an "enter" button over a picture or video). Off until the merchant turns
  -- it on; its background lives in merchant_splash_media.
  splash_enabled BOOLEAN        NOT NULL DEFAULT FALSE,
  splash_tagline VARCHAR(160)   NULL,
  -- Storefront brand colours the merchant picks (hex). Drive the accent on the
  -- public menu's buttons/prices. NULL = not set → the storefront uses its
  -- green default, so existing merchants are unchanged.
  accent_color  VARCHAR(9)      NULL,
  accent_shadow VARCHAR(9)      NULL,
  -- Admin-panel brand colours (hex). Drive the merchant dashboard's own buttons
  -- (Save, Add, Download, …), separate from the storefront accent above. NULL =
  -- not set → the panel uses its default amber.
  panel_color   VARCHAR(9)      NULL,
  panel_shadow  VARCHAR(9)      NULL,
  -- Public storefront canvas colours (hex). Separate from button accents.
  -- The "_light" pair is the original storefront_background columns, kept
  -- unrenamed so existing data isn't migrated; "_dark" is the equivalent for
  -- dark mode, NULL meaning "use the platform's own near-black default".
  storefront_background        VARCHAR(9) NULL,
  storefront_background_shadow VARCHAR(9) NULL,
  storefront_background_dark        VARCHAR(9) NULL,
  storefront_background_shadow_dark VARCHAR(9) NULL,
  -- Price text colour on the public storefront (hex), independent of
  -- accent_color — a merchant may want prices to stand out in a colour
  -- distinct from their buttons/accents. NULL = not set → the storefront
  -- falls back to accent_color, so existing merchants are unchanged.
  price_color   VARCHAR(9)      NULL,
  -- Exact map location, set by the merchant via a draggable-pin picker.
  -- NULL = not set → the public storefront's address chip has nothing to
  -- link to, so it renders as plain (non-clickable) text.
  latitude      DECIMAL(10,7)   NULL,
  longitude     DECIMAL(10,7)   NULL,
  logo          MEDIUMTEXT      NULL,           -- data URL or CDN URL
  branches      INT UNSIGNED    NOT NULL DEFAULT 1,
  working_hours JSON            NULL,           -- [{day,open,close,closed}, ...]
  -- Order service methods the merchant offers + delivery zones/fees, e.g.
  -- {"delivery":{"enabled":true,"zones":[{"name":"Center","fee":2000}]},
  --  "dinein":{"enabled":true},"pickup":{"enabled":true}}. NULL = not
  -- configured → the storefront checkout stays as-is (no method picker/fee).
  service_methods JSON          NULL,
  -- Optional social accounts shown as icons on the public storefront.
  -- {"instagram":"…","whatsapp":"…","snapchat":"…","facebook":"…","tiktok":"…"}
  social_links   JSON           NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchants_email (email),
  UNIQUE KEY uq_merchants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- categories — menu sections belonging to a merchant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120)    NOT NULL,
  name_i18n   JSON            NULL,               -- see products.name_i18n
  position    INT UNSIGNED    NOT NULL DEFAULT 0,  -- display order
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_categories_merchant (merchant_id),
  CONSTRAINT fk_categories_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- products — menu items/meals within a category.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id  BIGINT UNSIGNED NOT NULL,
  category_id  BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(150)    NOT NULL,
  -- Per-language overrides: {"en": "...", "ar": "...", "ku-badini": "..."}.
  -- `name`/`description` stay the required fallback (what the merchant typed
  -- first); a language missing here falls back to them, so a menu entered in
  -- one language keeps working everywhere. JSON rather than a column per
  -- language, matching `variants`/`working_hours` — a 4th language then costs
  -- no migration.
  name_i18n    JSON            NULL,
  description  TEXT            NULL,
  description_i18n JSON        NULL,
  price        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  -- Optional "was" price for a discount. When higher than `price`, the
  -- storefront strikes it through and shows the % off. NULL = no discount.
  original_price DECIMAL(10,2) NULL,
  -- Optional per-product option group (restaurants: "Size"; stores: "Storage",
  -- "Color", …). `variants` is a JSON array of { value, price } — the chosen
  -- value plus its own price. One dimension only (not a color×storage matrix).
  option_name  VARCHAR(60)     NULL,
  variants     JSON            NULL,
  -- Extra unpriced option groups the customer also picks (e.g. Size), so a
  -- product can offer Color (priced, above) AND Size together. JSON array of
  -- { name, values: [string] }. NULL = none.
  attributes   JSON            NULL,
  -- Optional suitable age range in years (e.g. a shirt for ages 15–40). Both
  -- NULL = not specified; the storefront shows a badge only when set.
  age_min      INT             NULL,
  age_max      INT             NULL,
  -- Retail fields, meaningful for stores, left NULL for restaurants:
  brand        VARCHAR(120)    NULL,           -- manufacturer (Apple, Samsung, …)
  stock        INT             NULL,           -- NULL = not tracked; >=0 tracked; 0 = out of stock
  images       JSON            NULL,           -- gallery: array of data/CDN URLs; `image` stays the cover
  image        MEDIUMTEXT      NULL,           -- cover image (= images[0]); data URL or CDN URL
  is_available TINYINT(1)      NOT NULL DEFAULT 1,
  -- Merchant-set per-item availability shown on the storefront: for sale,
  -- temporarily unavailable, or sold out. Applies to every item type.
  availability ENUM('available','unavailable','out_of_stock')
                               NOT NULL DEFAULT 'available',
  position     INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_merchant (merchant_id),
  KEY idx_products_category (category_id),
  CONSTRAINT fk_products_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- merchant_banners — pictures the merchant uploads for the storefront's top
-- carousel. With none, the storefront builds the carousel from the merchant's
-- product photos instead, as it always has. The API also creates this table at
-- boot (src/db/ensureSchema.js); keep the two definitions in step.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_banners (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  image       MEDIUMTEXT      NOT NULL,           -- data URL or CDN URL, like products.image
  title       VARCHAR(120)    NULL,               -- optional caption over the slide
  -- What tapping the slide does: nothing, open a product, or jump to a
  -- category. link_id is that product's or category's id; a target deleted
  -- since reads back as no link.
  link_type   ENUM('none','product','category') NOT NULL DEFAULT 'none',
  link_id     BIGINT UNSIGNED NULL,
  position    INT UNSIGNED    NOT NULL DEFAULT 0,  -- display order
  is_active   BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Versions the image URL (?v=). Edits that don't replace the image pin it
  -- (updated_at = updated_at) so customers keep their cached copy.
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_merchant_banners_merchant (merchant_id, position),
  CONSTRAINT fk_merchant_banners_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- merchant_splash_media — the picture or video behind a merchant's storefront
-- welcome screen, one per merchant. Raw bytes (not a data URL) because a video
-- is served to phones in byte ranges. Created at boot too
-- (src/db/ensureSchema.js); keep the two definitions in step.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_splash_media (
  merchant_id  BIGINT UNSIGNED NOT NULL,
  content_type VARCHAR(40)     NOT NULL,           -- sniffed from the bytes, never trusted from the upload
  byte_size    INT UNSIGNED    NOT NULL,
  data         LONGBLOB        NOT NULL,
  -- Versions the media URL (?v=), so it can be cached for a year.
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (merchant_id),
  CONSTRAINT fk_merchant_splash_media_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- reviews — customer feedback for a merchant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id   BIGINT UNSIGNED NOT NULL,
  customer_name VARCHAR(150)    NOT NULL,
  rating        TINYINT UNSIGNED NOT NULL,
  comment       TEXT            NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reviews_merchant (merchant_id),
  CONSTRAINT fk_reviews_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- orders — customer orders. Powers the Super Admin overview metrics
-- (Orders Today, Failed Payments, the 30-day trend chart).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  total       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  -- Per-merchant order number the customer and restaurant both reference
  -- (this restaurant's #1, #2, …), independent of the global `id`. Assigned
  -- transactionally in createOrder; NULL only for legacy rows pre-backfill.
  merchant_order_no BIGINT UNSIGNED NULL,
  -- Who placed it, captured at checkout so the merchant's order history shows
  -- the same customer details as the confirmation screen.
  customer_name  VARCHAR(150)   NULL,
  customer_phone VARCHAR(40)    NULL,
  -- How the customer wants the order fulfilled + the delivery fee applied.
  -- service_method: 'delivery' | 'dinein' | 'pickup'. delivery_zone/fee are the
  -- zone the customer picked and its fee (0 for non-delivery); table_number is
  -- for dine-in. All NULL for pre-migration / unconfigured orders.
  service_method VARCHAR(20)    NULL,
  delivery_zone  VARCHAR(120)   NULL,
  delivery_fee   DECIMAL(10,2)  NULL,
  table_number   VARCHAR(20)    NULL,
  status      ENUM('completed','pending','failed','cancelled')
                              NOT NULL DEFAULT 'completed',
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_orders_merchant (merchant_id),
  KEY idx_orders_created (created_at),
  KEY idx_orders_status (status),
  -- Enforces the sequence per merchant and makes concurrent inserts collide
  -- (and retry) rather than duplicate a number.
  UNIQUE KEY uq_orders_merchant_no (merchant_id, merchant_order_no),
  CONSTRAINT fk_orders_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- order_items — the specific products in an order. product_name and unit_price
-- are snapshots taken at order time, so history stays correct even if the
-- product is later renamed, repriced, or deleted. product_id is kept for
-- reference only (nullable, no hard FK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     BIGINT UNSIGNED NOT NULL,
  product_id   BIGINT UNSIGNED NULL,
  product_name VARCHAR(150)    NOT NULL,
  quantity     INT UNSIGNED    NOT NULL DEFAULT 1,
  unit_price   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- service_status — platform service health for the overview page.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_status (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name     VARCHAR(100)    NOT NULL,
  status   ENUM('operational','degraded','down') NOT NULL DEFAULT 'operational',
  uptime   DECIMAL(5,2)    NOT NULL DEFAULT 100.00,  -- percentage
  position INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- plans — subscription plans the Super Admin designs. merchants.plan references
-- a plan by its `name` (string), so renaming a plan cascades to its merchants.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  price       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,  -- IQD per billing period
  period_days INT UNSIGNED    NOT NULL DEFAULT 30,    -- billing period length
  description VARCHAR(255)    NULL,
  features    JSON            NULL,                   -- array of strings
  active      TINYINT(1)      NOT NULL DEFAULT 1,     -- assignable to new merchants
  position    INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- admins — platform operators (Super Admin). Separate from merchants; their
-- JWT carries role='admin' and gates the /api/merchants + /api/overview routes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(150)    NULL,
  email         VARCHAR(190)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  -- Super Admin's chosen dashboard button colours (hex). NULL = default amber.
  accent_color  VARCHAR(9)      NULL,
  accent_shadow VARCHAR(9)      NULL,
  -- Shared attribution below every public merchant storefront. Only a Super
  -- Admin can edit these fields; merchants never receive a write route for it.
  public_brand_logo       MEDIUMTEXT      NULL,
  public_powered_by_text  VARCHAR(80)     NULL,
  public_brand_name       VARCHAR(120)    NULL,
  -- Text colours for the two branding strings above (hex). NULL = default slate.
  public_powered_by_color VARCHAR(9)      NULL,
  public_brand_name_color VARCHAR(9)      NULL,
  -- WhatsApp number behind the "designed by" credit on storefront welcome
  -- screens. NULL = the credit shows without a contact button.
  public_contact_whatsapp VARCHAR(40)     NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_notification_states (
  admin_id   BIGINT UNSIGNED NOT NULL,
  event_id   VARCHAR(80)     NOT NULL,
  read_at    TIMESTAMP       NULL,
  deleted_at TIMESTAMP       NULL,
  PRIMARY KEY (admin_id, event_id),
  CONSTRAINT fk_notification_states_admin
    FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-merchant read/dismiss state for the merchant notifications feed (the
-- notifications themselves are computed on the fly from the merchant's own
-- orders / reviews / subscription expiry).
CREATE TABLE IF NOT EXISTS merchant_notification_states (
  merchant_id BIGINT UNSIGNED NOT NULL,
  event_id    VARCHAR(80)     NOT NULL,
  read_at     TIMESTAMP       NULL,
  deleted_at  TIMESTAMP       NULL,
  PRIMARY KEY (merchant_id, event_id),
  CONSTRAINT fk_merchant_notif_states_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- password_resets — short-lived, single-use tokens for merchant "forgot
-- password". Only the SHA-256 hash of the token is stored, so a DB leak can't
-- be used to reset accounts. Rows are deleted when consumed or superseded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64)        NOT NULL,        -- sha256 hex of the reset token
  expires_at  TIMESTAMP       NOT NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token (token_hash),
  KEY idx_password_resets_merchant (merchant_id),
  CONSTRAINT fk_password_resets_merchant
    FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
