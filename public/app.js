'use strict';
const app = document.getElementById('app');
const enc = encodeURIComponent;
const saved = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };

const S = {
  me: null,
  cwd: '',
  items: [],
  selected: new Set(),
  sortKey: 'name',
  sortDir: 1,
  view: saved('attic.view', 'list'),
  query: '',
};
let renderToken = 0;
let mainEl = null;
let railEl = null;
let usageEl = null;

const report = (err) => {
  if (err.status === 401) return boot();
  toast(err.message || 'Something went wrong.', 'bad');
  return undefined;
};
const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    report(err);
    return undefined;
  }
};

// ---- Dialogs ------------------------------------------------------------------------------

function openDialog(title, buildBody, cls) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: `dlg ${cls || ''}` });
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    dialog.append(h('h2', {}, title), buildBody(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

function askText({ title, label, value = '', ok = 'Save', selectStem = false }) {
  return openDialog(title, (close) => {
    const input = h('input', { value, required: true, 'aria-label': label, autocomplete: 'off', spellcheck: false });
    setTimeout(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); } },
      h('label', { class: 'field' }, h('span', {}, label), input),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary' }, ok)));
  });
}

function confirmBox({ title, text, ok = 'Confirm', danger = false }) {
  return openDialog(title, (close) => h('div', {},
    h('p', { class: 'muted' }, text),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, ok))));
}

