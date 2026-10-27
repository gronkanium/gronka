// For requests made without a login, or with a hand-exported cookie.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// Must match the browser that keeps the Instagram and X sessions logged in, or one session shows as two devices.
export const SESSION_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
export const SESSION_SEC_CH_UA = '"Chromium";v="153", "Not_A Brand";v="8"';
