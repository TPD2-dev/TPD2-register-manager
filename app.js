(() => {
  'use strict';

  const RECORD_SIZE = 64;
  const DESC_START = 9;
  const DESC_LENGTH = 20;
  const GROUP_START = 29;
  const STATUS_OFFSET = 31;
  const PRICE_START = 55;
  const PRICE_LENGTH = 3;
  const PAGE_SIZE = 75;

  const state = {
    sourceFileName: '',
    sourceZip: null,
    sourceEntries: new Map(),
    profiles: [],
    profileRoot: '',
    profileDisplayName: '',
    firmware: '',
    originalPlu: null,
    workingPlu: null,
    products: [],
    groups: new Map(),
    statuses: new Map(),
    changes: new Map(),
    filtered: [],
    page: 1,
    currentEditIndex: null,
    deferredInstallPrompt: null,
    lastValidationReport: '',
    lastValidationFilename: ''
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    zipInput: $('zipInput'), openFolderBtn: $('openFolderBtn'), welcomePanel: $('welcomePanel'), workspace: $('workspace'),
    profileName: $('profileName'), firmwareText: $('firmwareText'), recordCount: $('recordCount'), changeCount: $('changeCount'), changePill: $('changePill'),
    searchInput: $('searchInput'), showBlankToggle: $('showBlankToggle'), exportCsvBtn: $('exportCsvBtn'), resultSummary: $('resultSummary'), productList: $('productList'),
    prevPageBtn: $('prevPageBtn'), nextPageBtn: $('nextPageBtn'), pageText: $('pageText'), changesList: $('changesList'), undoAllBtn: $('undoAllBtn'),
    outputProfileName: $('outputProfileName'), confirmFresh: $('confirmFresh'), confirmRollback: $('confirmRollback'), confirmTest: $('confirmTest'),
    createBackupBtn: $('createBackupBtn'), exportProgress: $('exportProgress'), progressFill: $('progressFill'), progressText: $('progressText'), validationResult: $('validationResult'),
    downloadReportBtn: $('downloadReportBtn'), resetBtn: $('resetBtn'), installBtn: $('installBtn'),
    profileDialog: $('profileDialog'), profileChoices: $('profileChoices'), editDialog: $('editDialog'), editForm: $('editForm'), closeEditBtn: $('closeEditBtn'),
    editBarcode: $('editBarcode'), editGroup: $('editGroup'), editStatus: $('editStatus'), editRecord: $('editRecord'), editDescription: $('editDescription'), descCount: $('descCount'),
    editPrice: $('editPrice'), editError: $('editError'), undoItemBtn: $('undoItemBtn'), toast: $('toast')
  };

  function normalizePath(path) { return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''); }
  function basename(path) { const p = normalizePath(path); return p.slice(p.lastIndexOf('/') + 1); }
  function dirname(path) { const p = normalizePath(path); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }
  function relPath(root, full) { return normalizePath(full).slice(normalizePath(root).length).replace(/^\//, ''); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function showToast(message, duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.add('hidden'), duration);
  }

  function setProgress(percent, message) {
    els.exportProgress.classList.remove('hidden');
    els.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    els.progressText.textContent = message;
  }

  function hideProgress() {
    els.exportProgress.classList.add('hidden');
    els.progressFill.style.width = '0%';
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function bcdDigits(bytes) {
    let out = '';
    for (const byte of bytes) {
      const hi = byte >> 4;
      const lo = byte & 0x0f;
      if (hi > 9 || lo > 9) return null;
      out += String(hi) + String(lo);
    }
    return out;
  }

  function decodeBcdByte(byte) {
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    return (hi <= 9 && lo <= 9) ? (hi * 10 + lo) : byte;
  }

  function decodeCode(record) {
    const digits = bcdDigits(record.subarray(0, 9));
    if (!digits) return `HEX-${Array.from(record.subarray(0, 9), b => b.toString(16).padStart(2, '0')).join('')}`;
    return digits.replace(/^0+/, '') || '0';
  }

  function decodeDescription(record) {
    let out = '';
    for (let i = DESC_START; i < DESC_START + DESC_LENGTH; i++) {
      const b = record[i];
      if (b === 0) continue;
      if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    }
    return out.replace(/\s+$/, '');
  }

  function decodePrice(record) {
    const digits = bcdDigits(record.subarray(PRICE_START, PRICE_START + PRICE_LENGTH));
    return digits ? Number.parseInt(digits, 10) / 100 : NaN;
  }

  function encodePriceToBytes(value) {
    const cents = Math.round(value * 100);
    if (!Number.isInteger(cents) || cents < 0 || cents > 999999) throw new Error('Price must be between $0.00 and $9,999.99.');
    const digits = String(cents).padStart(6, '0');
    return new Uint8Array([
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16)
    ]);
  }

  function encodeDescriptionToBytes(value) {
    if (value.length > DESC_LENGTH) throw new Error('Description is limited to 20 characters.');
    const bytes = new Uint8Array(DESC_LENGTH);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 || code > 126) throw new Error('Use standard printable English characters only in this test build.');
      bytes[i] = code;
    }
    return bytes;
  }

  function decodeNameTable(bytes, recordSize) {
    const map = new Map();
    if (!bytes || bytes.length < recordSize) return map;
    const count = Math.floor(bytes.length / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = bytes.subarray(i * recordSize, (i + 1) * recordSize);
      let name = '';
      for (let j = 0; j < Math.min(12, rec.length); j++) {
        const b = rec[j];
        if (b >= 32 && b <= 126) name += String.fromCharCode(b);
      }
      map.set(i + 1, name.trimEnd());
    }
    return map;
  }

  function parseProducts(pluBytes) {
    if (pluBytes.length % RECORD_SIZE !== 0) throw new Error(`PLU.pgm size ${pluBytes.length.toLocaleString()} is not divisible by ${RECORD_SIZE}.`);
    const count = pluBytes.length / RECORD_SIZE;
    const products = new Array(count);
    for (let index = 0; index < count; index++) {
      const rec = pluBytes.subarray(index * RECORD_SIZE, (index + 1) * RECORD_SIZE);
      const groupNumber = rec[GROUP_START] | (rec[GROUP_START + 1] << 8);
      const statusNumber = decodeBcdByte(rec[STATUS_OFFSET]);
      const description = decodeDescription(rec);
      const price = decodePrice(rec);
      const code = decodeCode(rec);
      const groupName = state.groups.get(groupNumber) || '';
      const statusName = state.statuses.get(statusNumber) || '';
      products[index] = {
        index,
        recordNumber: index + 1,
        code,
        description,
        originalDescription: description,
        price,
        originalPrice: price,
        groupNumber,
        groupName,
        statusNumber,
        statusName,
        search: `${code} ${description} ${groupNumber} ${groupName} ${statusNumber} ${statusName}`.toLowerCase()
      };
    }
    return products;
  }

  function findEntryName(fileName) {
    const target = normalizePath(`${state.profileRoot}/${fileName}`).toLowerCase();
    for (const name of state.sourceEntries.keys()) {
      if (normalizePath(name).toLowerCase() === target) return name;
    }
    return null;
  }

  async function entryBytes(fileName, required = false) {
    const name = findEntryName(fileName);
    if (!name) {
      if (required) throw new Error(`${fileName} was not found in the selected profile.`);
      return null;
    }
    return state.sourceEntries.get(name).async('uint8array');
  }

  async function entryText(fileName) {
    const name = findEntryName(fileName);
    if (!name) return '';
    return state.sourceEntries.get(name).async('text');
  }

  function detectProfiles(zip) {
    const profiles = [];
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (basename(name).toLowerCase() === 'plu.pgm') {
        const root = dirname(name);
        profiles.push({ root, displayName: basename(root) || root, pluEntry: name });
      }
    }
    const seen = new Set();
    return profiles.filter(p => {
      const key = p.root.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function openZipFile(file) {
    try {
      if (!window.JSZip) throw new Error('ZIP engine did not load. Reload the app and try again.');
      els.zipInput.value = '';
      showToast('Opening backup…', 1200);
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
      const profiles = detectProfiles(zip);
      if (!profiles.length) throw new Error('No PLU.pgm file was found. Select a ZIP created from an SPS-530 program backup.');
      state.sourceFileName = file.name;
      state.sourceZip = zip;
      state.sourceEntries = new Map(Object.entries(zip.files));
      state.profiles = profiles;
      if (profiles.length === 1) {
        await loadProfile(profiles[0]);
      } else {
        showProfilePicker(profiles);
      }
    } catch (error) {
      console.error(error);
      alert(`Could not open this backup:\n\n${error.message}`);
    }
  }

  async function openExtractedFolder() {
    if (!window.showDirectoryPicker) {
      alert('Folder access is not supported in this browser. On iPhone or iPad, select the backup ZIP instead.');
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      const zip = new JSZip();
      async function walk(handle, prefix = '') {
        for await (const [name, child] of handle.entries()) {
          const path = prefix ? `${prefix}/${name}` : name;
          if (child.kind === 'directory') await walk(child, path);
          else {
            const file = await child.getFile();
            zip.file(path, await file.arrayBuffer(), { date: file.lastModified ? new Date(file.lastModified) : new Date() });
          }
        }
      }
      await walk(dirHandle, dirHandle.name);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      await openZipFile(new File([blob], `${dirHandle.name}.zip`, { type: 'application/zip' }));
    } catch (error) {
      if (error.name !== 'AbortError') alert(`Could not open folder:\n\n${error.message}`);
    }
  }

  function showProfilePicker(profiles) {
    els.profileChoices.innerHTML = '';
    for (const profile of profiles) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-choice';
      button.innerHTML = `<strong>${safeText(profile.displayName)}</strong><span>${safeText(profile.root)}</span>`;
      button.addEventListener('click', async () => {
        els.profileDialog.close();
        await loadProfile(profile);
      });
      els.profileChoices.appendChild(button);
    }
    els.profileDialog.showModal();
  }

  function suggestOutputName(profileName) {
    const upper = profileName.toUpperCase();
    if (upper.includes('2')) return 'TP2EDIT';
    if (upper.includes('1')) return 'TP1EDIT';
    return 'EDIT1';
  }

  async function loadProfile(profile) {
    try {
      showToast(`Loading ${profile.displayName}…`, 1400);
      state.profileRoot = normalizePath(profile.root);
      state.profileDisplayName = profile.displayName;
      state.changes.clear();
      state.page = 1;
      state.lastValidationReport = '';
      state.lastValidationFilename = '';

      const [plu, group, statuses, version] = await Promise.all([
        entryBytes('PLU.pgm', true),
        entryBytes('GROUP.pgm'),
        entryBytes('PLU_ST.pgm'),
        entryText('version.txt')
      ]);

      state.groups = decodeNameTable(group, 16);
      state.statuses = decodeNameTable(statuses, 44);
      state.originalPlu = new Uint8Array(plu);
      state.workingPlu = new Uint8Array(plu);
      state.firmware = version.trim() || 'Not listed';
      state.products = parseProducts(state.workingPlu);

      els.profileName.textContent = state.profileDisplayName;
      els.firmwareText.textContent = state.firmware.replace(/\s+/g, ' ');
      els.recordCount.textContent = state.products.length.toLocaleString();
      els.outputProfileName.value = suggestOutputName(state.profileDisplayName);
      els.searchInput.value = '';
      els.showBlankToggle.checked = false;
      els.confirmFresh.checked = false;
      els.confirmRollback.checked = false;
      els.confirmTest.checked = false;
      els.validationResult.className = 'validation-result hidden';
      els.downloadReportBtn.classList.add('hidden');

      els.welcomePanel.classList.add('hidden');
      els.workspace.classList.remove('hidden');
      updateCounts();
      applyFilter();
      renderChanges();
      switchTab('products');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showToast(`Loaded ${state.products.length.toLocaleString()} PLU records.`);
    } catch (error) {
      console.error(error);
      alert(`Could not load this profile:\n\n${error.message}`);
      resetState();
    }
  }

  function updateCounts() {
    const count = state.changes.size;
    els.changeCount.textContent = count.toLocaleString();
    els.changePill.textContent = count.toLocaleString();
    els.undoAllBtn.disabled = count === 0;
    els.createBackupBtn.disabled = count === 0;
  }

  function applyFilter() {
    const query = els.searchInput.value.trim().toLowerCase();
    const showBlank = els.showBlankToggle.checked;
    state.filtered = [];
    for (const product of state.products) {
      if (!showBlank && !query && !product.description) continue;
      if (query && !product.search.includes(query)) continue;
      state.filtered.push(product.index);
    }
    state.page = 1;
    renderProducts();
  }

  function renderProducts() {
    const total = state.filtered.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, pages));
    const start = (state.page - 1) * PAGE_SIZE;
    const slice = state.filtered.slice(start, start + PAGE_SIZE);
    els.resultSummary.textContent = `${total.toLocaleString()} matching records · showing ${total ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, total).toLocaleString()}`;
    els.pageText.textContent = `Page ${state.page.toLocaleString()} of ${pages.toLocaleString()}`;
    els.prevPageBtn.disabled = state.page <= 1;
    els.nextPageBtn.disabled = state.page >= pages;

    if (!slice.length) {
      els.productList.innerHTML = '<div class="empty-state">No matching PLUs were found.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const index of slice) {
      const product = state.products[index];
      const changed = state.changes.has(index);
      const row = document.createElement('article');
      row.className = 'product-row';
      row.innerHTML = `
        <div class="product-main">
          <strong>${safeText(product.description || '(blank description)')}${changed ? '<span class="edited-tag">Edited</span>' : ''}</strong>
          <code>${safeText(product.code)}</code>
        </div>
        <div class="product-meta group-cell"><span>Group</span><strong>${safeText(product.groupName || `#${product.groupNumber}`)}</strong></div>
        <div class="product-meta status-cell"><span>Status</span><strong>${safeText(product.statusName || `#${product.statusNumber}`)}</strong></div>
        <div class="product-meta"><span>Price</span><strong class="price">${Number.isFinite(product.price) ? `$${product.price.toFixed(2)}` : 'Invalid'}</strong></div>
        <button class="edit-row-btn" type="button" aria-label="Edit ${safeText(product.code)}">✎</button>`;
      row.querySelector('button').addEventListener('click', () => openEdit(index));
      fragment.appendChild(row);
    }
    els.productList.replaceChildren(fragment);
  }

  function openEdit(index) {
    const product = state.products[index];
    state.currentEditIndex = index;
    els.editBarcode.textContent = product.code;
    els.editGroup.textContent = product.groupName || `#${product.groupNumber}`;
    els.editStatus.textContent = product.statusName || `#${product.statusNumber}`;
    els.editRecord.textContent = product.recordNumber.toLocaleString();
    els.editDescription.value = product.description;
    els.descCount.textContent = String(product.description.length);
    els.editPrice.value = Number.isFinite(product.price) ? product.price.toFixed(2) : '';
    els.editError.classList.add('hidden');
    els.undoItemBtn.classList.toggle('hidden', !state.changes.has(index));
    els.editDialog.showModal();
    setTimeout(() => els.editDescription.focus(), 80);
  }

  function closeEdit() {
    if (els.editDialog.open) els.editDialog.close();
    state.currentEditIndex = null;
  }

  function writeRecordFields(index, description, price) {
    const offset = index * RECORD_SIZE;
    const descBytes = encodeDescriptionToBytes(description);
    const priceBytes = encodePriceToBytes(price);
    state.workingPlu.set(descBytes, offset + DESC_START);
    state.workingPlu.set(priceBytes, offset + PRICE_START);
  }

  function restoreRecordFields(index) {
    const offset = index * RECORD_SIZE;
    state.workingPlu.set(state.originalPlu.subarray(offset + DESC_START, offset + DESC_START + DESC_LENGTH), offset + DESC_START);
    state.workingPlu.set(state.originalPlu.subarray(offset + PRICE_START, offset + PRICE_START + PRICE_LENGTH), offset + PRICE_START);
  }

  function saveEdit(event) {
    event.preventDefault();
    const index = state.currentEditIndex;
    if (index == null) return;
    const product = state.products[index];
    const description = els.editDescription.value.trimEnd();
    const priceText = els.editPrice.value.trim().replace(/^\$/, '');
    try {
      if (!/^\d{1,4}(?:\.\d{0,2})?$/.test(priceText)) throw new Error('Enter a price from 0.00 to 9999.99 with no more than two decimal places.');
      const price = Number.parseFloat(priceText);
      encodeDescriptionToBytes(description);
      encodePriceToBytes(price);

      const sameDesc = description === product.originalDescription;
      const samePrice = Math.round(price * 100) === Math.round(product.originalPrice * 100);
      if (sameDesc && samePrice) {
        restoreRecordFields(index);
        product.description = product.originalDescription;
        product.price = product.originalPrice;
        product.search = `${product.code} ${product.description} ${product.groupNumber} ${product.groupName} ${product.statusNumber} ${product.statusName}`.toLowerCase();
        state.changes.delete(index);
      } else {
        writeRecordFields(index, description, price);
        product.description = description;
        product.price = price;
        product.search = `${product.code} ${description} ${product.groupNumber} ${product.groupName} ${product.statusNumber} ${product.statusName}`.toLowerCase();
        state.changes.set(index, {
          index,
          recordNumber: product.recordNumber,
          code: product.code,
          oldDescription: product.originalDescription,
          newDescription: description,
          oldPrice: product.originalPrice,
          newPrice: price
        });
      }
      updateCounts();
      renderProducts();
      renderChanges();
      closeEdit();
      showToast(state.changes.has(index) ? 'Change saved locally.' : 'Item returned to original values.');
    } catch (error) {
      els.editError.textContent = error.message;
      els.editError.classList.remove('hidden');
    }
  }

  function undoItem(index) {
    const product = state.products[index];
    restoreRecordFields(index);
    product.description = product.originalDescription;
    product.price = product.originalPrice;
    product.search = `${product.code} ${product.description} ${product.groupNumber} ${product.groupName} ${product.statusNumber} ${product.statusName}`.toLowerCase();
    state.changes.delete(index);
    updateCounts();
    renderProducts();
    renderChanges();
  }

  function renderChanges() {
    const changes = Array.from(state.changes.values()).sort((a, b) => a.recordNumber - b.recordNumber);
    if (!changes.length) {
      els.changesList.innerHTML = '<div class="empty-state">No pending changes. Edit a product description or price first.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const change of changes) {
      const card = document.createElement('article');
      card.className = 'change-card';
      const descChanged = change.oldDescription !== change.newDescription;
      const priceChanged = Math.round(change.oldPrice * 100) !== Math.round(change.newPrice * 100);
      card.innerHTML = `
        <div><h3>${safeText(change.code)}</h3><code>Record ${change.recordNumber.toLocaleString()}</code></div>
        <div class="change-diffs">
          ${descChanged ? `<p class="diff-line">Name: <del>${safeText(change.oldDescription || '(blank)')}</del> → <ins>${safeText(change.newDescription || '(blank)')}</ins></p>` : ''}
          ${priceChanged ? `<p class="diff-line">Price: <del>$${change.oldPrice.toFixed(2)}</del> → <ins>$${change.newPrice.toFixed(2)}</ins></p>` : ''}
        </div>
        <button class="button secondary compact danger" type="button">Undo</button>`;
      card.querySelector('button').addEventListener('click', () => { undoItem(change.index); showToast('Change undone.'); });
      fragment.appendChild(card);
    }
    els.changesList.replaceChildren(fragment);
  }

  function undoAll() {
    if (!state.changes.size) return;
    if (!confirm(`Undo all ${state.changes.size.toLocaleString()} pending changes?`)) return;
    for (const index of Array.from(state.changes.keys())) undoItem(index);
    showToast('All changes undone.');
  }

  function validateWorkingPlu() {
    if (!state.originalPlu || !state.workingPlu) throw new Error('No backup is open.');
    if (state.originalPlu.length !== state.workingPlu.length) throw new Error('PLU.pgm file size changed. Export blocked.');
    const unexpected = [];
    let diffBytes = 0;
    const diffRecords = new Set();
    for (let i = 0; i < state.originalPlu.length; i++) {
      if (state.originalPlu[i] === state.workingPlu[i]) continue;
      diffBytes++;
      const recordIndex = Math.floor(i / RECORD_SIZE);
      const within = i % RECORD_SIZE;
      const allowedField = (within >= DESC_START && within < DESC_START + DESC_LENGTH) || (within >= PRICE_START && within < PRICE_START + PRICE_LENGTH);
      if (!allowedField || !state.changes.has(recordIndex)) {
        if (unexpected.length < 12) unexpected.push({ offset: i, record: recordIndex + 1, within });
      }
      diffRecords.add(recordIndex);
    }
    if (unexpected.length) {
      throw new Error(`Unexpected byte changes were found. First unexpected change: file offset ${unexpected[0].offset}, record ${unexpected[0].record}, record byte ${unexpected[0].within}. Export blocked.`);
    }
    for (const recordIndex of diffRecords) {
      if (!state.changes.has(recordIndex)) throw new Error(`Record ${recordIndex + 1} changed but is not in the change log.`);
    }
    for (const [recordIndex, change] of state.changes) {
      const rec = state.workingPlu.subarray(recordIndex * RECORD_SIZE, (recordIndex + 1) * RECORD_SIZE);
      const code = decodeCode(rec);
      const desc = decodeDescription(rec);
      const price = decodePrice(rec);
      if (code !== change.code) throw new Error(`Barcode changed in record ${recordIndex + 1}. Export blocked.`);
      if (desc !== change.newDescription) throw new Error(`Description validation failed in record ${recordIndex + 1}.`);
      if (Math.round(price * 100) !== Math.round(change.newPrice * 100)) throw new Error(`Price validation failed in record ${recordIndex + 1}.`);
    }
    if (diffRecords.size !== state.changes.size) throw new Error('Change-count validation failed. Export blocked.');
    return { diffBytes, diffRecords: diffRecords.size };
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function sanitizeProfileName(value) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Enter a new profile folder name.');
    if (trimmed.length > 20) throw new Error('Keep the profile name at 20 characters or fewer.');
    if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) throw new Error('Profile name may contain only letters, numbers, spaces, underscore, or hyphen.');
    return trimmed;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function createBackup() {
    els.validationResult.className = 'validation-result hidden';
    els.downloadReportBtn.classList.add('hidden');
    try {
      if (!state.changes.size) throw new Error('Make at least one product change first.');
      if (!els.confirmFresh.checked || !els.confirmRollback.checked || !els.confirmTest.checked) throw new Error('Check all three safety confirmations before exporting.');
      const outputName = sanitizeProfileName(els.outputProfileName.value);
      els.createBackupBtn.disabled = true;
      setProgress(8, 'Validating changed PLU bytes…');
      await sleep(40);
      const validation = validateWorkingPlu();

      setProgress(25, 'Checking hashes…');
      const [originalHash, modifiedHash] = await Promise.all([sha256(state.originalPlu), sha256(state.workingPlu)]);
      if (originalHash === modifiedHash) throw new Error('The modified PLU hash matches the original. No actual change was detected.');

      setProgress(42, 'Copying the selected profile…');
      const outZip = new JSZip();
      const rootPrefix = `${normalizePath(state.profileRoot)}/`;
      let copiedFiles = 0;
      let nonPluFiles = 0;
      let originalNonPluBytes = 0;
      let copiedNonPluBytes = 0;
      const sourceNames = Array.from(state.sourceEntries.keys()).filter(name => {
        const normalized = normalizePath(name);
        return normalized === normalizePath(state.profileRoot) || normalized.startsWith(rootPrefix);
      });

      for (let n = 0; n < sourceNames.length; n++) {
        const sourceName = sourceNames[n];
        const entry = state.sourceEntries.get(sourceName);
        if (entry.dir) continue;
        const relative = relPath(state.profileRoot, sourceName);
        if (!relative) continue;
        const targetPath = `${outputName}/${relative}`;
        let bytes;
        if (basename(relative).toLowerCase() === 'plu.pgm') {
          bytes = state.workingPlu;
        } else {
          bytes = await entry.async('uint8array');
          nonPluFiles++;
          originalNonPluBytes += bytes.length;
          copiedNonPluBytes += bytes.length;
        }
        outZip.file(targetPath, bytes, { date: entry.date || new Date(), binary: true });
        copiedFiles++;
        if (n % 20 === 0) {
          setProgress(42 + Math.round((n / Math.max(1, sourceNames.length)) * 28), `Copying register files… ${n + 1}/${sourceNames.length}`);
          await sleep(0);
        }
      }
      if (!copiedFiles) throw new Error('No files were copied from the selected profile.');
      if (originalNonPluBytes !== copiedNonPluBytes) throw new Error('Non-PLU file copy validation failed.');

      setProgress(74, 'Compressing the replacement backup…');
      const blob = await outZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'DOS'
      }, metadata => setProgress(74 + Math.round(metadata.percent * .20), `Compressing… ${metadata.percent.toFixed(0)}%`));

      const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const zipFilename = `${outputName}_SPS530_EDIT_${dateStamp}.zip`;
      const changedRows = Array.from(state.changes.values()).sort((a,b) => a.recordNumber - b.recordNumber);
      const reportLines = [
        'TUPACKS SPS-530 MANAGER v0.2 — VALIDATION REPORT',
        `Created: ${new Date().toLocaleString()}`,
        `Source ZIP: ${state.sourceFileName}`,
        `Source profile: ${state.profileRoot}`,
        `Output profile: ${outputName}`,
        `Firmware text: ${state.firmware.replace(/\s+/g, ' ')}`,
        `PLU records: ${state.products.length}`,
        `Changed PLU records: ${validation.diffRecords}`,
        `Changed bytes inside PLU.pgm: ${validation.diffBytes}`,
        `Files copied into output profile: ${copiedFiles}`,
        `Non-PLU files copied without intentional edits: ${nonPluFiles}`,
        `Original PLU SHA-256: ${originalHash}`,
        `Modified PLU SHA-256: ${modifiedHash}`,
        '',
        'ALLOWED EDIT FIELDS:',
        '- Description: record bytes 9–28',
        '- Current price: record bytes 55–57',
        '',
        'CHANGES:'
      ];
      for (const c of changedRows) {
        reportLines.push(`Record ${c.recordNumber} | ${c.code} | Name: "${c.oldDescription}" -> "${c.newDescription}" | Price: $${c.oldPrice.toFixed(2)} -> $${c.newPrice.toFixed(2)}`);
      }
      reportLines.push('', 'IMPORTANT:', 'The ZIP contains one backup profile folder. Extract it before placing the profile folder on the register USB. Keep the untouched rollback backup. After restore, run PLU Integrity Check and test sales/taxes/tenders before normal use.');
      state.lastValidationReport = reportLines.join('\r\n');
      state.lastValidationFilename = `${outputName}_VALIDATION_${dateStamp}.txt`;

      setProgress(98, 'Starting download…');
      downloadBlob(blob, zipFilename);
      await sleep(200);
      setProgress(100, 'Backup created successfully.');
      els.validationResult.className = 'validation-result success';
      els.validationResult.innerHTML = `<strong>Validated backup created.</strong><br>${validation.diffRecords.toLocaleString()} PLU record(s) changed; ${validation.diffBytes.toLocaleString()} changed byte(s), all inside the proven description/price fields. The download is named <strong>${safeText(zipFilename)}</strong>.`;
      els.downloadReportBtn.classList.remove('hidden');
      showToast('Modified backup ZIP created.');
    } catch (error) {
      console.error(error);
      els.validationResult.className = 'validation-result error';
      els.validationResult.innerHTML = `<strong>Export blocked.</strong><br>${safeText(error.message)}`;
      showToast('Export blocked by validation.');
    } finally {
      els.createBackupBtn.disabled = state.changes.size === 0;
      setTimeout(hideProgress, 1200);
    }
  }

  function exportCsv() {
    if (!state.products.length) return;
    const rows = [['Record Number','PLU Barcode','Description','Current Price','Group Number','Group Name','Status Number','Status Name']];
    for (const p of state.products) {
      rows.push([p.recordNumber, p.code, p.description, Number.isFinite(p.price) ? p.price.toFixed(2) : '', p.groupNumber, p.groupName, p.statusNumber, p.statusName]);
    }
    const csv = rows.map(row => row.map(value => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',')).join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${state.profileDisplayName}_PLU_EXPORT.csv`);
    showToast('CSV export created.');
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${name}`));
    if (name === 'changes') renderChanges();
  }

  function resetState() {
    if (state.changes.size && !confirm('Close this backup and discard all pending changes?')) return;
    state.sourceFileName = '';
    state.sourceZip = null;
    state.sourceEntries.clear();
    state.profiles = [];
    state.profileRoot = '';
    state.profileDisplayName = '';
    state.firmware = '';
    state.originalPlu = null;
    state.workingPlu = null;
    state.products = [];
    state.groups.clear();
    state.statuses.clear();
    state.changes.clear();
    state.filtered = [];
    els.workspace.classList.add('hidden');
    els.welcomePanel.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function installHelp() {
    if (state.deferredInstallPrompt) {
      state.deferredInstallPrompt.prompt();
      state.deferredInstallPrompt.userChoice.finally(() => {
        state.deferredInstallPrompt = null;
        els.installBtn.classList.add('hidden');
      });
      return;
    }
    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isiOS) alert('On iPhone or iPad: open this site in Safari, tap the Share button, then tap “Add to Home Screen.”');
    else alert('Use your browser menu and choose “Install app” or “Create shortcut.”');
  }

  let filterTimer;
  els.zipInput.addEventListener('change', event => { const file = event.target.files?.[0]; if (file) openZipFile(file); });
  els.openFolderBtn.addEventListener('click', openExtractedFolder);
  els.searchInput.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilter, 120); });
  els.showBlankToggle.addEventListener('change', applyFilter);
  els.prevPageBtn.addEventListener('click', () => { state.page--; renderProducts(); window.scrollTo({ top: 150, behavior: 'smooth' }); });
  els.nextPageBtn.addEventListener('click', () => { state.page++; renderProducts(); window.scrollTo({ top: 150, behavior: 'smooth' }); });
  els.editDescription.addEventListener('input', () => { els.descCount.textContent = String(els.editDescription.value.length); });
  els.editForm.addEventListener('submit', saveEdit);
  els.closeEditBtn.addEventListener('click', closeEdit);
  els.undoItemBtn.addEventListener('click', () => { if (state.currentEditIndex != null) { undoItem(state.currentEditIndex); closeEdit(); showToast('Item change undone.'); } });
  els.undoAllBtn.addEventListener('click', undoAll);
  els.createBackupBtn.addEventListener('click', createBackup);
  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.downloadReportBtn.addEventListener('click', () => {
    if (!state.lastValidationReport) return;
    downloadBlob(new Blob([state.lastValidationReport], { type: 'text/plain;charset=utf-8' }), state.lastValidationFilename);
  });
  els.resetBtn.addEventListener('click', resetState);
  els.installBtn.addEventListener('click', installHelp);
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installBtn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => els.installBtn.classList.add('hidden'));

  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isiOS && !standalone) els.installBtn.classList.remove('hidden');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker not registered:', error));
  }
})();
