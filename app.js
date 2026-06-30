import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    doc,
    getDocs,
    setDoc,
    deleteDoc,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Configuración de Firebase para tu aplicación web
const firebaseConfig = {
  apiKey: "AIzaSyAaDWrSWsuED6fDZBAiN_tN2H--UA09TYI",
  authDomain: "bonitobazar-6adcc.firebaseapp.com",
  projectId: "bonitobazar-6adcc",
  storageBucket: "bonitobazar-6adcc.firebasestorage.app",
  messagingSenderId: "223695169986",
  appId: "1:223695169986:web:cf55b834ec034042ab0e5b"
};

// Inicializar Firebase
const firebaseApp = initializeApp(firebaseConfig);

// Inicializar Firestore con soporte multitestaña y persistencia offline
const firestoreDb = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

// ── ESTADO ──────────────────────────────────────────────────
let lists = [];                // todas las listas en memoria
let activeListId = null;       // ID de la lista activa
let products = [];             // productos de la lista activa
let pendingImage = null;       // imagen capturada esperando ser guardada
let editingImageBase64 = null; // imagen en el modal de edición

// ── BASE DE DATOS (Firebase Firestore) ────────────────────────
const db = {
    async open() {
        // Firestore se abre de forma transparente
        return true;
    },

    async getLists() {
        try {
            const querySnapshot = await getDocs(collection(firestoreDb, "listas"));
            const fetchedLists = [];
            querySnapshot.forEach((doc) => {
                fetchedLists.push(doc.data());
            });
            // Ordenar de más antiguas a más nuevas para mantener consistencia
            fetchedLists.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            return fetchedLists;
        } catch (err) {
            console.error("Error al obtener listas de Firestore:", err);
            throw err;
        }
    },

    async saveList(lista) {
        try {
            const docRef = doc(firestoreDb, "listas", lista.id);
            await setDoc(docRef, lista);
        } catch (err) {
            console.error("Error al guardar lista en Firestore:", err);
            throw err;
        }
    },

    async deleteList(id) {
        try {
            const docRef = doc(firestoreDb, "listas", id);
            await deleteDoc(docRef);
        } catch (err) {
            console.error("Error al eliminar lista de Firestore:", err);
            throw err;
        }
    },

    async getConfig(key) {
        return localStorage.getItem(`bonitobazar_${key}`);
    },

    async saveConfig(key, value) {
        if (value === null || value === undefined) {
            localStorage.removeItem(`bonitobazar_${key}`);
        } else {
            localStorage.setItem(`bonitobazar_${key}`, value);
        }
    },

    async restoreBackup(listsArray, activeId) {
        try {
            const querySnapshot = await getDocs(collection(firestoreDb, "listas"));
            const batch = writeBatch(firestoreDb);
            
            // Eliminar todas las listas de Firestore
            querySnapshot.forEach((d) => {
                batch.delete(doc(firestoreDb, "listas", d.id));
            });
            
            // Subir las listas restauradas
            listsArray.forEach((lista) => {
                const docRef = doc(firestoreDb, "listas", lista.id);
                batch.set(docRef, lista);
            });
            
            await batch.commit();
            
            if (activeId) {
                await this.saveConfig('activeListId', activeId);
            } else {
                await this.saveConfig('activeListId', null);
            }
        } catch (err) {
            console.error("Error al restaurar backup en Firestore:", err);
            throw err;
        }
    }
};

// Función auxiliar para migrar IndexedDB local (si existe) a Firestore la primera vez
async function migrateIndexedDBToFirestore() {
    return new Promise((resolve) => {
        const request = indexedDB.open('SubastaDB', 1);
        request.onsuccess = (e) => {
            const idbInstance = e.target.result;
            if (!idbInstance.objectStoreNames.contains('listas')) {
                idbInstance.close();
                resolve([]);
                return;
            }
            
            const tx = idbInstance.transaction('listas', 'readonly');
            const store = tx.objectStore('listas');
            const getAllReq = store.getAll();
            
            getAllReq.onsuccess = () => {
                const localLists = getAllReq.result || [];
                idbInstance.close();
                resolve(localLists);
            };
            getAllReq.onerror = () => {
                idbInstance.close();
                resolve([]);
            };
        };
        request.onerror = () => {
            resolve([]);
        };
    });
}

// ── PERSISTENCIA Y MIGRACIÓN ─────────────────────────────────
async function loadFromStorage() {
    try {
        // Cargar listas e ID activo
        lists = await db.getLists();
        activeListId = await db.getConfig('activeListId');

        // Lógica de migración si Firestore está vacío pero el usuario tiene IndexedDB local
        if (lists.length === 0) {
            const localLists = await migrateIndexedDBToFirestore();
            if (localLists.length > 0) {
                showToast('info', `Migrando ${localLists.length} lista(s) locales a la nube...`);
                for (const localList of localLists) {
                    await db.saveList(localList);
                }
                // Recargar desde Firestore tras migrar
                lists = await db.getLists();
                showToast('success', '¡Tus listas locales se migraron a la nube con éxito!');
            }
        }

        // Si no hay listas (primer uso absoluto), creamos la predeterminada
        if (lists.length === 0) {
            const defaultList = {
                id: `list_${Date.now()}`,
                name: 'Lista Principal',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                products: []
            };
            await db.saveList(defaultList);
            lists = [defaultList];
            activeListId = defaultList.id;
            await db.saveConfig('activeListId', activeListId);
        }

        // Si no hay activeListId o ya no existe en las listas, seleccionar la primera
        if (!activeListId || !lists.some(l => l.id === activeListId)) {
            activeListId = lists[0].id;
            await db.saveConfig('activeListId', activeListId);
        }

        // Cargar productos de la lista activa
        const activeList = lists.find(l => l.id === activeListId);
        products = activeList ? activeList.products : [];
    } catch (err) {
        showToast('error', 'Error al cargar de la base de datos: ' + err.message);
        products = [];
    }
}

async function saveToStorage() {
    try {
        const activeList = lists.find(l => l.id === activeListId);
        if (activeList) {
            activeList.products = products;
            activeList.updatedAt = new Date().toISOString();
            await db.saveList(activeList);
        }
    } catch (err) {
        showToast('error', 'Error al guardar en la nube (Firestore).');
    }
}

