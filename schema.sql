CREATE TABLE "users" (
  "id" int NOT NULL AUTO_INCREMENT,
  "email" varchar(255) NOT NULL,
  "password_hash" varchar(255) NOT NULL,
  "mac" varchar(17) DEFAULT NULL,
  "full_name" varchar(100) DEFAULT NULL,
  "created_at" timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE KEY "email" ("email"),
  UNIQUE KEY "mac" ("mac")
);

CREATE TABLE "devices" (
  "id" int NOT NULL AUTO_INCREMENT,
  "user_id" int NOT NULL,
  "mac" varchar(17) NOT NULL,
  "api_key" varchar(64) NOT NULL,
  "status" varchar(10) DEFAULT 'offline',
  "last_seen" timestamp NULL DEFAULT NULL,
  PRIMARY KEY ("id"),
  UNIQUE KEY "mac" ("mac"),
  UNIQUE KEY "api_key" ("api_key"),
  KEY "user_id" ("user_id"),
  CONSTRAINT "devices_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE TABLE "tariff_settings" (
  "user_id" int NOT NULL,
  "rate_per_kwh" decimal(8,2) NOT NULL DEFAULT '12.00',
  "currency" varchar(8) NOT NULL DEFAULT 'PHP',
  PRIMARY KEY ("user_id"),
  CONSTRAINT "tariff_settings_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE TABLE "pairing_codes" (
  "id" int NOT NULL AUTO_INCREMENT,
  "user_id" int NOT NULL,
  "code" char(6) NOT NULL,
  "expires_at" datetime NOT NULL,
  "used_at" datetime DEFAULT NULL,
  "created_at" timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  UNIQUE KEY "uq_pc_user" ("user_id"),
  UNIQUE KEY "uq_pc_code" ("code"),
  CONSTRAINT "fk_pc_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

