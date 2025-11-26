<script>
  import { onMount, tick } from 'svelte';
  import { fetchHealth, formatUptime, fetchCryptoPrices, formatPrice } from '../utils/api.js';

  let health = null;
  let loading = true;
  let error = null;
  let bitcoinPrice = null;
  let ethereumPrice = null;
  let bitcoinPriceKey = 0;
  let ethereumPriceKey = 0;
  let bitcoinAnimating = false;
  let ethereumAnimating = false;

  async function loadHealth() {
    loading = true;
    error = null;
    try {
      health = await fetchHealth();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function loadPrices() {
    try {
      const prices = await fetchCryptoPrices();
      if (prices.bitcoin !== null && prices.bitcoin !== bitcoinPrice) {
        bitcoinAnimating = false;
        await tick();
        bitcoinPriceKey += 1;
        bitcoinPrice = prices.bitcoin;
        await tick();
        bitcoinAnimating = true;
        setTimeout(() => {
          bitcoinAnimating = false;
        }, 300);
      }
      if (prices.ethereum !== null && prices.ethereum !== ethereumPrice) {
        ethereumAnimating = false;
        await tick();
        ethereumPriceKey += 1;
        ethereumPrice = prices.ethereum;
        await tick();
        ethereumAnimating = true;
        setTimeout(() => {
          ethereumAnimating = false;
        }, 300);
      }
    } catch (err) {
      console.error('Failed to load crypto prices:', err);
    }
  }

  onMount(() => {
    loadHealth();
    loadPrices();
    const healthInterval = setInterval(loadHealth, 10000);
    const priceInterval = setInterval(loadPrices, 15000);
    return () => {
      clearInterval(healthInterval);
      clearInterval(priceInterval);
    };
  });
</script>

<section class="health">
  <h2>Health Status</h2>
  {#if loading && !health}
    <div class="loading">Loading...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
    <button on:click={loadHealth}>Retry</button>
  {:else if health}
    <dl>
      <div class="stat-item">
        <dt>Status</dt>
        <dd class="status">
          {#if health.status === 'ok'}
            <span class="status-ok">OK</span> <span class="status-code">200</span>
          {:else}
            {health.status || 'unknown'}
          {/if}
        </dd>
      </div>
      <div class="stat-item">
        <dt>Uptime</dt>
        <dd>{formatUptime(health.uptime || 0)}</dd>
      </div>
      <div class="stat-item">
        <dt>
          <svg class="crypto-icon" viewBox="0 0 4091.27 4091.73" xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd" clip-rule="evenodd">
            <path fill="#F7931A" fill-rule="nonzero" d="M4030.06 2540.77c-273.24,1096.01 -1383.32,1763.02 -2479.46,1489.71 -1095.68,-273.24 -1762.69,-1383.39 -1489.33,-2479.31 273.12,-1096.13 1383.2,-1763.19 2479,-1489.95 1096.06,273.24 1763.03,1383.51 1489.76,2479.57l0.02 -0.02z"/>
            <path fill="white" fill-rule="nonzero" d="M2947.77 1754.38c40.72,-272.26 -166.56,-418.61 -450,-516.24l91.95 -368.8 -224.5 -55.94 -89.51 359.09c-59.02,-14.72 -119.63,-28.59 -179.87,-42.34l90.16 -361.46 -224.36 -55.94 -92 368.68c-48.84,-11.12 -96.81,-22.11 -143.35,-33.69l0.26 -1.16 -309.59 -77.31 -59.72 239.78c0,0 166.56,38.18 163.05,40.53 90.91,22.69 107.35,82.87 104.62,130.57l-104.74 420.15c6.26,1.59 14.38,3.89 23.34,7.49 -7.49,-1.86 -15.46,-3.89 -23.73,-5.87l-146.81 588.57c-11.11,27.62 -39.31,69.07 -102.87,53.33 2.25,3.26 -163.17,-40.72 -163.17,-40.72l-111.46 256.98 292.15 72.83c54.35,13.63 107.61,27.89 160.06,41.3l-92.9 373.03 224.24 55.94 92 -369.07c61.26,16.63 120.71,31.97 178.91,46.43l-91.69 367.33 224.51 55.94 92.89 -372.33c382.82,72.45 670.67,43.24 791.83,-303.02 97.63,-278.78 -4.86,-439.58 -206.26,-544.44 146.69,-33.83 257.18,-130.31 286.64,-329.61l-0.07 -0.05zm-512.93 719.26c-69.38,278.78 -538.76,128.08 -690.94,90.29l123.28 -494.2c152.17,37.99 640.17,113.17 567.67,403.91zm69.43 -723.3c-63.29,253.58 -453.96,124.75 -580.69,93.16l111.77 -448.21c126.73,31.59 534.85,90.55 468.94,355.05l-0.02 0z"/>
          </svg>
          Bitcoin price
        </dt>
        <dd class="price-container">
          <span class="price-roll" class:animating={bitcoinAnimating}>{formatPrice(bitcoinPrice)}</span>
        </dd>
      </div>
      <div class="stat-item">
        <dt>
          <svg class="crypto-icon" viewBox="0 0 784.37 1277.39" xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd" clip-rule="evenodd">
            <polygon fill="#343434" fill-rule="nonzero" points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54 "/>
            <polygon fill="#8C8C8C" fill-rule="nonzero" points="392.07,0 -0,650.54 392.07,882.29 392.07,472.33 "/>
            <polygon fill="#3C3C3B" fill-rule="nonzero" points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89 "/>
            <polygon fill="#8C8C8C" fill-rule="nonzero" points="392.07,1277.38 392.07,956.52 -0,724.89 "/>
            <polygon fill="#141414" fill-rule="nonzero" points="392.07,882.29 784.13,650.54 392.07,472.33 "/>
            <polygon fill="#393939" fill-rule="nonzero" points="0,650.54 392.07,882.29 392.07,472.33 "/>
          </svg>
          Ethereum price
        </dt>
        <dd class="price-container">
          <span class="price-roll" class:animating={ethereumAnimating}>{formatPrice(ethereumPrice)}</span>
        </dd>
      </div>
    </dl>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
  }

  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
  }

  dl {
    margin: 0;
    padding: 0;
  }

  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.5rem 0;
    border-bottom: 1px solid #2a2a2a;
  }

  .stat-item:last-child {
    border-bottom: none;
  }

  dt {
    font-size: 0.9rem;
    color: #aaa;
    font-weight: 400;
  }

  dd {
    margin: 0;
    font-size: 1rem;
    color: #fff;
    font-weight: 500;
  }

  .status {
    text-transform: uppercase;
    font-size: 0.9rem;
  }

  .status-ok {
    color: #51cf66;
  }

  .status-code {
    color: #fff;
  }

  .crypto-icon {
    width: 16px;
    height: 16px;
    display: inline-block;
    vertical-align: middle;
    margin-right: 0.5rem;
    color: #fff;
  }

  .price-container {
    position: relative;
    overflow: hidden;
    height: 1.4em;
    padding-bottom: 0.2em;
  }

  .price-roll {
    display: inline-block;
  }

  .price-roll.animating {
    animation: rollDown 0.3s ease-out;
  }

  @keyframes rollDown {
    0% {
      transform: translateY(-90%);
      opacity: 0.3;
    }
    100% {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .loading {
    color: #888;
    padding: 1rem 0;
  }

  .error {
    color: #ff6b6b;
    padding: 1rem 0;
    margin-bottom: 1rem;
  }

  button {
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 3px;
  }

  button:hover {
    background-color: #555;
  }

  button:active {
    background-color: #333;
  }
  
  @media (max-width: 768px) {
    section {
      padding: 0.75rem;
    }
    
    h2 {
      font-size: 1rem;
    }
    
    .stat-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }
    
    dt {
      font-size: 0.85rem;
    }
    
    dd {
      font-size: 0.9rem;
    }
    
    .crypto-icon {
      width: 14px;
      height: 14px;
    }
    
    button {
      width: 100%;
      min-height: 44px;
    }
  }
</style>