function linkRow(url) {
  return h('div', { class: 'link-row' },
    h('input', { value: url, readOnly: true, 'aria-label': 'Link', onfocus: (e) => e.target.select() }),
    h('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, ic('copy'), 'Copy'));
}

// Opened on the PC itself, the page's own address is localhost, which is useless to anyone else.
async function shareOrigin() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return { origin: location.origin, localOnly: false };
  const { url } = await api('GET', '/api/public-url');
  return { origin: url || location.origin, localOnly: !url };
}

function shareDialog(item) {
  return openDialog(`Share “${item.name}”`, (close) => {
    const body = h('div', {});
    const days = h('select', { 'aria-label': 'Link expires' },
      [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['0', 'Never']].map(([v, t]) => h('option', { value: v, selected: v === '7' }, t)));
    const password = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off', 'aria-label': 'Link password' });
    const form = h('form', {
      onsubmit: guard(async (e) => {
        e.preventDefault();
        const { token } = await api('POST', '/api/shares', { path: item.rel, days: Number(days.value), password: password.value });
        const { origin, localOnly } = await shareOrigin();
        body.replaceChildren(
          localOnly
            ? h('p', { class: 'note' }, 'This link only works on this PC until you turn on an option under Remote.')
            : h('p', { class: 'muted' }, 'Anyone with this link can download this. Send it through a channel you trust.'),
          linkRow(`${origin}/s/${token}`),
          h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', onclick: () => close() }, 'Done')));
      }),
    },
    h('label', { class: 'field' }, h('span', {}, 'Link expires after'), days),
    h('label', { class: 'field' }, h('span', {}, 'Password'), password),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary' }, 'Create link')));
    body.append(form);
    return body;
  });
}

function moveDialog(paths) {
  return openDialog(`Move ${paths.length === 1 ? `“${paths[0].split('/').pop()}”` : `${paths.length} items`}`, (close) => {
    let cwd = '';
    const crumbs = h('nav', { class: 'crumbs small' });
    const list = h('div', { class: 'pick-list' });
    const go = guard(async (rel) => {
      const data = await api('GET', `/api/list?path=${enc(rel)}`);
      cwd = data.path;
      const parts = cwd ? cwd.split('/') : [];
      crumbs.replaceChildren(h('button', { type: 'button', class: 'crumb', onclick: () => go('') }, 'Home'),
        ...parts.flatMap((p, i) => [h('span', { class: 'sep' }, '/'), h('button', { type: 'button', class: 'crumb', onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)]));
      const dirs = data.items.filter((i) => i.type === 'dir' && !paths.includes(i.rel)).sort((a, b) => a.name.localeCompare(b.name));
      list.replaceChildren(...(dirs.length
        ? dirs.map((d) => h('button', { type: 'button', class: 'pick', onclick: () => go(d.rel) }, ic('folder', 'folder-ic'), h('span', { class: 'ell' }, d.name)))
        : [h('p', { class: 'muted center' }, 'No folders here')]));
    });
    go('');
    return h('div', {}, crumbs, list, h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => close({ dest: cwd }) }, 'Move here')));
  });
}

// ---- Preview ------------------------------------------------------------------------------

const inlineUrl = (rel) => `/api/file?path=${enc(rel)}&inline=1`;
const downloadUrl = (rel) => `/api/file?path=${enc(rel)}`;

function startDownload(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function previewStage(item) {
  const kind = kindOf(item.name);
  if (kind === 'image') return h('img', { src: inlineUrl(item.rel), alt: item.name });
  if (kind === 'video') return h('video', { src: inlineUrl(item.rel), controls: true, autoplay: true });
  if (kind === 'audio') return h('audio', { src: inlineUrl(item.rel), controls: true, autoplay: true });
  if (kind === 'pdf') return h('iframe', { src: inlineUrl(item.rel), title: item.name });
  if (kind === 'text' && item.size <= 2 * 1024 * 1024) {
    const pre = h('pre', {}, 'Loading…');
    fetch(inlineUrl(item.rel)).then((r) => r.text()).then((t) => { pre.textContent = t; }).catch(() => { pre.textContent = 'Could not load this file.'; });
    return pre;
  }
  return h('div', { class: 'no-preview' }, ic(iconFor(item), 'huge'), h('p', {}, 'No preview for this file type.'),
    h('button', { class: 'btn primary', onclick: () => startDownload(downloadUrl(item.rel)) }, ic('download'), 'Download'), h('p', { class: 'muted' }, fmtSize(item.size)));
}

function openPreview(start, siblings) {
  const files = siblings.filter((i) => i.type === 'file');
  let index = files.findIndex((f) => f.rel === start.rel);
  const dialog = h('dialog', { class: 'viewer' });
  const title = h('div', { class: 'ell viewer-title' });
  const stage = h('div', { class: 'viewer-stage' });
  const show = () => {
    const item = files[index];
    title.textContent = item.name;
    stage.replaceChildren(previewStage(item));
  };
  const step = (d) => {
    if (files.length < 2) return;
    index = (index + d + files.length) % files.length;
    show();
  };
  const close = () => {
    stage.replaceChildren();
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  dialog.append(
    h('header', { class: 'viewer-head' }, title,
      h('button', { class: 'icon-btn', 'aria-label': 'Download', title: 'Download', onclick: () => startDownload(downloadUrl(files[index].rel)) }, ic('download')),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: close }, ic('close'))),
    h('div', { class: 'viewer-body' },
      files.length > 1 ? h('button', { class: 'icon-btn nav', 'aria-label': 'Previous', onclick: () => step(-1) }, ic('left')) : null,
      stage,
      files.length > 1 ? h('button', { class: 'icon-btn nav', 'aria-label': 'Next', onclick: () => step(1) }, ic('right')) : null));
  document.body.append(dialog);
  dialog.showModal();
  show();
}

// ---- Uploads ------------------------------------------------------------------------------

const Up = { tasks: [], running: 0, MAX: 3, listEl: null, trayEl: null, refreshTimer: 0 };

function queueFiles(entries, baseDir) {
  for (const { file, sub } of entries) {
    const task = { file, dir: [baseDir, sub].filter(Boolean).join('/'), sent: 0, state: 'waiting', xhr: null, id: null, error: '' };
    Up.tasks.push(task);
  }
  drawTray();
  pumpUploads();
}

function pumpUploads() {
  while (Up.running < Up.MAX) {
    const task = Up.tasks.find((t) => t.state === 'waiting');
    if (!task) break;
    Up.running++;
    task.state = 'uploading';
    runUpload(task)
      .catch((err) => {
        if (task.state !== 'cancelled') {
          task.state = 'failed';
          task.error = err.message || 'Upload failed.';
        }
      })
      .finally(() => {
        Up.running--;
        drawTray();
        pumpUploads();
        // Get out of the way once everything has landed; failures stay visible.
        clearTimeout(Up.dismissTimer);
        Up.dismissTimer = setTimeout(() => {
          if (Up.tasks.length && Up.tasks.every((t) => t.state === 'done')) {
            Up.tasks = [];
            drawTray();
          }
        }, 4000);
      });
  }
}

function sendChunk(task, blob, offset) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', `/api/uploads/${task.id}?offset=${offset}`);
    xhr.setRequestHeader('X-Attic', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      task.sent = offset + e.loaded;
      updateTask(task);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* proxy error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status}).`, data));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Connection lost.'));
    xhr.onabort = () => reject(new ApiError(-1, 'Cancelled.'));
    xhr.send(blob);
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function runUpload(task) {
  const { file } = task;
  const init = await api('POST', '/api/uploads', { dir: task.dir, name: file.name, size: file.size, mtime: file.lastModified });
  task.id = init.id;
  if (!init.done) {
    let offset = init.offset;
    let attempts = 0;
    while (offset < file.size) {
      if (task.state === 'cancelled') return;
      const end = Math.min(offset + init.chunkSize, file.size);
      try {
        const res = await sendChunk(task, file.slice(offset, end), offset);
        offset = res.offset;
        task.sent = offset;
        attempts = 0;
        task.state = 'uploading';
        updateTask(task);
      } catch (err) {
        if (task.state === 'cancelled' || err.status === -1) return;
        if (err.status === 409 && err.data && Number.isFinite(err.data.offset)) {
          offset = err.data.offset;
          continue;
        }
        const transient = err.status === 0 || err.status === 429 || err.status >= 500;
        if (!transient || err.status === 507 || attempts >= 30) throw err;
        attempts++;
        task.state = 'retrying';
        updateTask(task);
        await sleep(Math.min(1000 * 2 ** attempts, 30000));
      }
    }
  }
  task.sent = file.size;
  task.state = 'done';
  clearTimeout(Up.refreshTimer);
  Up.refreshTimer = setTimeout(() => {
    if (currentRoute().name === 'files' && !S.query) renderFiles();
    refreshUsage();
  }, 300);
}

function cancelTask(task) {
  const wasActive = task.state === 'uploading' || task.state === 'retrying';
  task.state = 'cancelled';
  if (task.xhr) task.xhr.abort();
  if (wasActive && task.id) {
    setTimeout(() => api('DELETE', `/api/uploads/${task.id}`).catch(() => {}), 200);
  }
  Up.tasks = Up.tasks.filter((t) => t !== task);
  drawTray();
}

function updateTask(task) {
  if (!task.row) return;
  const pct = task.file.size ? Math.min(100, (task.sent / task.file.size) * 100) : 100;
  task.bar.style.width = `${pct}%`;
  task.label.textContent = task.state === 'retrying' ? 'Reconnecting…' : `${fmtSize(task.sent)} of ${fmtSize(task.file.size)}`;
}

function drawTray() {
  if (!Up.tasks.length) {
    if (Up.trayEl) Up.trayEl.remove();
    Up.trayEl = null;
    return;
  }
  if (!Up.trayEl) {
    Up.listEl = h('div', { class: 'tray-list' });
    Up.head = h('strong', {});
    Up.trayEl = h('aside', { class: 'tray', 'aria-label': 'Uploads' },
      h('header', {}, Up.head, h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Clear finished', onclick: () => { Up.tasks = Up.tasks.filter((t) => !['done', 'failed'].includes(t.state)); drawTray(); } }, ic('close'))),
      Up.listEl);
    document.body.append(Up.trayEl);
  }
  const active = Up.tasks.filter((t) => ['waiting', 'uploading', 'retrying'].includes(t.state)).length;
  const failed = Up.tasks.filter((t) => t.state === 'failed').length;
  Up.head.textContent = active ? `Uploading ${active} file${active === 1 ? '' : 's'}` : failed ? `${failed} upload${failed === 1 ? '' : 's'} failed` : 'Uploads finished';
  Up.listEl.replaceChildren(...Up.tasks.slice(-60).map((task) => {
    task.bar = h('div', { class: 'bar-fill' });
    task.label = h('span', { class: 'muted num' });
    task.row = h('div', { class: `tray-row ${task.state}` },
      h('div', { class: 'tray-top' },
        h('span', { class: 'ell' }, task.file.name),
        ['waiting', 'uploading', 'retrying'].includes(task.state)
          ? h('button', { class: 'tiny', 'aria-label': `Cancel ${task.file.name}`, onclick: () => cancelTask(task) }, ic('close'))
          : task.state === 'done' ? ic('check', 'ok') : null),
      task.state === 'failed' ? h('span', { class: 'error' }, task.error) : [h('div', { class: 'bar' }, task.bar), task.label]);
    updateTask(task);
    return task.row;
  }));
}

window.addEventListener('beforeunload', (e) => {
  if (Up.tasks.some((t) => ['waiting', 'uploading', 'retrying'].includes(t.state))) e.preventDefault();
});

async function readDropped(items) {
  const out = [];
  const walk = async (entry, sub) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, sub });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const next = [...await (async () => {
        const all = [];
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) return all;
          all.push(...batch);
        }
      })()];
      for (const child of next) await walk(child, [sub, entry.name].filter(Boolean).join('/'));
    }
  };
  const entries = [...items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry()).filter(Boolean);
  for (const entry of entries) await walk(entry, '');
  return out;
}

function pickFiles(folder) {
  const input = h('input', { type: 'file', multiple: true, class: 'offscreen' });
  if (folder) input.setAttribute('webkitdirectory', '');
  input.addEventListener('change', () => {
    const list = [...input.files].map((file) => ({
      file,
      sub: folder ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '',
    }));
    input.remove();
    queueFiles(list, S.cwd);
  });
  document.body.append(input);
  input.click();
}

// ---- Popup menu ---------------------------------------------------------------------------

function popup(anchor, entries) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' }, entries.map(([icon, label, action, danger]) => h('button', {
    role: 'menuitem',
    class: danger ? 'danger-text' : '',
    onclick: () => { menu.remove(); guard(action)(); },
  }, ic(icon), label)));
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`;
  menu.firstChild.focus();
  const dismiss = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'pointerdown' && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
}