// ── UTILIDADES ───────────────────────────────────────────────
function uid() {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function fmtPrice(v) {
    const n = parseFloat(v);
    return isNaN(n) ? '0.00' : n.toFixed(2);
}

function escHtml(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Redimensiona y comprime imagen para ahorrar localStorage
function fileToBase64(file, maxPx = 900, q = 0.82) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.onload = e => {
            const img = new Image();
            img.onerror = () => reject(new Error('No es una imagen válida'));
            img.onload = () => {
                let { width: w, height: h } = img;
                if (w > maxPx || h > maxPx) {
                    const r = Math.min(maxPx / w, maxPx / h);
                    w = Math.round(w * r);
                    h = Math.round(h * r);
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', q));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ── REFERENCIAS AL DOM ─────────────────────────────────────────────────
const dragOverlay = document.getElementById('drag-overlay');
const formPanel = document.getElementById('form-panel');
const btnToggleForm = document.getElementById('btn-toggle-form');
const miniDropzone = document.getElementById('mini-dropzone');
const fileInput = document.getElementById('file-input');
const btnBrowse = document.getElementById('btn-browse');
const formImagePreview = document.getElementById('form-image-preview');
const formPreviewImg = document.getElementById('form-preview-img');
const btnClearImage = document.getElementById('btn-clear-image');
const addForm = document.getElementById('add-form');
const inputName = document.getElementById('input-name');
const inputPrice = document.getElementById('input-price');
const btnCancelForm = document.getElementById('btn-cancel-form');
const listsColumns = document.getElementById('lists-columns');
const productsAvailable = document.getElementById('products-available');
const productsSold = document.getElementById('products-sold');
const countAvailable = document.getElementById('count-available');
const countSold = document.getElementById('count-sold');
const emptyState = document.getElementById('empty-state');
const noResults = document.getElementById('no-results');
const searchInput = document.getElementById('search-input');
const totalCount = document.getElementById('total-count');
const themeToggle = document.getElementById('theme-toggle');
const toast = document.getElementById('toast');

// Modal de edición
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editId = document.getElementById('edit-id');
const editName = document.getElementById('edit-name');
const editPrice = document.getElementById('edit-price');
const editCompradora = document.getElementById('edit-compradora');
const editPreviewImg = document.getElementById('edit-preview-img');
const editImageContainer = document.getElementById('edit-image-container');
const editNoImage = document.getElementById('edit-no-image');
const btnEditDeleteImage = document.getElementById('btn-edit-delete-image');
const btnEditAddImage = document.getElementById('btn-edit-add-image');
const editFileInput = document.getElementById('edit-file-input');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnDeleteProduct = document.getElementById('btn-delete-product');

// Listas múltiples
const btnListSelect = document.getElementById('btn-list-select');
const activeListName = document.getElementById('active-list-name');
const listDropdown = document.getElementById('list-dropdown');
const btnToolsSelect = document.getElementById('btn-tools-select');
const toolsDropdown = document.getElementById('tools-dropdown');
const btnExportBackup = document.getElementById('btn-export-backup');
const btnImportBackup = document.getElementById('btn-import-backup');
const backupFileInput = document.getElementById('backup-file-input');
const listOptions = document.getElementById('list-options');
const btnCreateList = document.getElementById('btn-create-list');
const btnRenameList = document.getElementById('btn-rename-list');
const btnDeleteList = document.getElementById('btn-delete-list');

// Prompt modal
const promptModal = document.getElementById('prompt-modal');
const promptForm = document.getElementById('prompt-form');
const promptTitle = document.getElementById('prompt-modal-title');
const promptLabel = document.getElementById('prompt-label');
const promptInput = document.getElementById('prompt-input');
const btnClosePrompt = document.getElementById('btn-close-prompt');
const btnCancelPrompt = document.getElementById('btn-cancel-prompt');
const promptSubmitText = document.getElementById('prompt-submit-text');

// Vista de resumen (Totales por compradora)
const btnShowSummary = document.getElementById('btn-show-summary');
const summaryView = document.getElementById('summary-view');
const btnCloseSummary = document.getElementById('btn-close-summary');
const summaryBuyersList = document.getElementById('summary-buyers-list');
const summaryEmptyState = document.getElementById('summary-empty-state');
const statTotalSoldMoney = document.getElementById('stat-total-sold-money');
const statUniqueBuyers = document.getElementById('stat-unique-buyers');
const statTotalSoldQty = document.getElementById('stat-total-sold-qty');
const btnCopyClosingMsg = document.getElementById('btn-copy-closing-msg');
const btnSortSold = document.getElementById('btn-sort-sold');
const btnSortBuyers = document.getElementById('btn-sort-buyers');
const btnSortModified = document.getElementById('btn-sort-modified');
const summarySearchInput = document.getElementById('summary-search-input');
const btnScrollToggle = document.getElementById('btn-scroll-toggle');

let promptMode = 'create'; // 'create' o 'rename'
let soldSortMode = 'default'; // 'default', 'buyer-asc', 'buyer-desc'
let buyersSortMode = 'name-asc'; // 'default', 'name-asc', 'total-desc'
let globalSortMode = 'default'; // 'default', 'modified-desc'
let summarySearchTerm = '';


// ── CAPTURA DE IMAGEN ────────────────────────────────────────

/** Muestra la imagen capturada en el formulario de añadir */
function setFormImage(base64) {
    pendingImage = base64;
    formPreviewImg.src = base64;
    formImagePreview.style.display = 'block';
    miniDropzone.style.display = 'none';
    // Abrir el formulario y enfocar nombre
    openForm();
    inputName.focus();
}

/** Limpia la imagen del formulario */
function clearFormImage() {
    pendingImage = null;
    formPreviewImg.src = '';
    formImagePreview.style.display = 'none';
    miniDropzone.style.display = 'flex';
}

/** Abre el panel del formulario */
function openForm() {
    formPanel.classList.add('open');
    formPanel.setAttribute('aria-hidden', 'false');
    btnToggleForm.classList.add('open');
    btnToggleForm.setAttribute('aria-expanded', 'true');
}

/** Cierra y resetea el panel del formulario */
function closeForm() {
    formPanel.classList.remove('open');
    formPanel.setAttribute('aria-hidden', 'true');
    btnToggleForm.classList.remove('open');
    btnToggleForm.setAttribute('aria-expanded', 'false');
    addForm.reset();
    clearFormImage();
}

/** Procesa un File de imagen y lo muestra en el formulario */
async function handleDroppedFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        showToast('error', 'El archivo no es una imagen válida.');
        return;
    }
    try {
        const b64 = await fileToBase64(file);
        setFormImage(b64);
    } catch (err) {
        showToast('error', 'Error al procesar la imagen: ' + err.message);
    }
}

// ── TOGGLE DEL FORMULARIO ─────────────────────────────────────────────────
btnToggleForm.addEventListener('click', () => {
    if (formPanel.classList.contains('open')) {
        closeForm();
    } else {
        openForm();
        setTimeout(() => inputName.focus(), 50);
    }
});

btnCancelForm.addEventListener('click', closeForm);

// ── DRAG GLOBAL (cualquier parte de la página) ───────────────
let dragCounter = 0; // contador para manejar drag enter/leave en hijos

document.addEventListener('dragenter', e => {
    if (e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        dragOverlay.classList.add('active');
    }
});

document.addEventListener('dragleave', e => {
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.classList.remove('active');
    }
});

document.addEventListener('dragover', e => {
    e.preventDefault(); // necesario para que drop funcione
});

document.addEventListener('drop', async e => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        await handleDroppedFile(files[0]);
        return;
    }

    // Intentar items (drag desde otras pestañas del navegador)
    const items = e.dataTransfer.items;
    if (items) {
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                await handleDroppedFile(item.getAsFile());
                return;
            }
        }
        // Detectar blob URL de WhatsApp (no se puede leer por CORS)
        for (const item of items) {
            if (item.kind === 'string') {
                item.getAsString(url => {
                    if (url && url.startsWith('blob:')) {
                        showToast('error', 'Por seguridad del navegador, copia la imagen en WhatsApp (clic der. → Copiar imagen) y usa Ctrl+V aquí.');
                    } else {
                        showToast('error', 'No se pudo capturar la imagen. Usa Ctrl+V para pegarla.');
                    }
                });
                return;
            }
        }
    }

    showToast('error', 'No se detectó imagen. Prueba con Ctrl+V.');
});

// ── PEGADO CON CTRL+V ────────────────────────────────────────
document.addEventListener('paste', async e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            await handleDroppedFile(item.getAsFile());
            showToast('success', '¡Imagen pegada!');
            return;
        }
    }
});

// ── MINI DROPZONE (soltar o hacer clic) ──────────────────────
miniDropzone.addEventListener('click', e => {
    if (!e.target.closest('#btn-browse')) fileInput.click();
});

btnBrowse.addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
});

fileInput.addEventListener('change', async () => {
    if (fileInput.files[0]) await handleDroppedFile(fileInput.files[0]);
    fileInput.value = '';
});

// Drag sobre la mini dropzone
miniDropzone.addEventListener('dragover', e => { e.preventDefault(); miniDropzone.classList.add('drag-over'); });
miniDropzone.addEventListener('dragleave', e => { miniDropzone.classList.remove('drag-over'); });
miniDropzone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    miniDropzone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files[0]) await handleDroppedFile(files[0]);
});

