'use strict';
const token = location.pathname.split('/').pop();
const base = `/api/s/${token}`;
const root = document.getElementById('app');
const fileUrl = (rel, inline) => `${base}/file?path=${encodeURIComponent(rel || '')}${inline ? '&inline=1' : ''}`;

function frame(...kids) {
  root.replaceChildren(h('main', { class: 'share' }, h('header', { class: 'share-head' }, brand()), ...kids));
}

function showError(message) {
  frame(h('section', { class: 'card center' }, h('h1', {}, 'Link unavailable'), h('p', { class: 'muted' }, message)));
}

function showLocked() {
  const input = h('input', { type: 'password', required: true, autocomplete: 'off', placeholder: 'Password', 'aria-label': 'Password' });
  const error = h('p', { class: 'error', hidden: true });
  frame(h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', `${base}/unlock`, { password: input.value });
        load('');
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  }, h('h1', {}, 'This link is protected'), h('p', { class: 'muted' }, 'Enter the password you were given.'), input, error, h('button', { class: 'btn primary' }, 'Open')));
  input.focus();
}

function preview(name, url) {
  const kind = kindOf(name);
  if (kind === 'image') return h('img', { class: 'share-media', src: url, alt: name });
  if (kind === 'video') return h('video', { class: 'share-media', src: url, controls: true, preload: 'metadata' });
  if (kind === 'audio') return h('audio', { src: url, controls: true });
  return null;
}

function showFile(data) {
  document.title = data.name;
  frame(h('section', { class: 'card' },
    preview(data.name, fileUrl('', true)),
    h('h1', { class: 'break' }, data.name),
    h('p', { class: 'muted' }, fmtSize(data.size), data.exp ? ` · link expires ${new Date(data.exp).toLocaleDateString()}` : ''),
    h('a', { class: 'btn primary', href: fileUrl(''), download: '' }, ic('download'), 'Download')));
}

function showFolder(data) {
  document.title = data.name;
  const parts = data.path ? data.path.split('/') : [];
  const crumbs = [h('button', { class: 'crumb', onclick: () => load('') }, data.name)];
  parts.forEach((part, i) => {
    const rel = parts.slice(0, i + 1).join('/');
    crumbs.push(h('span', { class: 'sep' }, '/'), h('button', { class: 'crumb', onclick: () => load(rel) }, part));
  });
  const items = [...data.items].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  frame(h('section', { class: 'card wide' },
    h('div', { class: 'share-bar' }, h('nav', { class: 'crumbs' }, crumbs), h('a', { class: 'btn', href: fileUrl(data.path), download: '' }, ic('download'), 'Download all')),
    h('div', { class: 'share-list' }, items.length ? items.map((item) => h('div', { class: 'share-row' },
      ic(iconFor(item), item.type === 'dir' ? 'folder-ic' : ''),
      item.type === 'dir'
        ? h('button', { class: 'linkish break', onclick: () => load(item.rel) }, item.name)
        : h('a', { class: 'linkish break', href: fileUrl(item.rel), download: '' }, item.name),
      h('span', { class: 'muted num' }, item.type === 'dir' ? '' : fmtSize(item.size)))) : h('p', { class: 'muted center' }, 'This folder is empty.'))));
}

async function load(path) {
  try {
    const data = await api('GET', `${base}?path=${encodeURIComponent(path)}`);
    if (data.locked) showLocked();
    else if (data.type === 'file') showFile(data);
    else showFolder(data);
  } catch (err) {
    showError(err.message);
  }
}

load('');
