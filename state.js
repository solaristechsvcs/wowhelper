import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openState(file) {
  mkdirSync(dirname(file), { recursive: true });
  let state = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { raids: {}, maintenance: {}, notices: [] };

  return {
    get current() {
      return state;
    },
    update(change) {
      const next = structuredClone(state);
      const result = change(next);
      writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600, flush: true });
      renameSync(file + '.tmp', file);
      state = next;
      return result;
    },
  };
}

export function parseTime(input) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) return null;
  const local = new Date(match[1] + 'T' + match[2] + 'Z');
  if (!Number.isFinite(+local) || local.toISOString().slice(0, 16) !== match[1] + 'T' + match[2]) return null;
  const time = Date.parse(input);
  return Number.isFinite(time) ? time : null;
}

export function transition(data, window, status, at, confirmed) {
  window.status = status;
  data.notices.push({ id: window.id, status, at, confirmed });
}

export function advanceMaintenance(data, now) {
  for (const window of Object.values(data.maintenance)) {
    if (window.status === 'scheduled' && window.start <= now) {
      transition(data, window, 'started', window.start, false);
    }
    if (window.status === 'started' && window.end <= now) {
      transition(data, window, 'ended', window.end, false);
    }
  }
}
