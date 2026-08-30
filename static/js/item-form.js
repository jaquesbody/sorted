/* =============================================================================
   item-form.js
   Shared add/edit logic for Spend, Due, Savings, driven by URL params:
   item.html?type=spend|due|savings&id=<id>  (id omitted = add mode)
   Depends on: db.js, utils.js, categories.js
   ============================================================================= */

const FIELD_SETS = {
  spend: ['photo-capture-link', 'date-spend', 'amount', 'category', 'recurring', 'confirmed'],
  due: ['photo-capture-link', 'date-due', 'amount', 'category', 'recurring'],
  savings: ['category', 'current', 'target'],
};

const LIST_PAGE = {
  spend: 'spend.html',
  due: 'due.html',
  savings: 'savings.html',
};

const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'spend';
const editId = params.get('id') ? Number(params.get('id')) : null;

function showFields(type) {
  document.querySelectorAll('[data-field]').forEach((el) => {
    el.style.display = 'none';
  });
  FIELD_SETS[type].forEach((fieldName) => {
    const el = document.querySelector(`[data-field="${fieldName}"]`);
    if (el) el.style.display = '';
  });
}

function populateCategories() {
  const select = document.getElementById('category');
  select.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function toggleFrequencyField() {
  const recurringChecked = document.getElementById('recurring').checked;
  const freqField = document.querySelector('[data-field="frequency"]');
  if (freqField) {
    freqField.style.display = (recurringChecked && FIELD_SETS[type].includes('recurring')) ? '' : 'none';
  }
}

async function populateForEdit() {
  const items = await getAll(type);
  const item = items.find((i) => i.id === editId);
  if (!item) return;

  document.getElementById('title').value = item.title || '';
  if (item.date) document.getElementById('date').value = item.date;
  if (item.dueDate) document.getElementById('dueDate').value = item.dueDate;
  if (item.amount !== undefined) document.getElementById('amount').value = item.amount;
  if (item.category) document.getElementById('category').value = item.category;
  if (item.recurring !== undefined) document.getElementById('recurring').checked = item.recurring;
  if (item.frequency) document.getElementById('frequency').value = item.frequency;
  if (item.confirmed !== undefined) document.getElementById('confirmed').checked = item.confirmed;
  if (item.current !== undefined) document.getElementById('current').value = item.current;
  if (item.target !== undefined) document.getElementById('target').value = item.target;

  toggleFrequencyField();
  document.getElementById('delete-btn').style.display = '';
}

function buildItemFromForm() {
  const base = {
    title: document.getElementById('title').value.trim(),
  };

  if (type === 'spend') {
    return {
      ...base,
      date: document.getElementById('date').value || new Date().toISOString().slice(0, 10),
      amount: parseFloat(document.getElementById('amount').value) || 0,
      category: document.getElementById('category').value,
      recurring: document.getElementById('recurring').checked,
      frequency: document.getElementById('recurring').checked ? document.getElementById('frequency').value : null,
      confirmed: document.getElementById('confirmed').checked,
      paid: true,
    };
  }

  if (type === 'due') {
    return {
      ...base,
      dueDate: document.getElementById('dueDate').value || new Date().toISOString().slice(0, 10),
      amount: parseFloat(document.getElementById('amount').value) || 0,
      category: document.getElementById('category').value,
      recurring: document.getElementById('recurring').checked,
      frequency: document.getElementById('recurring').checked ? document.getElementById('frequency').value : null,
    };
  }

  // savings
  return {
    ...base,
    category: document.getElementById('category').value,
    current: parseFloat(document.getElementById('current').value) || 0,
    target: parseFloat(document.getElementById('target').value) || 0,
  };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function readFileAsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function handleCameraCapture(file) {
  const timestamp = Date.now();
  const ext = file.name.split('.').pop() || 'jpg';

  const sidecar = {
    type: 'receipt-capture',
    target: type,
    capturedAt: new Date().toISOString(),
    imageFile: `receipt-${timestamp}.${ext}`,
    status: 'pending-ocr',
  };

  triggerDownload(file, `SortedCaptures/receipt-${timestamp}.${ext}`);
  triggerDownload(new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' }), `SortedCaptures/receipt-${timestamp}.json`);

  alert('Saved to Downloads/SortedCaptures — use the paperclip to import it once synced.');
}

async function importCaptureFiles(fileList) {
  let imported = 0;
  let skipped = 0;

  for (const file of fileList) {
    let data;
    try {
      data = await readFileAsJSON(file);
    } catch (err) {
      skipped++;
      continue;
    }

    const targetStore = data.target || 'spend';

    if (data.type === 'manual-capture') {
      await addItem(targetStore, {
        title: data.title,
        amount: data.amount,
        category: data.category,
        date: data.date,
        recurring: data.recurring || false,
        frequency: data.frequency || null,
        confirmed: data.confirmed || false,
        paid: true,
      });
      imported++;
    } else if (data.type === 'receipt-capture') {
      const captureDate = data.capturedAt ? data.capturedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
      if (targetStore === 'due') {
        await addItem('due', {
          title: 'Bill (needs review — no OCR yet)',
          amount: 0,
          category: data.category || 'Other',
          dueDate: captureDate,
          recurring: false,
          frequency: null,
        });
      } else {
        await addItem('spend', {
          title: 'Receipt (needs review — no OCR yet)',
          amount: 0,
          category: data.category || 'Other',
          date: captureDate,
          recurring: false,
          frequency: null,
          confirmed: false,
          paid: true,
        });
      }
      imported++;
    } else {
      skipped++;
    }
  }

  alert(`Imported ${imported} item(s).${skipped > 0 ? ` Skipped ${skipped} unrecognised file(s).` : ''}`);
  if (imported > 0) window.location.href = LIST_PAGE[type];
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('back-link').href = LIST_PAGE[type];
  document.getElementById('form-title').textContent =
    (editId ? 'Edit ' : 'Add ') + type.charAt(0).toUpperCase() + type.slice(1);

  showFields(type);
  populateCategories();

  if (editId) {
    const photoLinkField = document.querySelector('[data-field="photo-capture-link"]');
    if (photoLinkField) photoLinkField.style.display = 'none';
  }

  document.getElementById('recurring').addEventListener('change', toggleFrequencyField);
  toggleFrequencyField();

  if (editId) {
    await populateForEdit();
  }

  const importBtn = document.getElementById('import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      document.getElementById('import-input').click();
    });
    document.getElementById('import-input').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        importCaptureFiles(e.target.files);
        e.target.value = '';
      }
    });
  }

  const cameraBtn = document.getElementById('camera-btn');
  if (cameraBtn) {
    cameraBtn.addEventListener('click', () => {
      document.getElementById('camera-input').click();
    });
    document.getElementById('camera-input').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleCameraCapture(e.target.files[0]);
        e.target.value = '';
      }
    });
  }

  document.getElementById('item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = buildItemFromForm();

    if (editId) {
      item.id = editId;
      await updateItem(type, item);
    } else {
      await addItem(type, item);
    }

    window.location.href = LIST_PAGE[type];
  });

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this item?')) return;
    await deleteItem(type, editId);
    window.location.href = LIST_PAGE[type];
  });
});