// ---- Files view ---------------------------------------------------------------------------

const refresh = () => renderFiles();

async function doDelete(paths) {
  const name = paths.length === 1 ? `“${paths[0].split('/').pop()}”` : `${paths.length} items`;
  if (!await confirmBox({ title: `Delete ${name}?`, text: 'It moves to Trash, where you can restore it for 30 days. Any share links to it stop working.', ok: 'Move to Trash', danger: true })) return;
  await api('POST', '/api/delete', { paths });
  toast('Moved to Trash');
  S.selected.clear();
  refresh();
  refreshUsage();
}

async function doMove(paths) {
  const result = await moveDialog(paths);
  if (!result) return;
  await api('POST', '/api/move', { paths, dest: result.dest });
  toast('Moved');
  S.selected.clear();
  refresh();
}

function downloadSelection(paths) {
  startDownload(`/api/zip?${paths.map((p) => `p=${enc(p)}`).join('&')}`);
}

async function doRename(item) {
  const name = await askText({ title: 'Rename', label: 'New name', value: item.name, ok: 'Rename', selectStem: item.type === 'file' });
  if (!name || name === item.name) return;
  await api('POST', '/api/rename', { path: item.rel, name });
  refresh();
}

function itemMenu(anchor, item) {
  popup(anchor, [
    ['download', item.type === 'dir' ? 'Download as ZIP' : 'Download', () => startDownload(downloadUrl(item.rel))],
    ['share', 'Share link', () => shareDialog(item)],
    ['rename', 'Rename', () => doRename(item)],
    ['move', 'Move', () => doMove([item.rel])],
    ['trash', 'Delete', () => doDelete([item.rel]), true],
  ]);
}

function sortedItems() {
  const { sortKey, sortDir } = S;
  return [...S.items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (sortKey === 'name') return sortDir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return sortDir * ((a[sortKey] || 0) - (b[sortKey] || 0)) || a.name.localeCompare(b.name);
  });
}

function openItem(item, items) {
  if (item.type === 'dir') {
    S.query = '';
    location.hash = `#/files/${item.rel.split('/').map(enc).join('/')}`;
  } else {
    openPreview(item, items);
  }
}

