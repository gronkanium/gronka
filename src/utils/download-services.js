import { readSetting } from './settings.js';
import { hostOf, hostUnder } from './url-host.js';
import { canonicalizeMirrorUrl } from './cobalt.js';
import { ROUTES } from '../core/sources.js';
import { SITES } from '../core/sites.js';

// The on/off switches for every source, so the webui can list them and each can be turned off.
// Routing lives in core/sources.js; a switch only says whether its hosts may be downloaded.
export const DOWNLOAD_SERVICES = [
  ...SITES.map(({ id, name, label, category, hosts }) => ({
    id,
    label: label ?? name,
    category,
    hosts,
  })),
  ...ROUTES.flatMap(route => route.services ?? []),
];

/** Set of valid service ids, for validating the disabled_services setting. */
export const DOWNLOAD_SERVICE_IDS = new Set(DOWNLOAD_SERVICES.map(s => s.id));

export function getServiceForUrl(url) {
  const hostname = hostOf(canonicalizeMirrorUrl(url));
  if (!hostname) return null;
  return DOWNLOAD_SERVICES.find(service => hostUnder(hostname, service.hosts)) || null;
}

// If the URL belongs to a service that has been turned off in the webui, return that service's display label; otherwise null
export async function getDisabledServiceLabel(url) {
  const service = getServiceForUrl(url);
  if (!service) {
    return null;
  }
  const disabled = await readSetting('disabled_services');
  return disabled.includes(service.id) ? service.label : null;
}
