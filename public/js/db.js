require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const getSslConfig = () => {
  if (process.env.DB_CA_CERT) {
    return { ca: process.env.DB_CA_CERT };
  }
  
  const localCaPath = path.join(__dirname, '..', 'ca.pem');
  if (fs.existsSync(localCaPath)) {
    return { ca: fs.readFileSync(localCaPath) };
  }

  // Fallback for local testing if no cert is present
  return { rejectUnauthorized: false };
};

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 28359,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: getSslConfig(),
  waitForConnections: true,
  connectionLimit: 5
});

module.exports = pool;