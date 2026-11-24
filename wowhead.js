const origin = 'https://www.wowhead.com';
const types = {
  item: 'Item', quest: 'Quest', npc: 'NPC', spell: 'Spell', guide: 'Guide',
  achievement: 'Achievement', zone: 'Zone', object: 'Object', currency: 'Currency', mount: 'Mount',
};

export function parseWowhead(html, editionPath, finalUrl, query) {
  const results = new Map();
  const prefix = editionPath.replace(/\/search$/, '');
  const pathPattern = /^\/(?:classic\/|forever\/)?([a-z]+)=(\d+)(?:\/[^?#]*)?$/;
  const add = (href, name, trusted = false) => {
    const url = new URL(href, origin + prefix + '/');
    const match = pathPattern.exec(url.pathname);
    if (url.origin !== origin || !match || !Object.hasOwn(types, match[1])) return;
    if (!url.pathname.startsWith(prefix + '/' + match[1] + '=')) return;
    const title = name.replace(/<[^>]*>/g, '').replace(/&(?:amp|quot|apos|lt|gt|nbsp|#39);/g,
      entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' })[entity])
      .replace(/^@/, '').trim().slice(0, 200);
    if (!title || (!trusted && !query.toLowerCase().split(/\s+/).every(term => title.toLowerCase().includes(term)))) return;
    const key = match[1] + '=' + match[2];
    if (results.size < 50 && !results.has(key)) {
      results.set(key, { title, type: types[match[1]], url: origin + prefix + '/' + key });
    }
  };

  if (finalUrl && pathPattern.test(new URL(finalUrl).pathname)) {
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
    add(finalUrl, title?.split(' - ')[0] || query, true);
    return [...results.values()];
  }

  for (const list of html.matchAll(/new\s+Listview\s*\(\{\s*template:\s*['"]([a-z]+)['"][\s\S]*?\bdata:\s*(\[(?:[^"\[\]]|"(?:\\.|[^"\\])*"|\[[^\[\]]*\])*\])/g)) {
    if (!Object.hasOwn(types, list[1])) continue;
    try {
      for (const entry of JSON.parse(list[2])) {
        if (Number.isSafeInteger(entry?.id) && typeof entry.name === 'string') {
          add(prefix + '/' + list[1] + '=' + entry.id, entry.name, true);
        }
      }
    } catch {
      continue;
    }
  }

  for (const anchor of html.matchAll(/<a\b[^>]*\bhref=["']([^"'<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/^(?:https:\/\/www\.wowhead\.com\/|\/|[a-z]+=)/i.test(anchor[1])) continue;
    try { add(anchor[1], anchor[2]); } catch { continue; }
  }
  return [...results.values()];
}

export async function searchWowhead(url, query) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok || new URL(response.url).origin !== origin) {
    throw new Error('Wowhead search returned HTTP ' + response.status);
  }
  const html = await response.text();
  if (!/<title[^>]*>[^<]*wowhead/i.test(html)) throw new Error('Unexpected Wowhead search page');
  return parseWowhead(html, url.pathname, response.url, query);
}