btnClearImage.addEventListener('click', clearFormImage);

// ── FORMULARIO: AGREGAR PRODUCTO ─────────────────────────────
addForm.addEventListener('submit', e => {
    e.preventDefault();

    const name = inputName.value.trim();
    const price = inputPrice.value;

    // Validación mínima
    let valid = true;
    if (!name) { inputName.classList.add('invalid'); valid = false; }
    else { inputName.classList.remove('invalid'); }
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
        inputPrice.classList.add('invalid'); valid = false;
    } else { inputPrice.classList.remove('invalid'); }
    if (!valid) return;

    const now = new Date().toISOString();
    const product = {
        id: uid(),
        name,
        price: fmtPrice(price),
        image: pendingImage,
        compradora: '',
        createdAt: now,
        priceHistory: [
            { price: fmtPrice(price), compradora: '', timestamp: now, isBase: true }
        ],
    };

    products.unshift(product);
    saveToStorage();

    // Resetear y cerrar formulario
    closeForm();

    renderProducts();
    updateCount();
    showToast('success', `“${name}” añadido a la lista.`);
});

// Función para autocapitalizar la primera letra de cada palabra (Title Case)
function capitalizeWords(str) {
    return str.replace(/(^|[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ])([a-zñáéíóúü])/g, (match, separator, letter) => {
        return separator + letter.toUpperCase();
    });
}

function handleAutocapitalize(e) {
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const originalValue = input.value;
    const capitalizedValue = capitalizeWords(originalValue);

    if (originalValue !== capitalizedValue) {
        input.value = capitalizedValue;
        input.setSelectionRange(start, end);
    }
}

// Limpiar invalid al escribir y autocapitalizar
inputName.addEventListener('input', (e) => {
    inputName.classList.remove('invalid');
    handleAutocapitalize(e);
});
inputPrice.addEventListener('input', () => inputPrice.classList.remove('invalid'));

// ── RENDERIZADO ──────────────────────────────────────────────
let searchTerm = '';

function getLatestHistoryDate(product) {
    if (!product.priceHistory || product.priceHistory.length === 0) {
        return new Date(product.createdAt || 0);
    }
    const lastEntry = product.priceHistory[product.priceHistory.length - 1];
    return new Date(lastEntry.timestamp || product.createdAt || 0);
}

function getFiltered() {
    let result = [];
    if (!searchTerm) {
        result = [...products];
    } else {
        const t = searchTerm.toLowerCase();
        result = products.filter(p =>
            p.name.toLowerCase().includes(t) ||
            (p.compradora && p.compradora.toLowerCase().includes(t))
        );
    }

    if (globalSortMode === 'modified-desc') {
        result.sort((a, b) => {
            const dateA = getLatestHistoryDate(a);
            const dateB = getLatestHistoryDate(b);
            return dateB - dateA;
        });
    }

    return result;
}

// ── HOVER PREVIEW (imagen flotante al pasar el mouse) ──────────────────
let hoverPreviewEl = null;

function getHoverPreview() {
    if (!hoverPreviewEl) {
        hoverPreviewEl = document.createElement('div');
        hoverPreviewEl.className = 'hover-preview';
        hoverPreviewEl.innerHTML = '<img alt="Vista rápida">';
        document.body.appendChild(hoverPreviewEl);
    }
    return hoverPreviewEl;
}

function showHoverPreview(imgSrc, event) {
    const el = getHoverPreview();
    el.querySelector('img').src = imgSrc;
    el.classList.add('visible');
    positionHoverPreview(event);
}

function positionHoverPreview(event) {
    if (!hoverPreviewEl || !hoverPreviewEl.classList.contains('visible')) return;
    const SIZE = 320;
    let x = event.clientX + 24;
    let y = event.clientY - SIZE / 2;
    if (x + SIZE > window.innerWidth - 10) x = event.clientX - SIZE - 24;
    if (y < 10) y = 10;
    if (y + SIZE > window.innerHeight - 10) y = window.innerHeight - SIZE - 10;
    hoverPreviewEl.style.left = x + 'px';
    hoverPreviewEl.style.top = y + 'px';
}

function hideHoverPreview() {
    if (hoverPreviewEl) hoverPreviewEl.classList.remove('visible');
}

function renderProducts() {
    const filtered = getFiltered();

    // Limpiar ambas columnas
    productsAvailable.innerHTML = '';
    productsSold.innerHTML = '';

    const hasProducts = products.length > 0;
    const hasFiltered = filtered.length > 0;

    // Mostrar/ocultar estados
    if (!hasProducts) {
        emptyState.style.display = 'flex';
        noResults.style.display = 'none';
        listsColumns.style.display = 'none';
    } else if (!hasFiltered) {
        emptyState.style.display = 'none';
        noResults.style.display = 'flex';
        listsColumns.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        noResults.style.display = 'none';
        listsColumns.style.display = 'grid';
    }

    // Clasificar productos
    const available = filtered.filter(p => !p.compradora);
    let sold = filtered.filter(p => p.compradora);

    // Ordenar adjudicados según el modo seleccionado
    if (soldSortMode === 'buyer-asc') {
        sold.sort((a, b) => a.compradora.localeCompare(b.compradora, 'es', { sensitivity: 'base' }));
    } else if (soldSortMode === 'buyer-desc') {
        sold.sort((a, b) => b.compradora.localeCompare(a.compradora, 'es', { sensitivity: 'base' }));
    }

    // Calcular costos totales por columna
    const totalAvailable = available.reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
    const totalSold = sold.reduce((sum, p) => sum + parseFloat(p.price || 0), 0);

    // Actualizar contadores y costos totales en la UI
    countAvailable.textContent = available.length;
    countSold.textContent = sold.length;
    document.getElementById('total-price-available').textContent = `$${fmtPrice(totalAvailable)}`;
    document.getElementById('total-price-sold').textContent = `$${fmtPrice(totalSold)}`;

    // Renderizar columna disponibles
    if (available.length === 0) {
        productsAvailable.innerHTML = '<div class="column-empty-hint">Sin productos disponibles</div>';
    } else {
        available.forEach((p, i) => {
            const card = createProductCard(p, i);
            productsAvailable.appendChild(card);
        });
    }

    // Renderizar columna adjudicados
    if (sold.length === 0) {
        productsSold.innerHTML = '<div class="column-empty-hint">Sin productos adjudicados</div>';
    } else {
        sold.forEach((p, i) => {
            const card = createProductCard(p, i);
            productsSold.appendChild(card);
        });
    }

    if (window.lucide) lucide.createIcons();
}

