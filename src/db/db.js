// Capa de datos: SQLite vía sql.js (WASM, sin compilación nativa).
// La base se guarda en data/inmo.sqlite después de cada escritura.
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.resolve(__dirname, '../../data/inmo.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('venta','alquiler')),
  type TEXT NOT NULL CHECK (type IN ('casa','departamento','local','terreno')),
  neighborhood TEXT NOT NULL,
  address TEXT,
  price_usd INTEGER NOT NULL,
  bedrooms INTEGER DEFAULT 0,
  bathrooms INTEGER DEFAULT 0,
  area_m2 INTEGER,
  amenities TEXT,
  description TEXT,
  available INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS leads (
  phone TEXT PRIMARY KEY,
  name TEXT,
  intent TEXT,
  budget_usd INTEGER,
  zone TEXT,
  property_type TEXT,
  bedrooms INTEGER,
  notes TEXT,
  status TEXT DEFAULT 'nuevo',
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT,
  property_code TEXT NOT NULL,
  datetime TEXT NOT NULL,
  status TEXT DEFAULT 'confirmada',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(property_code, datetime)
);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT,
  status TEXT DEFAULT 'pendiente',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

let db;

export async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(SCHEMA);
  persist();
  return db;
}

/** Acceso directo a la instancia sql.js (para transacciones). Llamar getDb() antes. */
export function getRawDb() {
  if (!db) throw new Error('DB no inicializada: llamá await getDb() primero');
  return db;
}

export function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

/** Ejecuta un SELECT y devuelve un array de objetos. */
export function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = {}) {
  return all(sql, params)[0] || null;
}

/** Ejecuta un INSERT/UPDATE/DELETE y persiste. */
export function run(sql, params = {}) {
  db.run(sql, params);
  persist();
}