function toggleSelect(rel, on) {
  if (on) S.selected.add(rel);
  else S.selected.delete(rel);
  drawSelectionBar();
  document.querySelectorAll('[data-rel]').forEach((row) => row.classList.toggle('picked', S.selected.has(row.dataset.rel)));
  const all = document.getElementById('select-all');
  if (all) all.checked = S.items.length > 0 && S.selected.size === S.items.length;
}

function drawSelectionBar() {
  const slot = document.getElementById('selection');
  if (!slot) return;
  const paths = [...S.selected];
  if (!paths.length) {
    slot.replaceChildren();
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  slot.replaceChildren(
    h('strong', {}, `${paths.length} selected`),
    h('button', { class: 'btn', onclick: () => downloadSelection(paths) }, ic('download'), 'Download'),
    h('button', { class: 'btn', onclick: guard(() => doMove(paths)) }, ic('move'), 'Move'),
    h('button', { class: 'btn danger-text', onclick: guard(() => doDelete(paths)) }, ic('trash'), 'Delete'),
    h('button', { class: 'icon-btn', 'aria-label': 'Clear selection', title: 'Clear selection', onclick: () => { S.selected.clear(); drawListBody(); } }, ic('close')));
}

function rowCheck(item) {
  return h('input', { type: 'checkbox', checked: S.selected.has(item.rel), 'aria-label': `Select ${item.name}`, onclick: (e) => e.stopPropagation(), onchange: (e) => toggleSelect(item.rel, e.target.checked) });
}

function moreBtn(item) {
  return h('button', { class: 'icon-btn', 'aria-label': `Actions for ${item.name}`, onclick: (e) => { e.stopPropagation(); itemMenu(e.currentTarget, item); } }, ic('more'));
}

function header(label, key, cls) {
  const active = S.sortKey === key;
  return h('button', {
    class: `th ${cls || ''} ${active ? 'on' : ''}`,
    onclick: () => {
      if (active) S.sortDir *= -1;
      else { S.sortKey = key; S.sortDir = key === 'name' ? 1 : -1; }
      drawListBody();
    },
  }, label, active ? (S.sortDir > 0 ? ' ↑' : ' ↓') : '');
}

function subPath(item) {
  if (!S.query) return null;
  const parent = item.rel.split('/').slice(0, -1).join(' / ');
  return h('span', { class: 'muted sub ell' }, parent || 'Home');
}

function drawListBody() {
  const slot = document.getElementById('listing');
  if (!slot) return;
  const items = sortedItems();
  drawSelectionBar();
  if (!items.length) {
    slot.replaceChildren(h('div', { class: 'empty' },
      S.query ? [h('h2', {}, 'Nothing found'), h('p', { class: 'muted' }, `No files match “${S.query}”.`)]
        : [h('h2', {}, 'Nothing up here yet'), h('p', { class: 'muted' }, 'Drop files anywhere on this page, or use Upload.')]));
    return;
  }
  if (S.view === 'grid') {
    slot.replaceChildren(h('div', { class: 'grid' }, items.map((item) => {
      const thumb = kindOf(item.name) === 'image' && item.type === 'file' && item.size < 25 * 1024 * 1024
        ? h('img', { src: inlineUrl(item.rel), alt: '', loading: 'lazy' })
        : ic(iconFor(item), `big ${item.type === 'dir' ? 'folder-ic' : ''}`);
      return h('div', { class: `tile ${S.selected.has(item.rel) ? 'picked' : ''}`, 'data-rel': item.rel, onclick: () => openItem(item, items) },
        h('div', { class: 'tile-thumb' }, thumb),
        h('div', { class: 'tile-check' }, rowCheck(item)),
        h('div', { class: 'tile-foot' }, h('button', { class: 'name ell', title: item.name }, item.name), moreBtn(item)));
    })));
    return;
  }
  const all = h('input', { type: 'checkbox', id: 'select-all', 'aria-label': 'Select all', checked: S.selected.size === items.length, onchange: (e) => { S.selected = new Set(e.target.checked ? items.map((i) => i.rel) : []); drawListBody(); } });
  slot.replaceChildren(h('div', { class: 'table' },
    h('div', { class: 'tr thead' }, h('div', { class: 'c-check' }, all), header('Name', 'name', 'c-name'), header('Size', 'size', 'c-size'), header('Modified', 'mtime', 'c-date'), h('div', { class: 'c-more' })),
    items.map((item) => h('div', { class: `tr ${S.selected.has(item.rel) ? 'picked' : ''}`, 'data-rel': item.rel, onclick: () => openItem(item, items) },
      h('div', { class: 'c-check' }, rowCheck(item)),
      h('div', { class: 'c-name' }, ic(iconFor(item), item.type === 'dir' ? 'folder-ic' : ''),
        h('div', { class: 'name-wrap' }, h('button', { class: 'name ell', title: item.name }, item.name), subPath(item),
          h('span', { class: 'muted mobile-meta num' }, [item.type === 'file' ? fmtSize(item.size) : null, fmtDate(item.mtime)].filter(Boolean).join(' · ')))),
      h('div', { class: 'c-size muted num' }, item.type === 'file' ? fmtSize(item.size) : '—'),
      h('div', { class: 'c-date muted num' }, fmtDate(item.mtime)),
      h('div', { class: 'c-more' }, moreBtn(item))))));
}

function crumbsFor(cwd) {
  const parts = cwd ? cwd.split('/') : [];
  const to = (i) => `#/files/${parts.slice(0, i + 1).map(enc).join('/')}`;
  return h('nav', { class: 'crumbs', 'aria-label': 'Folder path' },
    h('a', { class: 'crumb', href: '#/files/' }, 'Home'),
    parts.flatMap((p, i) => [h('span', { class: 'sep' }, '/'), h('a', { class: 'crumb', href: to(i) }, p)]));
}

const renderFiles = guard(async () => {
  const token = ++renderToken;
  const data = S.query
    ? await api('GET', `/api/search?q=${enc(S.query)}`)
    : await api('GET', `/api/list?path=${enc(currentRoute().rest)}`);
  if (token !== renderToken) return;
  S.cwd = S.query ? S.cwd : data.path;
  S.items = data.items;
  const known = new Set(S.items.map((i) => i.rel));
  S.selected = new Set([...S.selected].filter((r) => known.has(r)));

  let searchTimer;
  const existing = document.getElementById('search');
  const hadFocus = existing && document.activeElement === existing;
  const search = h('input', {
    id: 'search', type: 'search', placeholder: 'Search', value: S.query, 'aria-label': 'Search all files',
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { S.query = e.target.value.trim(); renderFiles(); }, 250);
    },
  });

  const newFolder = guard(async () => {
    const name = await askText({ title: 'New folder', label: 'Folder name', ok: 'Create' });
    if (!name) return;
    await api('POST', '/api/mkdir', { path: S.cwd, name });
    refresh();
  });
  const uploadBtn = h('button', { class: 'btn primary', onclick: (e) => popup(e.currentTarget, [['file', 'Upload files', () => pickFiles(false)], ['folder', 'Upload a folder', () => pickFiles(true)]]) }, ic('upload'), 'Upload');

  mainEl.replaceChildren(
    h('header', { class: 'toolbar' },
      S.query ? h('h1', { class: 'crumbs-title' }, 'Search results') : crumbsFor(S.cwd),
      h('div', { class: 'tools' },
        h('label', { class: 'search' }, ic('search'), search),
        h('button', { class: 'icon-btn', 'aria-label': 'Change layout', title: S.view === 'list' ? 'Grid view' : 'List view', onclick: () => { S.view = S.view === 'list' ? 'grid' : 'list'; remember('attic.view', S.view); renderFiles(); } }, ic(S.view === 'list' ? 'grid' : 'list')),
        h('button', { class: 'btn', onclick: newFolder }, ic('plus'), h('span', { class: 'hide-sm' }, 'New folder')),
        uploadBtn)),
    h('div', { id: 'selection', class: 'selection', hidden: true }),
    h('div', { id: 'listing' }));
  drawListBody();
  if (hadFocus) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
});

