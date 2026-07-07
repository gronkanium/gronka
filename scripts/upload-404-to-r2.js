import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { r2Config } from '../src/utils/config.js';
import { uploadToR2 } from '../src/utils/r2-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function upload404Cat() {
  try {
    console.log('Uploading 404 cat image to R2...');

    // Check if R2 config is set
    if (
      !r2Config.accountId ||
      !r2Config.accessKeyId ||
      !r2Config.secretAccessKey ||
      !r2Config.bucketName
    ) {
      console.error('Error: R2 credentials not configured in .env file');
      console.error(
        'Please set: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
      );
      process.exit(1);
    }

    // Read the 404 cat image
    const catImagePath = path.join(__dirname, '..', 'src', 'public', '404.jpg');
    let catImageBuffer;
    try {
      catImageBuffer = await fs.readFile(catImagePath);
    } catch (error) {
      console.error(`Error: Could not read 404 cat image at ${catImagePath}`);
      console.error(`Error details: ${error.message}`);
      process.exit(1);
    }

    console.log(`Found 404 cat image (${(catImageBuffer.length / 1024).toFixed(2)} KB)`);

    // Upload to R2 at root level (404.jpg)
    const publicUrl = await uploadToR2(catImageBuffer, '404.jpg', 'image/jpeg', r2Config);

    console.log('âœ“ Successfully uploaded 404 cat image to R2');
    console.log(`  URL: ${publicUrl}`);
    console.log('');
    console.log('Next steps:');
    console.log('1. Verify the image is accessible at the URL above');
    console.log('2. Ensure your R2 bucket is set to public access');
    console.log('3. Configure custom domain cdn.gronka.dev in Cloudflare R2 dashboard');
    console.log('4. Test by accessing: https://cdn.gronka.dev/404.jpg');
  } catch (error) {
    console.error('Error uploading 404 cat image to R2:', error.message);
    if (error.name === 'NotFound' || error.message.includes('404')) {
      console.error('Bucket not found. Please verify R2_BUCKET_NAME is correct.');
    } else if (error.message.includes('credentials') || error.message.includes('401')) {
      console.error('Authentication failed. Please verify your R2 credentials.');
    }
    process.exit(1);
  }
}

upload404Cat();
