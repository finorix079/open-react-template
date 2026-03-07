import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

const connectionString = process.env.NEXT_DB_CONNECTION_STRING;
const sslKeyPath = path.join(process.cwd(), '.temp', 'InitialKey.pem');

export async function runSelectQuery(query: string): Promise<any> {
  const startedAt = Date.now();
  console.log('[dataService] Running SQL query:', query);
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.');
  }

  if (!connectionString) {
    throw new Error('Database connection string is missing.');
  }

  console.log('[dataService] Database connection string found, initializing client');
  let sslConfig = undefined;
  if (fs.existsSync(sslKeyPath)) {
    sslConfig = {
      rejectUnauthorized: false,
      key: fs.readFileSync(sslKeyPath)
    };
    console.log('[dataService] SSL configuration loaded from', sslKeyPath);
  }

  const client = new Client({
    connectionString,
    ssl: sslConfig,
    // Add query timeout (ms) to avoid silent hangs; adjust as needed
    query_timeout: 60000,
  });

  console.log('[dataService] PostgreSQL client initialized, connecting to database');

  try {
    await client.connect();
    console.log('[dataService] Connected. Executing query...');
    const res = await client.query(query);
    const durationMs = Date.now() - startedAt;
    console.log(`[dataService] Query succeeded in ${durationMs}ms, rows=${res.rowCount}`);
    return res.rows;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error('[dataService] Query failed', {
      durationMs,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      code: (err as any)?.code,
      detail: (err as any)?.detail,
      hint: (err as any)?.hint,
    });
    throw err;
  } finally {
    try {
      await client.end();
      const durationMs = Date.now() - startedAt;
      console.log(`[dataService] Client closed. Total elapsed ${durationMs}ms`);
    } catch (closeErr) {
      console.error('[dataService] Error closing client', closeErr);
    }
  }
}