// ---- Other views --------------------------------------------------------------------------

function page(title, intro, ...body) {
  mainEl.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, title), intro ? h('p', { class: 'muted' }, intro) : null), ...body);
}

const renderShared = guard(async () => {
  const token = ++renderToken;
  const [{ shares }, { origin }] = await Promise.all([api('GET', '/api/shares'), shareOrigin()]);
  if (token !== renderToken) return;
  page('Shared links', 'Anyone holding one of these links can open the item. Revoke a link to cut off access immediately.',
    shares.length ? h('div', { class: 'stack' }, shares.map((s) => {
      const url = `${origin}/s/${s.token}`;
      return h('article', { class: 'row-card' },
        ic(iconFor({ type: s.type, name: s.name }), s.type === 'dir' ? 'folder-ic' : ''),
        h('div', { class: 'grow' },
          h('strong', { class: 'break' }, s.name),
          h('p', { class: 'muted small num' }, [s.exp ? `Expires ${new Date(s.exp).toLocaleDateString()}` : 'Never expires', s.locked ? 'Password protected' : null, `${s.downloads} download${s.downloads === 1 ? '' : 's'}`].filter(Boolean).join(' · '))),
        h('button', { class: 'btn', onclick: () => copyText(url) }, ic('copy'), h('span', { class: 'hide-sm' }, 'Copy link')),
        h('button', {
          class: 'btn danger-text',
          onclick: guard(async () => {
            if (!await confirmBox({ title: 'Revoke this link?', text: `“${s.name}” will no longer be reachable through it.`, ok: 'Revoke', danger: true })) return;
            await api('DELETE', `/api/shares/${enc(s.token)}`);
            renderShared();
          }),
        }, 'Revoke'));
    })) : h('div', { class: 'empty' }, h('h2', {}, 'No active links'), h('p', { class: 'muted' }, 'Use the ⋯ menu on any file or folder to create one.')));
});

const renderTrash = guard(async () => {
  const token = ++renderToken;
  const { items, days } = await api('GET', '/api/trash');
  if (token !== renderToken) return;
  page('Trash', `Items are removed for good after ${days} days.`,
    items.length ? h('div', {},
      h('div', { class: 'stack' }, items.map((m) => h('article', { class: 'row-card' },
        ic(iconFor(m), m.type === 'dir' ? 'folder-ic' : ''),
        h('div', { class: 'grow' }, h('strong', { class: 'break' }, m.name), h('p', { class: 'muted small num' }, `From /${m.from} · deleted ${fmtDate(m.deleted)}`)),
        h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/trash/restore', { ids: [m.id] }); toast('Restored'); renderTrash(); refreshUsage(); }) }, ic('restore'), h('span', { class: 'hide-sm' }, 'Restore')),
        h('button', {
          class: 'btn danger-text',
          onclick: guard(async () => {
            if (!await confirmBox({ title: 'Delete forever?', text: `“${m.name}” cannot be recovered after this.`, ok: 'Delete forever', danger: true })) return;
            await api('POST', '/api/trash/purge', { ids: [m.id] });
            renderTrash();
          }),
        }, 'Delete')))),
      h('div', { class: 'foot-actions' }, h('button', {
        class: 'btn danger-text',
        onclick: guard(async () => {
          if (!await confirmBox({ title: 'Empty Trash?', text: `All ${items.length} item${items.length === 1 ? '' : 's'} will be permanently deleted.`, ok: 'Empty Trash', danger: true })) return;
          await api('POST', '/api/trash/purge', { all: true });
          renderTrash();
        }),
      }, 'Empty Trash'))) : h('div', { class: 'empty' }, h('h2', {}, 'Trash is empty'), h('p', { class: 'muted' }, 'Deleted files wait here before they are removed.')));
});

