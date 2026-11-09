'use strict';
// Shared by the app and the public share page. DOM is built with h(), which sets text as text,
// so a hostile filename can never become markup.

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = ICONS[v]; // Constants defined below, never user data.
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.2 1.6.7L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.500z"/></svg>',
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5L5 20"/>'),
  video: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>'),
  audio: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/>'),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  share: svg('<path d="M10 14a4 4 0 0 0 6 .400l3-3a4 4 0 0 0-5.700-5.700l-1.500 1.500"/><path d="M14 10a4 4 0 0 0-6-.400l-3 3a4 4 0 0 0 5.700 5.700l1.500-1.500"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
  rename: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.500 6.500 4 4"/>'),
  move: svg('<path d="M3 6.500A2.500 2.500 0 0 1 5.500 4h3.600c.6 0 1.200.2 1.600.7L12 6h6.500A2.500 2.500 0 0 1 21 8.500v9a2.500 2.500 0 0 1-2.500 2.500h-13A2.500 2.500 0 0 1 3 17.500z"/><path d="M9 13h6M12.500 10.500 15 13l-2.500 2.500"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3.800 6 3.800 9s-.8 6-3.800 9c-3-3-3.800-6-3.800-9S9 6 12 3z"/>'),
  people: svg('<circle cx="9" cy="8" r="3.500"/><path d="M3 20c.5-3.500 2.800-5.500 6-5.500s5.500 2 6 5.500M16 4.800a3.500 3.500 0 0 1 0 6.400M18 14.800c1.700.8 2.700 2.600 3 5.200"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  left: svg('<path d="m15 5-7 7 7 7"/>'),
  right: svg('<path d="m9 5 7 7-7 7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1"/>'),
  restore: svg('<path d="M4 9h11a5 5 0 0 1 0 10H8"/><path d="M8 5 4 9l4 4"/>'),
  check: svg('<path d="m5 13 4 4L19 7"/>'),
};

function fmtSize(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

const EXT_KIND = {};
const addKinds = (kind, list) => list.split(' ').forEach((e) => { EXT_KIND[e] = kind; });
addKinds('image', 'png jpg jpeg gif webp avif bmp');
addKinds('video', 'mp4 m4v mov webm ogv');
addKinds('audio', 'mp3 m4a aac ogg oga opus wav flac');
addKinds('pdf', 'pdf');
addKinds('text', 'txt md markdown log csv tsv json jsonl xml yml yaml toml ini conf cfg env js mjs cjs ts tsx jsx py rb go rs java c h cpp hpp cs php sh bat ps1 sql html htm css scss svg');
addKinds('archive', 'zip rar 7z tar gz tgz bz2 xz iso');

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const kindOf = (name) => EXT_KIND[extOf(name)] || 'other';

function iconFor(item) {
  if (item.type === 'dir') return 'folder';
  return { image: 'image', video: 'video', audio: 'audio', pdf: 'doc', text: 'doc', archive: 'archive' }[kindOf(item.name)] || 'file';
}

function ic(name, cls) {
  return h('span', { class: `ic ${cls || ''}`, icon: name });
}

function toast(message, kind) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast ${kind || ''}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = h('textarea', { value: text, class: 'offscreen' });
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
  toast('Copied');
}

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Attic': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'Could not reach your Attic server. Check the connection and try again.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`, data);
  return data;
}

const brand = () => h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }), h('span', {}, 'Attic'));
