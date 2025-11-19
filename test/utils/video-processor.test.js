import { test } from 'node:test';
import assert from 'node:assert';
import { convertToGif } from '../../src/utils/video-processor.js';
import fs from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testTempPath = path.join(__dirname, '../../temp/test-video-processor');

// Setup test temp directory
test.before(() => {
  try {
    mkdirSync(testTempPath, { recursive: true });
  } catch {
    // Directory might already exist
  }
});

test.after(() => {
  try {
    rmSync(testTempPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// Helper to create a dummy video file for testing
function createDummyVideoFile(filename) {
  const filePath = path.join(testTempPath, filename);
  // Create a minimal video file header (not a real video, but enough for file existence checks)
  const dummyContent = Buffer.from('dummy video content');
  writeFileSync(filePath, dummyContent);
  return filePath;
}

test('convertToGif - validates width parameter', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test width too small
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { width: 0 }),
    {
      message: /width must be at least 1/
    }
  );
  
  // Test width too large
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { width: 5000 }),
    {
      message: /width must be at most 4096/
    }
  );
  
  // Test invalid width (NaN)
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { width: 'invalid' }),
    {
      message: /width must be a valid number/
    }
  );
  
  // Test valid width at boundaries
  // Note: These will fail due to FFmpeg not being available in CI, but we test the validation
  try {
    await convertToGif(inputPath, outputPath, { width: 1 });
  } catch (error) {
    // Should fail with FFmpeg error or file not found, not validation error
    assert(!error.message.includes('width'));
  }
  
  try {
    await convertToGif(inputPath, outputPath, { width: 4096 });
  } catch (error) {
    // Should fail with FFmpeg error or file not found, not validation error
    assert(!error.message.includes('width'));
  }
});

test('convertToGif - validates fps parameter', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test fps too small
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { fps: 0 }),
    {
      message: /fps must be at least 0.1/
    }
  );
  
  // Test fps too large
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { fps: 200 }),
    {
      message: /fps must be at most 120/
    }
  );
  
  // Test invalid fps (NaN)
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { fps: 'invalid' }),
    {
      message: /fps must be a valid number/
    }
  );
  
  // Test negative fps
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { fps: -1 }),
    {
      message: /fps must be at least 0.1/
    }
  );
});

test('convertToGif - validates startTime parameter', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test negative startTime
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { startTime: -1 }),
    {
      message: /startTime must be at least 0/
    }
  );
  
  // Test null startTime (should be allowed)
  try {
    await convertToGif(inputPath, outputPath, { startTime: null });
  } catch (error) {
    // Should fail with FFmpeg error, not validation error
    assert(!error.message.includes('startTime'));
  }
  
  // Test undefined startTime (should default to null)
  try {
    await convertToGif(inputPath, outputPath, { startTime: undefined });
  } catch (error) {
    // Should fail with FFmpeg error, not validation error
    assert(!error.message.includes('startTime'));
  }
});

test('convertToGif - validates duration parameter', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test duration too small
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { duration: 0 }),
    {
      message: /duration must be at least 0.1/
    }
  );
  
  // Test negative duration
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { duration: -1 }),
    {
      message: /duration must be at least 0.1/
    }
  );
  
  // Test null duration (should be allowed)
  try {
    await convertToGif(inputPath, outputPath, { duration: null });
  } catch (error) {
    // Should fail with FFmpeg error, not validation error
    assert(!error.message.includes('duration'));
  }
});

test('convertToGif - validates quality parameter', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test invalid quality
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { quality: 'invalid' }),
    {
      message: /quality must be one of: low, medium, high/
    }
  );
  
  // Test valid quality values
  for (const quality of ['low', 'medium', 'high']) {
    try {
      await convertToGif(inputPath, outputPath, { quality });
    } catch (error) {
      // Should fail with FFmpeg error, not validation error
      assert(!error.message.includes('quality must be one of'));
    }
  }
});

test('convertToGif - uses default values', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Test with empty options (should use defaults)
  try {
    await convertToGif(inputPath, outputPath, {});
  } catch (error) {
    // Should fail with FFmpeg error or file not found, not validation error
    assert(!error.message.includes('must be'));
  }
});

test('convertToGif - validates input file exists', async () => {
  const nonExistentPath = path.join(testTempPath, 'nonexistent.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  await assert.rejects(
    async () => await convertToGif(nonExistentPath, outputPath),
    {
      message: /Input video file not found/
    }
  );
});

test('convertToGif - handles string numbers for numeric parameters', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // String numbers should be converted (test will fail on FFmpeg, not validation)
  try {
    await convertToGif(inputPath, outputPath, { width: '480', fps: '15' });
  } catch (error) {
    // Should fail with FFmpeg error, not validation error
    assert(!error.message.includes('must be a valid number'));
  }
});

test('convertToGif - handles Infinity values', async () => {
  const inputPath = createDummyVideoFile('test.mp4');
  const outputPath = path.join(testTempPath, 'output.gif');
  
  // Infinity should be rejected for width and fps
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { width: Infinity }),
    {
      message: /must be a valid number/
    }
  );
  
  await assert.rejects(
    async () => await convertToGif(inputPath, outputPath, { fps: Infinity }),
    {
      message: /must be a valid number/
    }
  );
});

