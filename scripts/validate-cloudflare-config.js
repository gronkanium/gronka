import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(projectRoot, '.env') });

// Required Cloudflare environment variables
const REQUIRED_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_KV_NAMESPACE_ID',
  'CLOUDFLARE_PAGES_PROJECT_NAME',
];

/**
 * Validate Cloudflare configuration
 */
function validateConfig() {
  console.log('Validating Cloudflare KV and Pages configuration...\n');

  const missing = [];
  const present = [];

  for (const varName of REQUIRED_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    } else {
      present.push(varName);
      // Mask sensitive values
      const displayValue =
        varName === 'CLOUDFLARE_API_TOKEN'
          ? `${value.substring(0, 10)}...${value.substring(value.length - 4)}`
          : value;
      console.log(`✓ ${varName}: ${displayValue}`);
    }
  }

  console.log('');

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    console.error('');
    console.error('Please add these to your .env file:');
    console.error('');
    missing.forEach(varName => {
      console.error(`${varName}=your_value_here`);
    });
    console.error('');
    console.error('See wiki/Cloudflare-Pages-Deployment.md for instructions.');
    process.exit(1);
  }

  console.log('✅ All required Cloudflare environment variables are set!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Ensure KV namespace is bound to your Pages project');
  console.log('2. Ensure Pages environment variables are configured');
  console.log('3. Ensure Pages build command includes: npm run kv:fetch-stats');
  console.log('4. Test the setup: npm run kv:sync-stats');
  console.log('5. Test fetch: npm run kv:fetch-stats');
  process.exit(0);
}

// Run validation
validateConfig();
