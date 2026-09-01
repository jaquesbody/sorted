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

function setDateFieldToToday() {
  const today = new Date().toISOString().slice(0, 10);
  const dateField = document.getElementById('date');
  const dueDateField = document.getElementById('dueDate');
  if (dateField) dateField.value = today;
  if (dueDateField) dueDateField.value = today;
}

function clearStatusAfterDelay(status, delay = 3000) {
  setTimeout(() => { status.textContent = ''; }, delay);
}

async function handleCameraCapture(file) {
  const cameraBtn = document.getElementById('camera-btn');
  const status = document.getElementById('ocr-status');
  cameraBtn.disabled = true;
  const originalHTML = cameraBtn.innerHTML;
  cameraBtn.innerHTML = '...';

  const timestamp = Date.now();
  const ext = file.name.split('.').pop() || 'jpg';
  triggerDownload(file, `SortedCaptures/receipt-${timestamp}.${ext}`);

  try {
    const text = await runOCRWithTimeout(file, (msg) => { status.textContent = msg; });
    document.getElementById('title').value = guessTitleFromText(text);
    document.getElementById('amount').value = guessAmountFromText(text);
    setDateFieldToToday();
    status.textContent = 'Done — check the fields above.';
    clearStatusAfterDelay(status);
  } catch (err) {
    console.error('OCR failed:', err);
    document.getElementById('title').value = `OCR failed: ${err.message || err} — enter manually`;
    status.textContent = `Failed: ${err.message || err}`;
  } finally {
    cameraBtn.disabled = false;
    cameraBtn.innerHTML = originalHTML;
  }
}

async function runDirectImport(file) {
  const status = document.getElementById('ocr-status');

  try {
    let imageBlob = file;

    if (isPDF(file)) {
      if (status) status.textContent = 'Converting PDF page 1...';
      imageBlob = await pdfFirstPageToImageBlob(file);
    }

    const text = await runOCRWithTimeout(imageBlob, (msg) => { if (status) status.textContent = msg; });
    document.getElementById('title').value = guessTitleFromText(text);
    document.getElementById('amount').value = guessAmountFromText(text);
    setDateFieldToToday();
    if (status) {
      status.textContent = 'Done — check the fields above.';
      clearStatusAfterDelay(status);
    }
  } catch (err) {
    console.error('Direct import failed:', err);
    document.getElementById('title').value = `Import failed: ${err.message || err} — enter manually`;
    if (status) status.textContent = `Failed: ${err.message || err}`;
  }
}

async function importCaptureFiles(fileList) {
  const files = Array.from(fileList);
  const jsonFile = files.find((f) => f.name.endsWith('.json'));
  const imageFile = files.find((f) => !f.name.endsWith('.json'));

  // No sidecar present — treat as a direct import of a plain photo,
  // screenshot, or PDF bill, none of which come from our own capture flow.
  if (!jsonFile && imageFile) {
    await runDirectImport(imageFile);
    return;
  }

  if (!jsonFile) {
    alert('Select an image, a PDF, or a .json capture file (with its matching image).');
    return;
  }

  let data;
  try {
    data = await readFileAsJSON(jsonFile);
  } catch (err) {
    alert('Could not read that file — is it a valid Sorted capture file?');
    return;
  }

  if (data.type === 'manual-capture') {
    document.getElementById('title').value = data.title;
    document.getElementById('amount').value = data.amount;
    if (data.category) document.getElementById('category').value = data.category;
    return;
  }

  if (data.type === 'receipt-capture') {
    if (!imageFile) {
      alert('This is a receipt capture — also select its matching image file to run OCR.');
      return;
    }
    const status = document.getElementById('ocr-status');
    try {
      const text = await runOCRWithTimeout(imageFile, (msg) => { if (status) status.textContent = msg; });
      document.getElementById('title').value = guessTitleFromText(text);
      document.getElementById('amount').value = guessAmountFromText(text);
      if (data.category) document.getElementById('category').value = data.category;
      setDateFieldToToday();
      if (status) {
        status.textContent = 'Done — check the fields above.';
        clearStatusAfterDelay(status);
      }
    } catch (err) {
      console.error('OCR failed:', err);
      alert(`OCR failed: ${err.message || err} — enter details manually.`);
      if (status) status.textContent = `Failed: ${err.message || err}`;
    }
    return;
  }

  alert('Unrecognised file type.');
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
        importBtn.disabled = true;
        const originalHTML = importBtn.innerHTML;
        importBtn.innerHTML = '...';
        importCaptureFiles(e.target.files).finally(() => {
          importBtn.disabled = false;
          importBtn.innerHTML = originalHTML;
        });
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
