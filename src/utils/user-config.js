import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const CONFIGS_DIR = path.join(projectRoot, 'data', 'configs');

/**
 * Get default user config values
 * @returns {Object} Default user config
 */
function getDefaultUserConfig() {
  return {
    fps: null,
    width: null,
    quality: null,
    autoOptimize: false,
  };
}

/**
 * Ensure configs directory exists
 * @returns {Promise<void>}
 */
async function ensureConfigsDir() {
  try {
    await fs.mkdir(CONFIGS_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore error
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Get user config file path
 * @param {string} userId - Discord user ID
 * @returns {string} Path to user config file
 */
function getUserConfigPath(userId) {
  return path.join(CONFIGS_DIR, `${userId}.json`);
}

/**
 * Load user config from file
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object>} User config object
 */
export async function getUserConfig(userId) {
  await ensureConfigsDir();
  const configPath = getUserConfigPath(userId);

  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data);
    // Merge with defaults to ensure all keys exist
    return { ...getDefaultUserConfig(), ...config };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, return defaults
      return getDefaultUserConfig();
    }
    // Other errors (parse errors, etc.) - log and return defaults
    console.error(`Error loading user config for ${userId}:`, error.message);
    return getDefaultUserConfig();
  }
}

/**
 * Validate fps value for admin vs non-admin users
 * @param {number} fps - FPS value to validate
 * @param {boolean} isAdmin - Whether user is admin
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateFps(fps, isAdmin) {
  if (typeof fps !== 'number' || isNaN(fps) || !isFinite(fps)) {
    return { valid: false, error: 'fps must be a valid number' };
  }

  if (fps < 0.1 || fps > 120) {
    return { valid: false, error: 'fps must be between 0.1 and 120' };
  }

  const maxFps = isAdmin ? 30 : 15;
  if (fps > maxFps) {
    return {
      valid: false,
      error: `fps cannot exceed ${maxFps} for ${isAdmin ? 'admins' : 'non-admin users'}`,
    };
  }

  return { valid: true };
}

/**
 * Validate width value
 * @param {number} width - Width value to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateWidth(width) {
  if (typeof width !== 'number' || isNaN(width) || !isFinite(width)) {
    return { valid: false, error: 'width must be a valid number' };
  }

  if (width < 1 || width > 4096) {
    return { valid: false, error: 'width must be between 1 and 4096' };
  }

  return { valid: true };
}

/**
 * Validate quality value
 * @param {string} quality - Quality value to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateQuality(quality) {
  const validQualities = ['low', 'medium', 'high'];
  if (!validQualities.includes(quality)) {
    return {
      valid: false,
      error: `quality must be one of: ${validQualities.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Validate autoOptimize value
 * @param {boolean} autoOptimize - AutoOptimize value to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateAutoOptimize(autoOptimize) {
  if (typeof autoOptimize !== 'boolean') {
    return { valid: false, error: 'autoOptimize must be true or false' };
  }

  return { valid: true };
}

/**
 * Update user config with new values
 * @param {string} userId - Discord user ID
 * @param {Object} updates - Config values to update
 * @param {boolean} isAdmin - Whether user is admin (for validation)
 * @returns {Promise<{success: boolean, error?: string, config?: Object}>} Update result
 */
export async function setUserConfig(userId, updates, isAdmin = false) {
  await ensureConfigsDir();

  // Load existing config
  const existingConfig = await getUserConfig(userId);
  const newConfig = { ...existingConfig };

  // Validate and apply updates
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      // Setting to null/undefined resets to default
      newConfig[key] = null;
      continue;
    }

    switch (key) {
      case 'fps': {
        const fpsValidation = validateFps(value, isAdmin);
        if (!fpsValidation.valid) {
          return { success: false, error: fpsValidation.error };
        }
        newConfig[key] = value;
        break;
      }

      case 'width': {
        const widthValidation = validateWidth(value);
        if (!widthValidation.valid) {
          return { success: false, error: widthValidation.error };
        }
        newConfig[key] = value;
        break;
      }

      case 'quality': {
        const qualityValidation = validateQuality(value);
        if (!qualityValidation.valid) {
          return { success: false, error: qualityValidation.error };
        }
        newConfig[key] = value;
        break;
      }

      case 'autoOptimize': {
        const autoOptimizeValidation = validateAutoOptimize(value);
        if (!autoOptimizeValidation.valid) {
          return { success: false, error: autoOptimizeValidation.error };
        }
        newConfig[key] = value;
        break;
      }

      default:
        return { success: false, error: `unknown config key: ${key}` };
    }
  }

  // Save updated config
  const configPath = getUserConfigPath(userId);
  try {
    await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
    return { success: true, config: newConfig };
  } catch (error) {
    return { success: false, error: `failed to save config: ${error.message}` };
  }
}
