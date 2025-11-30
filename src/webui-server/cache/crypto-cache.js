import axios from 'axios';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

// Crypto price cache
const CACHE_TTL = 60 * 1000; // 60 seconds

let cryptoPriceCache = {
  data: null,
  timestamp: null,
};

function isCacheValid() {
  if (!cryptoPriceCache.data || !cryptoPriceCache.timestamp) {
    return false;
  }
  return Date.now() - cryptoPriceCache.timestamp < CACHE_TTL;
}

async function fetchCryptoPricesFromAPI() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { timeout: 5000 }
    );
    const data = response.data;
    return {
      bitcoin: data.bitcoin?.usd || null,
      ethereum: data.ethereum?.usd || null,
    };
  } catch (error) {
    logger.error('Failed to fetch crypto prices from CoinGecko:', error);
    throw error;
  }
}

export async function getCryptoPrices() {
  try {
    if (isCacheValid()) {
      logger.debug('Returning cached crypto prices');
      return cryptoPriceCache.data;
    }

    logger.debug('Fetching crypto prices from CoinGecko');
    const prices = await fetchCryptoPricesFromAPI();
    cryptoPriceCache.data = prices;
    cryptoPriceCache.timestamp = Date.now();
    return prices;
  } catch (error) {
    logger.error('Failed to fetch crypto prices:', error);
    // Return cached data if available, even if expired
    if (cryptoPriceCache.data) {
      logger.debug('Returning stale cached data due to API error');
      return cryptoPriceCache.data;
    }
    // Return null values instead of throwing to prevent UI breakage
    logger.debug('No cached data available, returning null values');
    return {
      bitcoin: null,
      ethereum: null,
    };
  }
}