// Función auxiliar para generar la tarjeta
function createProductCard(p, i) {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.dataset.id = p.id;
    card.style.animationDelay = `${i * 0.04}s`;
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Producto: ${escHtml(p.name)}, $${p.price}`);

    const imgHtml = p.image
        ? `<img src="${p.image}" alt="${escHtml(p.name)}" loading="lazy">`
        : `<div class="card-no-image"><i data-lucide="image-off"></i><span>Sin imagen</span></div>`;

    const compBadge = p.compradora
        ? `<div class="card-compradora-badge"><i data-lucide="user-check"></i><span>${escHtml(p.compradora)}</span></div>`
        : '';

    card.innerHTML = `
        <div class="card-image">
            ${imgHtml}
            ${compBadge}
        </div>
        <div class="card-info">
            <div class="card-name">${escHtml(p.name)}</div>
            <div class="card-price">$${escHtml(p.price)}</div>
            ${p.compradora ? `<div class="card-compradora-info"><i data-lucide="user-check"></i>${escHtml(p.compradora)}</div>` : ''}
        </div>
    `;

    // Hover preview sobre la imagen
    if (p.image) {
        const imgDiv = card.querySelector('.card-image');
        imgDiv.addEventListener('mouseenter', e => showHoverPreview(p.image, e));
        imgDiv.addEventListener('mousemove', e => positionHoverPreview(e));
        imgDiv.addEventListener('mouseleave', () => hideHoverPreview());
    }

    card.addEventListener('click', () => openEditModal(p.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal(p.id); } });

    return card;
}

function updateCount() {
    totalCount.textContent = products.length;
}

// ── BÚSQUEDA ─────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value;
    renderProducts();
});

summarySearchInput.addEventListener('input', () => {
    summarySearchTerm = summarySearchInput.value;
    renderSummaryView();
});

// Redirección automática de foco a la búsqueda (Type-to-Search)
document.addEventListener('keydown', (e) => {
    // 1. Ignorar si el usuario ya está interactuando con un campo de entrada editable
    const active = document.activeElement;
    if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable
    )) {
        return;
    }

    // 2. Ignorar si hay teclas modificadoras presionadas (ej. Ctrl, Alt, Cmd/Meta)
    if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
    }

    // 3. Ignorar teclas especiales y de control que no producen caracteres legibles
    if (e.key.length !== 1) {
        return;
    }

    // 4. Ignorar si hay formularios o diálogos interactivos de datos en primer plano
    if (editModal && editModal.style.display === 'flex') {
        return;
    }
    if (promptModal && promptModal.style.display === 'flex') {
        return;
    }
    if (formPanel && formPanel.classList.contains('open')) {
        return;
    }

    // 5. Determinar el input de búsqueda destino según el contexto visual actual
    let targetInput = null;
    if (summaryView && summaryView.style.display === 'flex') {
        targetInput = summarySearchInput;
    } else {
        targetInput = searchInput;
    }

    // 6. Asignar el foco al input para que el carácter se escriba de manera nativa
    if (targetInput) {
        targetInput.focus();
    }
});

// ── MODAL DE EDICIÓN ─────────────────────────────────────────
function renderPriceHistory(product) {
    const list = document.getElementById('price-history-list');
    const history = product.priceHistory || [];

    if (history.length === 0) {
        list.innerHTML = '<p class="ph-empty">Sin historial registrado.</p>';
        return;
    }

    // Mostrar del más reciente al más antiguo
    const reversed = [...history].reverse();

    list.innerHTML = reversed.map((entry, i) => {
        const isCurrent = i === 0;
        const isBase = entry.isBase && history.length > 0 && entry === history[0];
        const d = new Date(entry.timestamp);
        const dateStr = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
            + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

        const compHTML = entry.compradora
            ? `<span class="ph-comp"><i data-lucide="user-check"></i>${escHtml(entry.compradora)}</span>`
            : ``;

        const badgeHTML = isCurrent
            ? `<span class="ph-badge badge-current">Actual</span>`
            : ``;

        const revertBtn = !isCurrent
            ? `<button type="button" class="btn-revert"
                   data-price="${escHtml(entry.price)}"
                   data-comp="${escHtml(entry.compradora || '')}">
                   <i data-lucide="corner-up-left"></i> Usar
               </button>`
            : '';

        const classes = ['ph-entry', isCurrent ? 'current' : '', isBase && !isCurrent ? 'is-base' : ''].filter(Boolean).join(' ');

        return `
            <div class="${classes}">
                <span class="ph-price">$${escHtml(entry.price)}</span>
                ${compHTML}
                <span class="ph-date">${dateStr}</span>
                ${badgeHTML}
                ${revertBtn}
            </div>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();

    // Eventos del botón "Usar"
    list.querySelectorAll('.btn-revert').forEach(btn => {
        btn.addEventListener('click', () => {
            editPrice.value = btn.dataset.price;
            editCompradora.value = btn.dataset.comp;
            editPrice.focus();
            editPrice.select();
            showToast('success', `Precio revertido a $${btn.dataset.price}. Presiona Enter para guardar.`);
        });
    });
}

function openEditModal(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;

    editId.value = id;
    editName.value = p.name;
    editPrice.value = p.price;
    editCompradora.value = p.compradora || '';
    editingImageBase64 = p.image;

    if (p.image) {
        editPreviewImg.src = p.image;
        editImageContainer.style.display = 'block';
        editNoImage.style.display = 'none';
    } else {
        editImageContainer.style.display = 'none';
        editNoImage.style.display = 'flex';
    }

    // Renderizar historial
    renderPriceHistory(p);

    editModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();

    // Foco condicional: al precio si ya tiene compradora, o a la compradora si está libre
    setTimeout(() => {
        if (p.compradora) {
            editPrice.focus();
            editPrice.select();
        } else {
            editCompradora.focus();
            editCompradora.select();
        }
    }, 80);
}

function closeEditModal() {
    editModal.style.display = 'none';
    document.body.style.overflow = '';
    editingImageBase64 = null;
}

btnCloseModal.addEventListener('click', closeEditModal);
editModal.addEventListener('click', e => { if (e.target === editModal) closeEditModal(); });
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && editModal.style.display === 'flex') closeEditModal();
});

// Guardar edición (también con Enter)
editForm.addEventListener('submit', e => {
    e.preventDefault();

    const name = editName.value.trim();
    const price = editPrice.value;

    let valid = true;
    if (!name) { editName.classList.add('invalid'); valid = false; }
    else { editName.classList.remove('invalid'); }
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
        editPrice.classList.add('invalid'); valid = false;
    } else { editPrice.classList.remove('invalid'); }
    if (!valid) return;

    const idx = products.findIndex(x => x.id === editId.value);
    if (idx === -1) return;

    const newPrice = fmtPrice(price);
    const newComp = editCompradora.value.trim();
    const lastEntry = (products[idx].priceHistory || []).slice(-1)[0];
    const priceChanged = !lastEntry || lastEntry.price !== newPrice || lastEntry.compradora !== newComp;

    const updatedHistory = products[idx].priceHistory
        ? [...products[idx].priceHistory]
        : [{ price: products[idx].price, compradora: products[idx].compradora || '', timestamp: products[idx].createdAt, isBase: true }];

    if (priceChanged) {
        updatedHistory.push({
            price: newPrice,
            compradora: newComp,
            timestamp: new Date().toISOString(),
            isBase: false,
        });
    }

    products[idx] = {
        ...products[idx],
        name,
        price: newPrice,
        compradora: newComp,
        image: editingImageBase64,
        updatedAt: new Date().toISOString(),
        priceHistory: updatedHistory,
    };

    saveToStorage();
    closeEditModal();
    renderProducts();
    showToast('success', 'Cambios guardados.');
});

// Enter en los inputs del modal envía el formulario
[editName, editPrice, editCompradora].forEach(input => {
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); editForm.requestSubmit(); }
    });
    input.addEventListener('input', (e) => {
        input.classList.remove('invalid');
        if (input !== editPrice) {
            handleAutocapitalize(e);
        }
    });
});

// Registrar autocapitalización en el prompt input
if (promptInput) {
    promptInput.addEventListener('input', handleAutocapitalize);
}

// Autocompletado del campo de Compradoras con Tab/Enter nativo
function getAllBuyers() {
    const buyers = new Set();
    lists.forEach(l => {
        if (Array.isArray(l.products)) {
            l.products.forEach(p => {
                if (p.compradora && p.compradora.trim() !== '') {
                    buyers.add(p.compradora.trim());
                }
            });
        }
    });
    return Array.from(buyers);
}

