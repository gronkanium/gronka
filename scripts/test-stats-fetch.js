import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { get24HourStats } from '../src/utils/database/stats.js';
import { formatFileSize } from '../src/utils/storage.js';
import { ensurePostgresInitialized } from '../src/utils/database/init.js';
import { getPostgresConnection } from '../src/utils/database/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(projectRoot, '.env') });

// Map PROD_ prefixed environment variables to standard names
const envPrefix = 'PROD_';
const prefixMappings = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'DATABASE_URL',
];

console.log('='.repeat(60));
console.log('database connection and stats diagnostic tool');
console.log('='.repeat(60));

for (const key of prefixMappings) {
  const prefixedKey = `${envPrefix}${key}`;
  if (process.env[prefixedKey] !== undefined) {
    process.env[key] = process.env[prefixedKey];
  }
}

// Unset TEST_ variables to prevent isTestMode() from detecting test mode
// This ensures we connect to production database
for (const key of prefixMappings) {
  const testKey = `TEST_${key}`;
  if (process.env[testKey] !== undefined) {
    delete process.env[testKey];
  }
}

console.log('\n[environment configuration]');
console.log(`using environment prefix: ${envPrefix}`);
console.log(`postgres_host: ${process.env.POSTGRES_HOST || 'not set'}`);
console.log(`postgres_port: ${process.env.POSTGRES_PORT || 'not set'}`);
console.log(`postgres_db: ${process.env.POSTGRES_DB || 'not set'}`);
console.log(`postgres_user: ${process.env.POSTGRES_USER || 'not set'}`);
console.log(`postgres_password: ${process.env.POSTGRES_PASSWORD ? '***set***' : 'not set'}`);
console.log(`database_url: ${process.env.DATABASE_URL ? '***set***' : 'not set'}`);

async function main() {
  try {
    // Test database connection
    console.log('\n[1/3] testing database connection...');
    await ensurePostgresInitialized();
    const sql = getPostgresConnection();

    if (!sql) {
      throw new Error('failed to initialize postgres connection');
    }

    // Test basic query
    const testResult = await sql`SELECT 1 as test`;
    console.log('      ✓ database connection successful');
    console.log(`      test query result: ${testResult[0]?.test}`);

    // Check if processed_urls table exists and has data
    console.log('\n[2/3] checking processed_urls table...');
    const tableCheck = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'processed_urls'
      ) as exists
    `;

    if (!tableCheck[0]?.exists) {
      throw new Error('processed_urls table does not exist');
    }
    console.log('      ✓ processed_urls table exists');

    // Check row count
    const countResult = await sql`SELECT COUNT(*) as total FROM processed_urls`;
    const totalRows = parseInt(countResult[0]?.total || 0, 10);
    console.log(`      total rows in processed_urls: ${totalRows}`);

    if (totalRows === 0) {
      console.log('      ⚠ warning: table is empty, no data to fetch stats from');
    }

    // Check rows in last 24 hours
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const recentCountResult = await sql`
      SELECT COUNT(*) as count FROM processed_urls 
      WHERE processed_at >= ${twentyFourHoursAgo}
    `;
    const recentRows = parseInt(recentCountResult[0]?.count || 0, 10);
    console.log(`      rows in last 24 hours: ${recentRows}`);

    if (recentRows === 0) {
      console.log('      ⚠ warning: no data in last 24 hours, stats will be zero');
    }

    // Fetch 24-hour stats
    console.log('\n[3/3] fetching 24-hour stats...');
    const stats = await get24HourStats();

    if (!stats) {
      throw new Error('get24HourStats() returned null');
    }

    console.log('      ✓ stats fetched successfully');
    console.log(`      unique users: ${stats.unique_users}`);
    console.log(`      total files: ${stats.total_files}`);
    console.log(
      `      total data: ${formatFileSize(stats.total_data_bytes)} (${stats.total_data_bytes} bytes)`
    );
    console.log(`      timestamp: ${new Date(stats.timestamp).toISOString()}`);

    // Summary
    console.log('\n' + '='.repeat(60));
    if (stats.total_files === 0) {
      console.log('status: no data in last 24 hours (stats are zero)');
      console.log('this is expected if no files were processed recently');
    } else {
      console.log('status: all checks passed, stats are available');
    }
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('error:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nstack trace:');
      console.error(error.stack);
    }
    console.error('='.repeat(60));
    process.exit(1);
  }
}

main();