function statusPill(state) {
  const map = { on: ['On', 'good'], off: ['Off', ''], starting: ['Connecting…', 'warn'], error: ['Problem', 'bad'] };
  const [text, cls] = map[state] || map.off;
  return h('span', { class: `pill ${cls}` }, text);
}

function remoteCard({ title, tag, text, state, url, control, note }) {
  return h('article', { class: 'card remote' },
    h('div', { class: 'remote-head' }, h('h2', {}, title), tag ? h('span', { class: 'pill' }, tag) : null, h('span', { class: 'grow' }), statusPill(state)),
    h('p', { class: 'muted' }, text),
    url ? linkRow(url) : null,
    note ? h('p', { class: 'note' }, note) : null,
    control);
}

let remoteTimer = 0;
const renderRemote = guard(async () => {
  clearTimeout(remoteTimer);
  const token = ++renderToken;
  const data = await api('GET', '/api/remote');
  if (token !== renderToken) return;

  const apply = (provider, on, confirmText) => guard(async () => {
    if (confirmText && !await confirmBox({ title: 'Check before continuing', text: confirmText, ok: 'Continue' })) return;
    toast(on ? 'Turning on…' : 'Turning off…');
    const result = await api('POST', '/api/remote', { provider, on });
    if (result.actionUrl) {
      await openDialog('Approve in Tailscale', (close) => h('div', {},
        h('p', { class: 'muted' }, 'Tailscale needs you to enable this feature for your network. Open this page, approve it, then come back and turn this on again.'),
        h('a', { class: 'btn primary', href: result.actionUrl, target: '_blank', rel: 'noopener' }, 'Open Tailscale'),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Close'))));
    }
    renderRemote();
  });

  const ts = data.tailscale;
  const tsReady = ts.installed && ts.state === 'Running';
  const tsNote = !ts.installed ? 'Tailscale is not installed on this PC.'
    : !tsReady ? 'Tailscale is installed but not signed in. Open the Tailscale app on this PC and sign in, then reload this page.'
      : ts.foreign ? 'Tailscale port 443 is already used by another service on this PC.' : null;
  const toggle = (provider, on, label, enabled = true, confirmText) => h('button', { class: `btn ${on ? 'primary' : ''}`, disabled: !enabled, onclick: apply(provider, on, confirmText) }, label);

  const cf = data.cloudflare;
  const publicWarn = 'This makes the Attic sign-in page reachable by anyone on the internet. Use a strong password and turn on two-step sign-in in Settings first.';
  const needs2fa = !S.me.totp;

  page('Remote access', 'Each option makes an outbound encrypted connection from this PC, so no router ports are opened and your home IP stays hidden. This PC must stay on and awake.',
    needs2fa ? h('p', { class: 'banner' }, 'Before going public, turn on two-step sign-in in ', h('a', { href: '#/settings' }, 'Settings'), '.') : null,
    h('div', { class: 'stack' },
      remoteCard({
        title: 'Tailscale, private',
        tag: 'Most secure',
        text: 'Only devices signed in to your Tailscale account can even see the server. Install the free Tailscale app on your phone or laptop and you get a permanent address.',
        state: ts.mode === 'serve' ? 'on' : 'off',
        url: ts.mode === 'serve' ? ts.url : '',
        note: tsNote,
        control: ts.mode === 'serve' ? toggle('tailscale-serve', false, 'Turn off') : toggle('tailscale-serve', true, 'Turn on', tsReady && !ts.foreign),
      }),
      remoteCard({
        title: 'Tailscale Funnel, public',
        tag: 'Permanent link',
        text: 'A fixed https address that works in any browser, with nothing to install on the other end. Best if you want share links for other people.',
        state: ts.mode === 'funnel' ? 'on' : 'off',
        url: ts.mode === 'funnel' ? ts.url : '',
        note: tsNote,
        control: ts.mode === 'funnel' ? toggle('tailscale-funnel', false, 'Turn off') : toggle('tailscale-funnel', true, 'Turn on', tsReady && !ts.foreign, publicWarn),
      }),
      remoteCard({
        title: cf.named ? 'Cloudflare Tunnel, public' : 'Cloudflare Quick Tunnel, public',
        tag: cf.named ? 'Your domain' : 'Temporary link',
        text: cf.named ? 'Publishes Attic at the hostname you configured for this tunnel.' : 'A random https address that works in any browser and needs no account. The address changes each time the tunnel restarts.',
        state: cf.state,
        url: cf.url,
        note: !cf.installed ? 'Needs cloudflared. On this PC, run: winget install Cloudflare.cloudflared, then restart Attic.' : cf.state === 'error' ? cf.error : null,
        control: cf.state === 'off' || cf.state === 'error' ? toggle('cloudflare', true, 'Turn on', cf.installed, publicWarn) : toggle('cloudflare', false, 'Turn off'),
      })));
  if (cf.state === 'starting') {
    remoteTimer = setTimeout(() => { if (currentRoute().name === 'remote') renderRemote(); }, 2000);
  }
});

const renderPeople = guard(async () => {
  const token = ++renderToken;
  const { users } = await api('GET', '/api/users');
  if (token !== renderToken) return;
  const name = h('input', { required: true, autocomplete: 'off', placeholder: 'username', 'aria-label': 'Username', spellcheck: false });
  const pass = h('input', { type: 'password', required: true, minLength: 12, autocomplete: 'new-password', placeholder: 'At least 12 characters', 'aria-label': 'Password' });
  const isAdmin = h('input', { type: 'checkbox' });
  page('People', 'Each person gets a private home folder and their own sign-in.',
    h('div', { class: 'stack' }, users.map((u) => h('article', { class: 'row-card' },
      ic('people'),
      h('div', { class: 'grow' }, h('strong', {}, u.name), h('p', { class: 'muted small' }, [u.admin ? 'Admin' : 'Member', u.totp ? 'Two-step on' : 'Two-step off'].join(' · '))),
      h('button', {
        class: 'btn',
        onclick: guard(async () => {
          const password = await askText({ title: `New password for ${u.name}`, label: 'At least 12 characters', ok: 'Set password' });
          if (!password) return;
          await api('POST', `/api/users/${enc(u.name)}/password`, { password });
          toast('Password changed, and their devices were signed out');
          renderPeople();
        }),
      }, 'Reset'),
      u.name === S.me.name ? null : h('button', {
        class: 'btn danger-text',
        onclick: guard(async () => {
          if (!await confirmBox({ title: `Remove ${u.name}?`, text: 'Their sign-in and share links are removed. Their files stay on this PC.', ok: 'Remove', danger: true })) return;
          await api('DELETE', `/api/users/${enc(u.name)}`);
          renderPeople();
        }),
      }, 'Remove')))),
    h('form', {
      class: 'card',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        await api('POST', '/api/users', { username: name.value, password: pass.value, admin: isAdmin.checked });
        toast('Account created');
        renderPeople();
      }),
    }, h('h2', {}, 'Add someone'),
    h('div', { class: 'form-row' }, name, pass),
    h('label', { class: 'check' }, isAdmin, 'Can manage people and remote access'),
    h('div', {}, h('button', { class: 'btn primary' }, 'Add account'))));
});