function cleanText(text) {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

editCompradora.addEventListener('input', (e) => {
    // 1. Aplicar autocapitalización primero (resguardando selección de cursor)
    const startPos = editCompradora.selectionStart;
    const endPos = editCompradora.selectionEnd;
    const originalValue = editCompradora.value;
    const capitalizedValue = capitalizeWords(originalValue);

    if (originalValue !== capitalizedValue) {
        editCompradora.value = capitalizedValue;
        editCompradora.setSelectionRange(startPos, endPos);
    }

    const inputVal = editCompradora.value;
    if (!inputVal) return;

    // Si es un borrado, no auto-completar de inmediato
    if (e.inputType && e.inputType.startsWith('delete')) return;

    const buyers = getAllBuyers();
    const cleanInput = cleanText(inputVal);
    const match = buyers.find(b => cleanText(b).startsWith(cleanInput));

    if (match) {
        const start = inputVal.length;
        // Conserva el valor y capitalización escrita por el usuario, agregando el resto de la sugerencia
        editCompradora.value = inputVal + match.substring(start);
        editCompradora.setSelectionRange(start, match.length);
    }
});

// Eliminar imagen en el modal
btnEditDeleteImage.addEventListener('click', () => {
    editingImageBase64 = null;
    editImageContainer.style.display = 'none';
    editNoImage.style.display = 'flex';
    if (window.lucide) lucide.createIcons();
});

// Agregar imagen desde el modal
btnEditAddImage.addEventListener('click', () => editFileInput.click());
editFileInput.addEventListener('change', async () => {
    if (editFileInput.files[0]) {
        try {
            editingImageBase64 = await fileToBase64(editFileInput.files[0]);
            editPreviewImg.src = editingImageBase64;
            editImageContainer.style.display = 'block';
            editNoImage.style.display = 'none';
        } catch { showToast('error', 'Error al cargar la imagen.'); }
    }
    editFileInput.value = '';
});

// Eliminar producto desde el modal
btnDeleteProduct.addEventListener('click', () => {
    const id = editId.value;
    const p = products.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar "${p.name}" de la lista?`)) return;
    products = products.filter(x => x.id !== id);
    saveToStorage();
    closeEditModal();
    renderProducts();
    updateCount();
    showToast('success', `"${p.name}" eliminado.`);
});

// ── TEMA ─────────────────────────────────────────────────────
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('subastalista_theme', theme);
}

themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ── TOAST ────────────────────────────────────────────────────
let toastTimer = null;
function showToast(type, msg) {
    clearTimeout(toastTimer);
    toast.className = `toast ${type} show`;
    toast.textContent = msg;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ── GESTIÓN DE LISTAS MÚLTIPLES ──────────────────────────────
function toggleListDropdown() {
    const isVisible = listDropdown.style.display === 'block';
    if (isVisible) {
        closeListDropdown();
    } else {
        openListDropdown();
    }
}

function openListDropdown() {
    listDropdown.style.display = 'block';
    btnListSelect.classList.add('open');
    btnListSelect.setAttribute('aria-expanded', 'true');
    renderListOptions();
}

function closeListDropdown() {
    listDropdown.style.display = 'none';
    btnListSelect.classList.remove('open');
    btnListSelect.setAttribute('aria-expanded', 'false');
}

function renderListOptions() {
    listOptions.innerHTML = '';
    lists.forEach(l => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `list-option-item ${l.id === activeListId ? 'active' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', l.id === activeListId ? 'true' : 'false');

        let content = `<span>${escHtml(l.name)}</span>`;
        if (l.id === activeListId) {
            content += `<i data-lucide="check" class="check-ico"></i>`;
        }
        item.innerHTML = content;

        item.addEventListener('click', () => {
            selectList(l.id);
            closeListDropdown();
        });

        listOptions.appendChild(item);
    });
    if (window.lucide) lucide.createIcons();
}

async function selectList(id) {
    if (id === activeListId) return;
    activeListId = id;
    await db.saveConfig('activeListId', activeListId);

    const activeList = lists.find(l => l.id === activeListId);
    products = activeList ? activeList.products : [];

    activeListName.textContent = activeList ? activeList.name : 'Sin nombre';

    renderProducts();
    updateCount();
    showToast('success', `Cargada la lista: “${activeList ? activeList.name : ''}”`);
}

// Abrir modal prompt
function openPromptModal(mode) {
    promptMode = mode;
    promptInput.classList.remove('invalid');

    if (mode === 'create') {
        promptTitle.textContent = 'Nueva Lista';
        promptLabel.textContent = 'Nombre de la lista';

        // Formatear la fecha actual al formato: "dd de mes de aaaa" (ej: "04 de junio de 2026")
        const now = new Date();
        const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

        promptInput.value = dateStr;
        promptInput.placeholder = 'Ej. Subasta del martes';
        promptSubmitText.textContent = 'Crear Lista';
    } else {
        const activeList = lists.find(l => l.id === activeListId);
        promptTitle.textContent = 'Renombrar Lista';
        promptLabel.textContent = 'Nuevo nombre';
        promptInput.value = activeList ? activeList.name : '';
        promptInput.placeholder = 'Ej. Subasta del martes';
        promptSubmitText.textContent = 'Guardar Nombre';
    }

    promptModal.style.display = 'flex';
    setTimeout(() => {
        promptInput.focus();
        promptInput.select();
    }, 80);
    closeListDropdown();
}

function closePromptModal() {
    promptModal.style.display = 'none';
    promptInput.value = '';
}

// Eventos de Listas
btnListSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleListDropdown();
});

// Cerrar dropdowns al hacer clic fuera
document.addEventListener('click', (e) => {
    if (!e.target.closest('.list-selector-container')) {
        closeListDropdown();
    }
    if (!e.target.closest('.tools-selector-container')) {
        closeToolsDropdown();
    }
});

btnCreateList.addEventListener('click', () => openPromptModal('create'));
btnRenameList.addEventListener('click', () => openPromptModal('rename'));

btnDeleteList.addEventListener('click', async () => {
    const activeList = lists.find(l => l.id === activeListId);
    if (!activeList) return;

    closeListDropdown();

    if (!confirm(`¿Eliminar la lista "${activeList.name}"?\nSe perderán de forma permanente todos sus productos (${activeList.products.length}).`)) {
        return;
    }

    try {
        await db.deleteList(activeListId);
        lists = lists.filter(l => l.id !== activeListId);

        if (lists.length === 0) {
            // Si eliminamos la última lista, creamos una nueva por defecto
            const defaultList = {
                id: `list_${Date.now()}`,
                name: 'Lista Principal',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                products: []
            };
            await db.saveList(defaultList);
            lists = [defaultList];
        }

        // Seleccionamos la primera lista de la colección restante
        activeListId = lists[0].id;
        await db.saveConfig('activeListId', activeListId);

        const activeListObj = lists[0];
        products = activeListObj.products;
        activeListName.textContent = activeListObj.name;

        renderProducts();
        updateCount();
        showToast('success', 'Lista eliminada correctamente.');
    } catch (err) {
        showToast('error', 'Error al eliminar la lista: ' + err.message);
    }
});

// Modal prompt eventos
btnClosePrompt.addEventListener('click', closePromptModal);
btnCancelPrompt.addEventListener('click', closePromptModal);
promptModal.addEventListener('click', (e) => {
    if (e.target === promptModal) closePromptModal();
});

promptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = promptInput.value.trim();
    if (!val) {
        promptInput.classList.add('invalid');
        return;
    }
    promptInput.classList.remove('invalid');

    if (promptMode === 'create') {
        const newList = {
            id: `list_${Date.now()}`,
            name: val,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            products: []
        };
        try {
            await db.saveList(newList);
            lists.push(newList);
            activeListId = newList.id;
            await db.saveConfig('activeListId', activeListId);
            products = [];
            activeListName.textContent = val;

            closePromptModal();
            renderProducts();
            updateCount();
            showToast('success', `Lista “${val}” creada.`);
        } catch (err) {
            showToast('error', 'Error al guardar la nueva lista: ' + err.message);
        }
    } else {
        const activeList = lists.find(l => l.id === activeListId);
        if (activeList) {
            activeList.name = val;
            activeList.updatedAt = new Date().toISOString();
            try {
                await db.saveList(activeList);
                activeListName.textContent = val;
                closePromptModal();
                showToast('success', `Lista renombrada a “${val}”.`);
            } catch (err) {
                showToast('error', 'Error al renombrar la lista: ' + err.message);
            }
        }
    }
});

