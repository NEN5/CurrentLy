// One-time migration: creates the phone_numbers, sms_queue and sim_inbox tables.
// Run from the project folder (next to .env):  node migrate-phones.js
// Safe to run again: it only creates tables that do not exist yet.
require("dotenv").config();
const db = require("./data/db");

const statements = [
  `CREATE TABLE IF NOT EXISTS phone_numbers (
    id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    phone VARCHAR(16) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    otp_hash CHAR(64) DEFAULT NULL,
    otp_expires_at DATETIME DEFAULT NULL,
    otp_tries TINYINT NOT NULL DEFAULT 0,
    otp_sent_at DATETIME DEFAULT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_phone_user (user_id, phone),
    CONSTRAINT fk_phone_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sms_queue (
    id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    phone_id INT NOT NULL,
    to_number VARCHAR(16) NOT NULL,
    body VARCHAR(200) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'queued',
    attempts TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_sms_user_status (user_id, status),
    CONSTRAINT fk_sms_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_sms_phone FOREIGN KEY (phone_id) REFERENCES phone_numbers (id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sim_inbox (
    id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    sender VARCHAR(40) NOT NULL,
    body VARCHAR(500) NOT NULL,
    sim_time VARCHAR(32) DEFAULT NULL,
    received_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_inbox_user (user_id, id),
    CONSTRAINT fk_inbox_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )`,
];

(async () => {
  for (const sql of statements) {
    await db.query(sql);
    console.log("OK:", sql.match(/EXISTS (\w+)/)[1]);
  }

  // tariff_settings.use_custom: 0 = use Meralco's current rate (default), 1 = the user's own rate.
  const [cols] = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tariff_settings' AND COLUMN_NAME = 'use_custom'",
  );
  if (Number(cols[0].n)) {
    console.log("OK: tariff_settings.use_custom already exists");
  } else {
    await db.query(
      "ALTER TABLE tariff_settings ADD COLUMN use_custom TINYINT NOT NULL DEFAULT 0",
    );
    // 12.00 was the old built-in default, so any other value was typed in by the user: keep it.
    const [r] = await db.query(
      "UPDATE tariff_settings SET use_custom = 1 WHERE rate_per_kwh <> 12.00",
    );
    console.log(
      "OK: tariff_settings.use_custom added (" +
        r.affectedRows +
        " existing custom rate(s) kept)",
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