function twoStepCard() {
  const body = h('div', { class: 'gap' });
  const drawOff = () => {
    const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password' });
    body.replaceChildren(h('form', {
      class: 'gap',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        const { secret, uri } = await api('POST', '/api/account/2fa/begin', { password: password.value });
        drawEnroll(secret, uri);
      }),
    }, h('p', { class: 'muted' }, 'Adds a six-digit code from an authenticator app to every sign-in. Strongly recommended before opening Attic to the internet.'), password, h('div', {}, h('button', { class: 'btn primary' }, 'Set up'))));
  };
  const drawEnroll = (secret, uri) => {
    const code = h('input', { required: true, inputMode: 'numeric', pattern: '[0-9 ]{6,7}', autocomplete: 'one-time-code', placeholder: '6-digit code', 'aria-label': 'Six-digit code' });
    const pretty = secret.match(/.{1,4}/g).join(' ');
    body.replaceChildren(h('form', {
      class: 'gap',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        await api('POST', '/api/account/2fa/enable', { code: code.value });
        S.me.totp = true;
        toast('Two-step sign-in is on');
        renderSettings();
      }),
    },
    h('p', { class: 'muted' }, 'In your authenticator app (Google Authenticator, Authy, 1Password and others), add an account by setup key, then enter the code it shows.'),
    h('div', { class: 'secret' }, h('code', {}, pretty), h('button', { type: 'button', class: 'btn', onclick: () => copyText(secret) }, ic('copy'), 'Copy')),
    h('p', {}, h('a', { href: uri }, 'On this phone? Open in your authenticator')),
    code,
    h('div', {}, h('button', { class: 'btn primary' }, 'Turn on'))));
    code.focus();
  };
  const drawOn = () => {
    const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password' });
    const code = h('input', { required: true, inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', 'aria-label': 'Six-digit code' });
    body.replaceChildren(h('form', {
      class: 'gap',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        await api('POST', '/api/account/2fa/disable', { password: password.value, code: code.value });
        S.me.totp = false;
        toast('Two-step sign-in is off');
        renderSettings();
      }),
    }, h('p', {}, h('span', { class: 'pill good' }, 'On'), ' Your account asks for a code at each sign-in.'), h('div', { class: 'form-row' }, password, code), h('div', {}, h('button', { class: 'btn danger-text' }, 'Turn off'))));
  };
  if (S.me.totp) drawOn();
  else drawOff();
  return h('section', { class: 'card' }, h('h2', {}, 'Two-step sign-in'), body);
}

function describeAgent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown device';
  return `${browser} on ${os}`;
}

