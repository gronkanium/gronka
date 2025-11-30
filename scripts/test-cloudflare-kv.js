import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(projectRoot, '.env') });

// Configuration
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const CLOUDFLARE_PAGES_PROJECT_NAME = process.env.CLOUDFLARE_PAGES_PROJECT_NAME;

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const KV_KEY = 'stats:24h';

/**
 * Get Cloudflare API headers
 */
function getApiHeaders() {
  return {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Test KV read access
 */
async function testKVRead() {
  console.log('Testing KV read access...');
  try {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${KV_KEY}`;
    const response = await axios.get(url, {
      headers: getApiHeaders(),
      timeout: 10000,
    });

    if (response.status === 200) {
      console.log('✅ KV read successful');
      if (response.data) {
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        console.log('   Data found in KV:');
        console.log(`   - Unique users: ${data.data?.unique_users || 'N/A'}`);
        console.log(`   - Total files: ${data.data?.total_files || 'N/A'}`);
        console.log(`   - Total data: ${data.data?.total_data_formatted || 'N/A'}`);
      }
      return true;
    }
    return false;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log('⚠️  KV key not found (this is okay if stats haven\'t been synced yet)');
      return true; // Not an error, just no data yet
    }
    console.error('❌ KV read failed:', error.message);
    if (error.response?.data) {
      console.error('   Error details:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

/**
 * Test KV write access
 */
async function testKVWrite() {
  console.log('\nTesting KV write access...');
  try {
    const testData = {
      success: true,
      data: {
        unique_users: 0,
        total_files: 0,
        total_data_bytes: 0,
        total_data_formatted: '0.00 MB',
        period: '24 hours',
      },
      updated_at: Date.now(),
      test: true,
    };

    const url = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${KV_KEY}`;
    const response = await axios.put(url, JSON.stringify(testData), {
      headers: getApiHeaders(),
      timeout: 10000,
    });

    if (response.status === 200 || response.status === 204) {
      console.log('✅ KV write successful');
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ KV write failed:', error.message);
    if (error.response?.data) {
      console.error('   Error details:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

/**
 * Test Pages project access
 */
async function testPagesAccess() {
  console.log('\nTesting Pages project access...');
  try {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT_NAME}`;
    const response = await axios.get(url, {
      headers: getApiHeaders(),
      timeout: 10000,
    });

    if (response.status === 200) {
      const project = response.data.result;
      console.log('✅ Pages project access successful');
      console.log(`   Project: ${project.name}`);
      console.log(`   Production branch: ${project.production_branch || 'N/A'}`);
      return true;
    }
    return false;
  } catch (error) {
    if (error.response?.status === 404) {
      console.error(`❌ Pages project "${CLOUDFLARE_PAGES_PROJECT_NAME}" not found`);
      console.error('   Check that CLOUDFLARE_PAGES_PROJECT_NAME matches your project name');
    } else {
      console.error('❌ Pages project access failed:', error.message);
      if (error.response?.data) {
        console.error('   Error details:', JSON.stringify(error.response.data, null, 2));
      }
    }
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Cloudflare KV and Pages Connection Test\n');
  console.log('Configuration:');
  console.log(`  Account ID: ${CLOUDFLARE_ACCOUNT_ID || 'NOT SET'}`);
  console.log(`  KV Namespace ID: ${CLOUDFLARE_KV_NAMESPACE_ID || 'NOT SET'}`);
  console.log(`  Pages Project: ${CLOUDFLARE_PAGES_PROJECT_NAME || 'NOT SET'}`);
  console.log(`  API Token: ${CLOUDFLARE_API_TOKEN ? 'SET' : 'NOT SET'}\n`);

  // Validate required vars
  const missing = [];
  if (!CLOUDFLARE_API_TOKEN) missing.push('CLOUDFLARE_API_TOKEN');
  if (!CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!CLOUDFLARE_KV_NAMESPACE_ID) missing.push('CLOUDFLARE_KV_NAMESPACE_ID');
  if (!CLOUDFLARE_PAGES_PROJECT_NAME) missing.push('CLOUDFLARE_PAGES_PROJECT_NAME');

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach((varName) => console.error(`   - ${varName}`));
    console.error('\nRun: npm run validate:cloudflare');
    process.exit(1);
  }

  // Run tests
  const results = {
    kvRead: await testKVRead(),
    kvWrite: await testKVWrite(),
    pages: await testPagesAccess(),
  };

  console.log('\n' + '='.repeat(50));
  console.log('Test Summary:');
  console.log(`  KV Read:  ${results.kvRead ? '✅' : '❌'}`);
  console.log(`  KV Write: ${results.kvWrite ? '✅' : '❌'}`);
  console.log(`  Pages:    ${results.pages ? '✅' : '❌'}`);
  console.log('='.repeat(50));

  const allPassed = Object.values(results).every((r) => r);
  if (allPassed) {
    console.log('\n✅ All tests passed! Your Cloudflare configuration is working.');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. Check the errors above.');
    console.log('\nTroubleshooting:');
    console.log('1. Verify API token has correct permissions (Workers KV Storage: Edit, Pages: Edit)');
    console.log('2. Verify KV namespace ID is correct');
    console.log('3. Verify Pages project name matches exactly');
    console.log('4. Check wiki/Cloudflare-Pages-Deployment.md for detailed setup instructions');
    process.exit(1);
  }
}

// Run tests
main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});