// ── GESTIÓN DE HERRAMIENTAS Y RESPALDOS ─────────────────────────
function toggleToolsDropdown() {
    const isVisible = toolsDropdown.style.display === 'block';
    if (isVisible) {
        closeToolsDropdown();
    } else {
        openToolsDropdown();
    }
}

function openToolsDropdown() {
    toolsDropdown.style.display = 'block';
    btnToolsSelect.classList.add('open');
    btnToolsSelect.setAttribute('aria-expanded', 'true');
    closeListDropdown();
}

function closeToolsDropdown() {
    toolsDropdown.style.display = 'none';
    btnToolsSelect.classList.remove('open');
    btnToolsSelect.setAttribute('aria-expanded', 'false');
}

if (btnToolsSelect) {
    btnToolsSelect.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolsDropdown();
    });
}

// Exportar copia de seguridad (backup JSON)
async function handleExportBackup() {
    try {
        const allLists = await db.getLists();
        const activeId = await db.getConfig('activeListId');

        if (allLists.length === 0) {
            showToast('error', 'No hay información para exportar.');
            return;
        }

        const backupData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            activeListId: activeId,
            lists: allLists
        };

        const dataStr = JSON.stringify(backupData);
        const blob = new Blob([dataStr], { type: 'application/json' });

        const now = new Date();
        const dateStr = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0');

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `subastalista_backup_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('success', 'Backup generado y descargado correctamente.');
    } catch (err) {
        showToast('error', 'Error al generar el backup: ' + err.message);
    }
}

if (btnExportBackup) {
    btnExportBackup.addEventListener('click', async () => {
        closeToolsDropdown();
        await handleExportBackup();
    });
}

if (btnImportBackup) {
    btnImportBackup.addEventListener('click', () => {
        closeToolsDropdown();
        backupFileInput.click();
    });
}

backupFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const backupData = JSON.parse(evt.target.result);

            // Validaciones básicas
            if (!backupData || typeof backupData !== 'object') {
                throw new Error('El archivo no tiene un formato válido.');
            }
            if (!Array.isArray(backupData.lists)) {
                throw new Error('El backup no contiene una lista de datos válida.');
            }

            const confirmRestore = confirm(
                `¿Estás seguro de que deseas restaurar este respaldo?\n` +
                `Se importarán ${backupData.lists.length} lista(s).\n\n` +
                `¡ATENCIÓN!: Esto sobrescribirá y reemplazará todos tus datos actuales de Bonito Bazar.`
            );

            if (!confirmRestore) {
                backupFileInput.value = '';
                return;
            }

            // Restaurar base de datos
            await db.restoreBackup(backupData.lists, backupData.activeListId);

            showToast('success', 'Backup restaurado con éxito. Recargando aplicación...');

            setTimeout(() => {
                location.reload();
            }, 1500);

        } catch (err) {
            showToast('error', 'Error al importar el backup: ' + err.message);
            backupFileInput.value = '';
        }
    };

    reader.onerror = () => {
        showToast('error', 'No se pudo leer el archivo seleccionado.');
        backupFileInput.value = '';
    };

    reader.readAsText(file);
});

// Copiar mensaje de cierre de subasta al portapapeles
if (btnCopyClosingMsg) {
    btnCopyClosingMsg.addEventListener('click', async () => {
        closeToolsDropdown();
        try {
            const now = new Date();
            const closeTime = new Date(now.getTime() + 10 * 60 * 1000);
            const lastMsgTime = new Date(closeTime.getTime() - 1000);

            function formatHMS(date) {
                const h = String(date.getHours()).padStart(2, '0');
                const m = String(date.getMinutes()).padStart(2, '0');
                const s = String(date.getSeconds()).padStart(2, '0');
                return `${h}:${m}:${s}`;
            }

            const closingText = `SUBASTAS\n- ÚLTIMO MENSAJE: ${formatHMS(lastMsgTime)}\n- CIERRO GRUPO:  ${formatHMS(closeTime)}`;

            await navigator.clipboard.writeText(closingText);
            showToast('success', '¡Mensaje de cierre copiado al portapapeles!');
        } catch (err) {
            showToast('error', 'Error al copiar el mensaje: ' + err.message);
        }
    });
}

// Ordenar columna de Adjudicados por compradora
btnSortSold.addEventListener('click', () => {
    if (soldSortMode === 'default') {
        soldSortMode = 'buyer-asc';
        btnSortSold.classList.add('active');
        btnSortSold.title = 'Ordenar por compradora (A-Z)';
        btnSortSold.innerHTML = '<i data-lucide="arrow-down-az"></i>';
        showToast('success', 'Ordenado por compradora (A-Z)');
    } else if (soldSortMode === 'buyer-asc') {
        soldSortMode = 'buyer-desc';
        btnSortSold.classList.add('active');
        btnSortSold.title = 'Ordenar por compradora (Z-A)';
        btnSortSold.innerHTML = '<i data-lucide="arrow-up-za"></i>';
        showToast('success', 'Ordenado por compradora (Z-A)');
    } else {
        soldSortMode = 'default';
        btnSortSold.classList.remove('active');
        btnSortSold.title = 'Orden por defecto';
        btnSortSold.innerHTML = '<i data-lucide="arrow-up-down"></i>';
        showToast('success', 'Restaurado orden por defecto');
    }
    if (window.lucide) lucide.createIcons();
    renderProducts();
});

// Ordenar lista general por últimos modificados
btnSortModified.addEventListener('click', () => {
    if (globalSortMode === 'default') {
        globalSortMode = 'modified-desc';
        btnSortModified.classList.add('active');
        btnSortModified.title = 'Ordenar: Últimos modificados primero';
        showToast('success', 'Ordenado por últimos modificados');
    } else {
        globalSortMode = 'default';
        btnSortModified.classList.remove('active');
        btnSortModified.title = 'Ordenar: Por defecto';
        showToast('success', 'Restaurado orden por defecto');
    }
    if (window.lucide) lucide.createIcons();
    renderProducts();
});



// Vista de resumen: Abrir, cerrar y renderizar
btnShowSummary.addEventListener('click', () => {
    renderSummaryView();
    summaryView.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    updateScrollButton();
});

btnCloseSummary.addEventListener('click', () => {
    clearCopiedIndicators();
    summaryView.style.display = 'none';
    document.body.style.overflow = '';
    updateScrollButton();
});

// Cerrar con Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && summaryView.style.display === 'flex') {
        clearCopiedIndicators();
        summaryView.style.display = 'none';
        document.body.style.overflow = '';
        updateScrollButton();
    }
});

// Ordenar cuentas de compradoras
btnSortBuyers.addEventListener('click', () => {
    if (buyersSortMode === 'default') {
        buyersSortMode = 'name-asc';
        btnSortBuyers.classList.add('active');
        btnSortBuyers.title = 'Ordenar cuentas: Nombre A-Z';
        btnSortBuyers.innerHTML = '<i data-lucide="arrow-down-az"></i>';
        showToast('success', 'Cuentas ordenadas por Nombre (A-Z)');
    } else if (buyersSortMode === 'name-asc') {
        buyersSortMode = 'total-desc';
        btnSortBuyers.classList.add('active');
        btnSortBuyers.title = 'Ordenar cuentas: Mayor Compra';
        btnSortBuyers.innerHTML = '<i data-lucide="arrow-down-wide-narrow"></i>';
        showToast('success', 'Cuentas ordenadas por Mayor Compra');
    } else if (buyersSortMode === 'total-desc') {
        buyersSortMode = 'modified-desc';
        btnSortBuyers.classList.add('active');
        btnSortBuyers.title = 'Ordenar cuentas: Últimos modificados';
        btnSortBuyers.innerHTML = '<i data-lucide="history"></i>';
        showToast('success', 'Cuentas ordenadas por últimos modificados');
    } else {
        buyersSortMode = 'default';
        btnSortBuyers.classList.remove('active');
        btnSortBuyers.title = 'Ordenar cuentas: Por defecto';
        btnSortBuyers.innerHTML = '<i data-lucide="arrow-up-down"></i>';
        showToast('success', 'Restaurado orden de cuentas por defecto');
    }
    if (window.lucide) lucide.createIcons();
    renderSummaryView();
});

function renderSummaryView() {
    summaryBuyersList.innerHTML = '';

    const availableProducts = products.filter(p => !p.compradora || p.compradora.trim() === '');
    const soldProducts = products.filter(p => p.compradora && p.compradora.trim() !== '');

    // Agrupar por compradora
    const groups = {};
    let totalRecaudado = 0;

    soldProducts.forEach(p => {
        const comp = p.compradora.trim();
        if (!groups[comp]) {
            groups[comp] = {
                name: comp,
                products: [],
                totalPrice: 0
            };
        }
        groups[comp].products.push(p);
        const priceNum = parseFloat(p.price || 0);
        groups[comp].totalPrice += priceNum;
        totalRecaudado += priceNum;
    });

    let listBuyers = Object.values(groups);

    // Filtrar por término de búsqueda en el resumen (compradora o prenda)
    if (summarySearchTerm) {
        const t = summarySearchTerm.toLowerCase();
        listBuyers = listBuyers.filter(g =>
            g.name.toLowerCase().includes(t) ||
            g.products.some(p => p.name.toLowerCase().includes(t))
        );
    }

    let filteredAvailable = [...availableProducts];
    if (summarySearchTerm) {
        const t = summarySearchTerm.toLowerCase();
        filteredAvailable = filteredAvailable.filter(p => p.name.toLowerCase().includes(t));
    }

    if (products.length === 0) {
        summaryEmptyState.style.display = 'flex';
        summaryBuyersList.style.display = 'none';
        summaryEmptyState.querySelector('h2').textContent = 'Sin ventas adjudicadas';
        summaryEmptyState.querySelector('p').textContent = 'Asigna una Compradora a tus productos en el listado para ver sus cuentas aquí.';
        statTotalSoldMoney.textContent = '$0.00';
        statUniqueBuyers.textContent = '0';
        statTotalSoldQty.textContent = '0';
        return;
    }

    const hasFilteredBuyers = listBuyers.length > 0;
    const hasFilteredAvail = filteredAvailable.length > 0;

    if (!hasFilteredBuyers && !hasFilteredAvail) {
        summaryEmptyState.style.display = 'flex';
        summaryBuyersList.style.display = 'none';
        summaryEmptyState.querySelector('h2').textContent = 'Sin coincidencias';
        summaryEmptyState.querySelector('p').textContent = 'No hay cuentas ni productos que coincidan con tu búsqueda.';
    } else {
        summaryEmptyState.style.display = 'none';
        summaryBuyersList.style.display = 'flex';
    }

    // Ordenar cuentas de compradoras según el modo seleccionado
    if (buyersSortMode === 'name-asc') {
        listBuyers.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    } else if (buyersSortMode === 'total-desc') {
        listBuyers.sort((a, b) => b.totalPrice - a.totalPrice);
    } else if (buyersSortMode === 'modified-desc') {
        listBuyers.sort((a, b) => {
            const dateA = Math.max(...a.products.map(p => getLatestHistoryDate(p).getTime()));
            const dateB = Math.max(...b.products.map(p => getLatestHistoryDate(p).getTime()));
            return dateB - dateA;
        });
    }

    // Actualizar estadísticas en UI (totales de todas las adjudicadas, sin filtrar)
    statTotalSoldMoney.textContent = `$${fmtPrice(totalRecaudado)}`;
    statUniqueBuyers.textContent = Object.keys(groups).length;
    statTotalSoldQty.textContent = soldProducts.length;

    // Renderizar cada compradora
    listBuyers.forEach(g => {
        const groupCard = document.createElement('div');
        groupCard.className = 'summary-group-card';
        groupCard.id = `group-card-${g.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

        // Contenedor del recibo imprimible
        const receipt = document.createElement('div');
        receipt.className = 'summary-card-receipt';

        // Cabecera del grupo (Botón de copiar a la izquierda del total)
        const header = document.createElement('div');
        header.className = 'summary-group-header';
        header.innerHTML = `
            <div class="group-user-info">
                <i data-lucide="user-check"></i>
                <div>
                    <span class="group-user-name">Compradora: ${escHtml(g.name)}</span>
                    <span class="group-qty-badge">${g.products.length} ${g.products.length === 1 ? 'producto' : 'productos'}</span>
                </div>
            </div>
            <div class="group-totals-actions" style="display: flex; align-items: center; gap: 8px;">
                <button type="button" class="btn-copy-img" data-comp-name="${escHtml(g.name)}" title="Copiar Imagen">
                    <i data-lucide="image"></i>
                </button>
                <span class="group-total-amount">Total: $${fmtPrice(g.totalPrice)}</span>
            </div>
        `;

        // Grid de productos
        const grid = document.createElement('div');
        grid.className = 'summary-group-products-grid';

        g.products.forEach(p => {
            const item = document.createElement('div');
            item.className = 'summary-product-item';

            const imgHtml = p.image
                ? `<img src="${p.image}" alt="${escHtml(p.name)}" loading="lazy">`
                : `<div class="card-no-image" style="height:100%;"><i data-lucide="image-off"></i><span style="font-size:0.65rem;">Sin imagen</span></div>`;

            item.innerHTML = `
                <div class="summary-prod-img">
                    ${imgHtml}
                </div>
                <div class="summary-prod-info">
                    <div class="summary-prod-name">${escHtml(p.name)}</div>
                    <div class="summary-prod-price">$${escHtml(p.price)}</div>
                </div>
            `;
            grid.appendChild(item);
        });

        // Pie de página del recibo (Fecha del último producto modificado)
        const lastModifiedTime = Math.max(...g.products.map(p => getLatestHistoryDate(p).getTime()));
        const lastModifiedDate = new Date(lastModifiedTime);
        const dateStr = lastModifiedDate.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

        const footer = document.createElement('div');
        footer.className = 'summary-group-footer';
        footer.innerHTML = `
            <span>Fecha: ${dateStr}</span>
            <span class="summary-group-footer-brand"><i data-lucide="shopping-bag" style="width: 11px; height: 11px; display: inline-block; vertical-align: -1px; margin-right: 3px;"></i>Bonito Bazar</span>
        `;

        receipt.appendChild(header);
        receipt.appendChild(grid);
        receipt.appendChild(footer);

        groupCard.appendChild(receipt);
        summaryBuyersList.appendChild(groupCard);

        // Evento de copia de imagen al portapapeles
        const btnCopy = header.querySelector('.btn-copy-img');
        btnCopy.addEventListener('click', async (e) => {
            e.stopPropagation();
            await copyCardAsImage(receipt, btnCopy);
        });
    });

    // Renderizar tarjeta de prendas disponibles (si hay)
    if (filteredAvailable.length > 0) {
        const availCard = document.createElement('div');
        availCard.className = 'summary-group-card';
        availCard.id = 'group-card-disponibles';

        // Contenedor del recibo imprimible
        const receipt = document.createElement('div');
        receipt.className = 'summary-card-receipt';

        const header = document.createElement('div');
        header.className = 'summary-group-header';
        header.innerHTML = `
            <div class="group-user-info">
                <i data-lucide="package"></i>
                <div>
                    <span class="group-user-name">Prendas Disponibles</span>
                    <span class="group-qty-badge">${filteredAvailable.length} ${filteredAvailable.length === 1 ? 'producto' : 'productos'}</span>
                </div>
            </div>
            <div class="group-totals-actions">
                <button type="button" class="btn-copy-img" data-comp-name="Disponibles" title="Copiar Imagen">
                    <i data-lucide="image"></i>
                </button>
            </div>
        `;

        const grid = document.createElement('div');
        grid.className = 'summary-group-products-grid';

        filteredAvailable.forEach(p => {
            const item = document.createElement('div');
            item.className = 'summary-product-item';

            const imgHtml = p.image
                ? `<img src="${p.image}" alt="${escHtml(p.name)}" loading="lazy">`
                : `<div class="card-no-image" style="height:100%;"><i data-lucide="image-off"></i><span style="font-size:0.65rem;">Sin imagen</span></div>`;

            item.innerHTML = `
                <div class="summary-prod-img">
                    ${imgHtml}
                </div>
                <div class="summary-prod-info">
                    <div class="summary-prod-name">${escHtml(p.name)}</div>
                    <div class="summary-prod-price">$${escHtml(p.price)}</div>
                </div>
            `;
            grid.appendChild(item);
        });

        // Fecha del último producto disponible modificado
        const lastModifiedTimeAvail = Math.max(...filteredAvailable.map(p => getLatestHistoryDate(p).getTime()));
        const lastModifiedDateAvail = new Date(lastModifiedTimeAvail);
        const dateStrAvail = lastModifiedDateAvail.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

        const footer = document.createElement('div');
        footer.className = 'summary-group-footer';
        footer.innerHTML = `
            <span>Fecha: ${dateStrAvail}</span>
            <span class="summary-group-footer-brand"><i data-lucide="shopping-bag" style="width: 11px; height: 11px; display: inline-block; vertical-align: -1px; margin-right: 3px;"></i>Bonito Bazar</span>
        `;

        receipt.appendChild(header);
        receipt.appendChild(grid);
        receipt.appendChild(footer);

        availCard.appendChild(receipt);
        summaryBuyersList.appendChild(availCard);

        const btnCopy = header.querySelector('.btn-copy-img');
        btnCopy.addEventListener('click', async (e) => {
            e.stopPropagation();
            await copyCardAsImage(receipt, btnCopy);
        });
    }

    if (window.lucide) lucide.createIcons();
}