const renderSettings = guard(async () => {
  const token = ++renderToken;
  const { sessions } = await api('GET', '/api/account/sessions');
  if (token !== renderToken) return;
  const current = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password' });
  const next = h('input', { type: 'password', required: true, minLength: 12, autocomplete: 'new-password', placeholder: 'New password, 12+ characters', 'aria-label': 'New password' });
  page('Settings', `Signed in as ${S.me.name}.`,
    h('div', { class: 'stack' },
      twoStepCard(),
      h('form', {
        class: 'card',
        onsubmit: guard(async (e) => {
          e.preventDefault();
          await api('POST', '/api/account/password', { current: current.value, next: next.value });
          toast('Password changed. Other devices were signed out.');
          renderSettings();
        }),
      }, h('h2', {}, 'Password'), h('div', { class: 'form-row' }, current, next), h('div', {}, h('button', { class: 'btn primary' }, 'Change password'))),
      h('section', { class: 'card' }, h('h2', {}, 'Signed-in devices'),
        h('div', { class: 'device-list' }, sessions.map((s) => h('div', { class: 'device' },
          h('span', {}, describeAgent(s.ua)),
          h('span', { class: 'muted small num' }, s.current ? 'This device' : `${s.ip} · ${fmtDate(s.seen)}`)))),
        sessions.length > 1 ? h('div', {}, h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/account/sessions/revoke-others'); toast('Other devices signed out'); renderSettings(); }) }, 'Sign out other devices')) : null),
      h('div', {}, h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/logout'); boot(); }) }, 'Sign out'))));
});

// ---- Shell, routing, sign-in --------------------------------------------------------------

function currentRoute() {
  const [, name = 'files', ...rest] = location.hash.replace(/^#/, '').split('/');
  let decoded = '';
  try { decoded = rest.filter(Boolean).map(decodeURIComponent).join('/'); } catch { /* malformed link: go home */ }
  return { name: name || 'files', rest: decoded };
}

const VIEWS = { files: renderFiles, shared: renderShared, trash: renderTrash, remote: renderRemote, people: renderPeople, settings: renderSettings };

function navItem(name, icon, label) {
  return h('a', { href: `#/${name}${name === 'files' ? '/' : ''}`, class: 'nav-item', 'data-nav': name }, ic(icon), h('span', {}, label));
}

function route() {
  if (!mainEl) return;
  const { name } = currentRoute();
  S.selected.clear();
  if (name !== 'files') S.query = '';
  railEl.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  (VIEWS[name] || renderFiles)();
}

const refreshUsage = guard(async () => {
  if (!usageEl) return;
  const u = await api('GET', '/api/usage');
  const taken = u.total - u.free;
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${Math.min(100, (taken / u.total) * 100)}%`;
  usageEl.replaceChildren(
    h('div', { class: 'bar' }, fill),
    h('p', { class: 'small num' }, `${fmtSize(u.free)} free`),
    h('p', { class: 'muted small num' }, `Your files: ${fmtSize(u.used)}`));
});

function shell() {
  usageEl = h('div', { class: 'usage' });
  railEl = h('aside', { class: 'rail' },
    h('a', { href: '#/files/', class: 'rail-brand' }, brand()),
    h('nav', { class: 'nav' },
      navItem('files', 'folder', 'Files'),
      navItem('shared', 'share', 'Shared'),
      navItem('trash', 'trash', 'Trash'),
      S.me.admin ? navItem('remote', 'globe', 'Remote') : null,
      S.me.admin ? navItem('people', 'people', 'People') : null,
      navItem('settings', 'gear', 'Settings')),
    usageEl);
  mainEl = h('main', { class: 'main' });
  const dropHint = h('div', { class: 'drop-hint', hidden: true }, h('div', {}, ic('upload', 'big'), h('p', {}, 'Drop to upload here')));
  app.replaceChildren(h('div', { class: 'layout' }, railEl, mainEl), dropHint);

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  app.ondragenter = (e) => {
    if (!hasFiles(e) || currentRoute().name !== 'files') return;
    e.preventDefault();
    depth++;
    dropHint.hidden = false;
  };
  app.ondragover = (e) => { if (hasFiles(e)) e.preventDefault(); };
  app.ondragleave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dropHint.hidden = true;
  };
  app.ondrop = guard(async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dropHint.hidden = true;
    if (currentRoute().name === 'files') queueFiles(await readDropped(e.dataTransfer.items), S.cwd);
  });
  route();
  refreshUsage();
}

function authScreen(title, intro, form) {
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, brand(), h('h1', {}, title), intro ? h('p', { class: 'muted' }, intro) : null, form)));
}

function showSetup(local) {
  authScreen('Almost ready', local
    ? 'Nobody can sign in yet. Copy attic.config.example.json to attic.config.json, list the allowed emails in "allowedEmails" (and yours in "adminEmails"), then restart Attic.'
    : 'This Attic has not been set up yet.', null);
}

function showLogin() {
  const user = h('input', { required: true, autocomplete: 'username', spellcheck: false, autocapitalize: 'off', 'aria-label': 'Username' });
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', 'aria-label': 'Password' });
  const code = h('input', { inputMode: 'numeric', autocomplete: 'one-time-code', 'aria-label': 'Six-digit code' });
  const codeField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Code from your authenticator'), code);
  const error = h('p', { class: 'error', hidden: true });
  authScreen('Welcome back', null, h('form', {
    class: 'gap',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const res = await api('POST', '/api/login', { username: user.value, password: pass.value, code: code.value || undefined });
        if (res.needsCode) {
          codeField.hidden = false;
          code.required = true;
          code.focus();
          return;
        }
        boot();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  }, h('label', { class: 'field' }, h('span', {}, 'Username'), user), h('label', { class: 'field' }, h('span', {}, 'Password'), pass), codeField, error, h('button', { class: 'btn primary wide' }, 'Sign in')));
  user.focus();
}

async function boot() {
  mainEl = null;
  usageEl = null;
  try {
    const me = await api('GET', '/api/me');
    S.me = me.user;
    if (me.setupNeeded) showSetup(me.local);
    else if (!me.user) showLogin();
    else shell();
  } catch (err) {
    authScreen('Cannot reach Attic', err.message, h('button', { class: 'btn primary', onclick: boot }, 'Try again'));
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.selected.size && !document.querySelector('dialog')) {
    S.selected.clear();
    drawListBody();
  }
});
boot();
