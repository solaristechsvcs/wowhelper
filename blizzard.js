import { randomBytes } from 'node:crypto';

const regions = ['us', 'eu', 'kr', 'tw'];
const editions = { retail: 'dynamic', classic: 'dynamic-classic', era: 'dynamic-classic1x' };

export function realmKey(realm) {
  return [realm.region, realm.edition, realm.id].join(':');
}

export function validateBlizzard(config) {
  if (!config?.realms?.length) return;
  if (!config.clientId || !config.clientSecret) throw new Error('Set Blizzard API credentials in config.js.');
  const seen = new Set();
  for (const realm of config.realms) {
    if (!regions.includes(realm.region) || !Object.hasOwn(editions, realm.edition) ||
        !Number.isSafeInteger(realm.id) || realm.id < 1 ||
        typeof realm.label !== 'string' || !realm.label.trim() || realm.label.length > 100) {
      throw new Error('Each Blizzard realm needs a valid region, edition, connected-realm ID, and label.');
    }
    const key = realmKey(realm);
    if (seen.has(key)) throw new Error('Remove duplicate Blizzard realm ' + key + '.');
    seen.add(key);
  }
}

export function blizzardClient(config, request = fetch, clock = Date.now) {
  let token;
  let expiresAt = 0;

  async function getToken() {
    if (token && clock() < expiresAt) return token;
    const credentials = Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64');
    const response = await request('https://oauth.battle.net/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + credentials },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Blizzard OAuth returned HTTP ' + response.status);
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) {
      throw new Error('Unexpected Blizzard token response.');
    }
    token = data.access_token;
    expiresAt = clock() + Math.max(0, data.expires_in - 60) * 1000;
    return token;
  }

  async function authorized(url, retry = true) {
    const response = await request(url, {
      headers: { Authorization: 'Bearer ' + await getToken() },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && retry) {
      expiresAt = 0;
      return authorized(url, false);
    }
    return response;
  }

  async function status(realm) {
    const url = new URL('/data/wow/connected-realm/' + realm.id, 'https://' + realm.region + '.api.blizzard.com');
    url.searchParams.set('namespace', editions[realm.edition] + '-' + realm.region);
    const response = await authorized(url);
    if (!response.ok) throw new Error('Blizzard realm API returned HTTP ' + response.status);
    const status = (await response.json()).status?.type;
    if (status !== 'UP' && status !== 'DOWN') throw new Error('Unknown Blizzard realm status.');
    return status;
  }

  async function character(region, realm, name) {
    if (!regions.includes(region)) throw new Error('Unsupported Blizzard region.');
    const path = '/profile/wow/character/' + encodeURIComponent(realm) + '/' + encodeURIComponent(name);
    const url = new URL(path, 'https://' + region + '.api.blizzard.com');
    url.searchParams.set('namespace', 'profile-' + region);
    url.searchParams.set('locale', { us: 'en_US', eu: 'en_GB', kr: 'ko_KR', tw: 'zh_TW' }[region]);
    const response = await authorized(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Blizzard character API returned HTTP ' + response.status);
    const profile = await response.json();
    if (typeof profile.name !== 'string') throw new Error('Unexpected Blizzard character profile.');
    return profile;
  }

  return { status, character };
}

export function observeRealm(data, realm, status, now) {
  data.realmStatus ??= {};
  const key = realmKey(realm);
  const previous = data.realmStatus[key];
  data.realmStatus[key] = { status, checkedAt: now };
  if (previous && previous.status !== status) {
    data.notices.push({
      kind: 'realm', nonce: randomBytes(12).toString('hex'), label: realm.label, status, at: now,
    });
  }
}
