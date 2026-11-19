import { getLxdBridgeIp } from './lxd.ts';

const APT_CACHE_PORT = 3142;

/**
 * Probe the host's local apt-cacher-ng (`npm run ensure:apt-cache`) on the
 * LXD bridge — the address containers can reach it through — and return the
 * proxy base URL, or null when no cache is answering (fresh machine, CI):
 * callers then keep fetching mirrors directly, so the cache is a pure
 * workstation/demo acceleration, never a requirement.
 */
export async function probeAptCache(): Promise<string | null> {
  const bridgeIp = await getLxdBridgeIp();
  if (bridgeIp == null) {
    return null;
  }
  const base = `http://${bridgeIp}:${APT_CACHE_PORT}`;
  try {
    // apt-cacher-ng answers any GET on / with its repository index page;
    // anything below 500 means the service is alive and serving.
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
    return response.status < 500 ? base : null;
  } catch {
    return null;
  }
}