async function copyCardAsImage(cardElement, buttonElement) {
    if (!window.html2canvas) {
        showToast('error', 'Librería de captura no cargada. Revisa tu conexión.');
        return;
    }

    buttonElement.classList.add('loading');
    buttonElement.innerHTML = '<i data-lucide="loader"></i>';
    if (window.lucide) lucide.createIcons();

    // Ocultar temporalmente el botón de copiar para que no salga en la captura de imagen
    const copyBtn = cardElement.querySelector('.btn-copy-img');
    if (copyBtn) copyBtn.style.visibility = 'hidden';

    // Para un look más premium en la captura, le damos un fondo oscuro sólido (o el que corresponda al tema activo)
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDark ? '#161832' : '#ffffff';

    try {
        const canvas = await html2canvas(cardElement, {
            backgroundColor: bgColor,
            scale: 2, // Calidad HD
            logging: false,
            useCORS: true
        });

        canvas.toBlob(async (blob) => {
            try {
                if (!blob) throw new Error('No se pudo generar la imagen');
                await navigator.clipboard.write([
                    new ClipboardItem({
                        [blob.type]: blob
                    })
                ]);
                showToast('success', '¡Imagen del resumen copiada! Lista para enviar (Ctrl+V).');

                // Marcar la tarjeta como copiada e icono de check
                cardElement.classList.add('copied');
                buttonElement.innerHTML = '<i data-lucide="check"></i>';
                if (window.lucide) lucide.createIcons();

                // Autoscroll suave a la siguiente tarjeta si existe
                const nextCard = cardElement.parentElement.nextElementSibling;
                if (nextCard && nextCard.classList.contains('summary-group-card')) {
                    setTimeout(() => {
                        nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 400);
                }
            } catch (err) {
                showToast('error', 'No se pudo copiar al portapapeles: ' + err.message);
                buttonElement.innerHTML = '<i data-lucide="image"></i>';
                if (window.lucide) lucide.createIcons();
            } finally {
                if (copyBtn) copyBtn.style.visibility = 'visible';
                buttonElement.classList.remove('loading');
            }
        }, 'image/png');
    } catch (err) {
        showToast('error', 'Error al generar la imagen: ' + err.message);
        if (copyBtn) copyBtn.style.visibility = 'visible';
        buttonElement.classList.remove('loading');
        buttonElement.innerHTML = '<i data-lucide="image"></i>';
        if (window.lucide) lucide.createIcons();
    }
}

// Limpiar estados de copiado y búsqueda en caliente
function clearCopiedIndicators() {
    document.querySelectorAll('.summary-card-receipt.copied').forEach(el => {
        el.classList.remove('copied');
    });
    document.querySelectorAll('.btn-copy-img').forEach(btn => {
        btn.innerHTML = '<i data-lucide="image"></i>';
    });

    // Limpiar input y estado de búsqueda en el modal
    if (summarySearchInput) {
        summarySearchInput.value = '';
    }
    summarySearchTerm = '';

    if (window.lucide) lucide.createIcons();
}

// ── SISTEMA DE SCROLL FLOTANTE DINÁMICO ───────────────────────
function getScrollState() {
    if (summaryView && summaryView.style.display === 'flex') {
        const current = summaryView.scrollTop;
        const max = summaryView.scrollHeight - summaryView.clientHeight;
        return { current, max, container: summaryView };
    } else {
        const current = window.scrollY;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        return { current, max, container: window };
    }
}

function updateScrollButton() {
    if (!btnScrollToggle) return;

    const { current } = getScrollState();

    if (current < 80) {
        btnScrollToggle.title = "Ir al final";
        btnScrollToggle.setAttribute('aria-label', "Ir al final");
        btnScrollToggle.innerHTML = '<i data-lucide="arrow-down"></i>';
    } else {
        btnScrollToggle.title = "Ir al inicio";
        btnScrollToggle.setAttribute('aria-label', "Ir al inicio");
        btnScrollToggle.innerHTML = '<i data-lucide="arrow-up"></i>';
    }
    if (window.lucide) lucide.createIcons();
}

// ── INIT ─────────────────────────────────────────────────────
async function init() {
    // Restaurar tema
    const savedTheme = localStorage.getItem('subastalista_theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(savedTheme);

    try {
        await db.open();
        await loadFromStorage();

        // Cargar nombre de la lista activa en la UI
        const activeList = lists.find(l => l.id === activeListId);
        activeListName.textContent = activeList ? activeList.name : 'Lista Principal';
    } catch (err) {
        showToast('error', 'Error al inicializar la base de datos.');
    }

    renderProducts();
    updateCount();

    // Inicializar listeners del scroll flotante
    window.addEventListener('scroll', updateScrollButton);
    if (summaryView) {
        summaryView.addEventListener('scroll', updateScrollButton);
    }

    if (btnScrollToggle) {
        btnScrollToggle.addEventListener('click', () => {
            const { current, max, container } = getScrollState();
            if (current < 80) {
                container.scrollTo({ top: max, behavior: 'smooth' });
            } else {
                container.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }

    updateScrollButton();

    if (window.lucide) lucide.createIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
