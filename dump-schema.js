require("dotenv").config();
const db = require("./data/db");
const fs = require("fs");

(async () => {
  let out = "";
  for (const t of ["users", "devices", "tariff_settings", "pairing_codes"]) {
    const [rows] = await db.query("SHOW CREATE TABLE `" + t + "`");
    out += rows[0]["Create Table"] + ";\n\n";
  }
  fs.writeFileSync("schema.sql", out);
  console.log("Wrote schema.sql");
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
