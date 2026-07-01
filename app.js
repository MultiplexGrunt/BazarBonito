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
    writeBatch,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    getAuth,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

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

// Inicializar Firebase Auth y el proveedor de Google
const firebaseAuth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();

// Configuración de Administrador
const ADMIN_EMAIL = "toledooscar96@gmail.com";
const WHATSAPP_GROUP_URL = "https://chat.whatsapp.com/CdKKvGdHXSC3aq9FzARj5H?s=cl&p=a&ilr=2";
let isAdmin = false;             // Define si el usuario actual es Administrador
let userRoleDecided = true;      // El rol inicia directamente como visitante por defecto

// ── ESTADO ──────────────────────────────────────────────────
let lists = [];                // todas las listas en memoria
let activeListId = null;       // ID de la lista activa
let products = [];             // productos de la lista activa
let pendingImage = null;       // imagen capturada esperando ser guardada
let editingImageBase64 = null; // imagen en el modal de edición
let unsubscribeActiveList = null; // función para desvincular el listener en tiempo real
let lastUpdatedProductId = null; // ID del producto que se acaba de agregar o actualizar
let activeDeliveries = [];     // entregas de la lista activa
let unsubscribeActiveDeliveries = null; // función para desvincular el listener de entregas
let deliverySearchTerm = '';   // término de búsqueda de entregas
let deliveryFilterStatus = 'todos';     // 'todos', 'pendiente', 'pagado'
let deliveryFilterPlace = 'todos';      // 'todos', 'Tuxtla', 'Berriozabal', etc.
let deliveryFilterPayment = 'todos';    // 'todos', 'efectivo', 'transferencia', 'sin_especificar'
let deliverySortBy = 'name-asc';        // 'name-asc', 'items-desc', 'items-asc', 'total-desc', 'total-asc'
let historicalDeliveriesData = null;    // Caché de datos de entregas pasadas
let isLoadingHistory = false;

/**
 * Escucha los productos de la lista activa en tiempo real desde Firestore
 */
function listenToActiveListProducts() {
    if (unsubscribeActiveList) {
        unsubscribeActiveList();
        unsubscribeActiveList = null;
    }

    if (!activeListId) return;

    let isInitialLoad = true;

    unsubscribeActiveList = onSnapshot(
        collection(firestoreDb, "listas", activeListId, "productos"),
        (snapshot) => {
            const updatedProducts = [];

            // Detectar qué producto cambió si no es la carga inicial
            if (!isInitialLoad) {
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'added' || change.type === 'modified') {
                        lastUpdatedProductId = change.doc.id;
                    }
                });
            }
            isInitialLoad = false;

            snapshot.forEach(doc => {
                updatedProducts.push(doc.data());
            });
            // Ordenar descendente por fecha de creación para mostrar los más nuevos primero
            updatedProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            products = updatedProducts;

            // Sincronizar en el array general de listas
            const activeList = lists.find(l => l.id === activeListId);
            if (activeList) {
                activeList.products = products;
            }

            // Forzar renderizado de la UI
            renderProducts();
            updateCount();
        },
        (err) => {
            console.error("Error en listener en tiempo real de Firestore:", err);
        }
    );
}

/**
 * Escucha las entregas de la lista activa en tiempo real desde Firestore
 */
function listenToActiveListDeliveries() {
    if (unsubscribeActiveDeliveries) {
        unsubscribeActiveDeliveries();
        unsubscribeActiveDeliveries = null;
    }

    if (!activeListId) return;

    unsubscribeActiveDeliveries = onSnapshot(
        collection(firestoreDb, "listas", activeListId, "entregas"),
        (snapshot) => {
            const updatedDeliveries = [];
            snapshot.forEach(d => {
                updatedDeliveries.push(d.data());
            });
            activeDeliveries = updatedDeliveries;

            // Renderizar la vista de entregas si está visible
            if (deliveriesView && deliveriesView.style.display === 'flex') {
                renderDeliveries();
            }
        },
        (err) => {
            console.error("Error en listener de entregas en Firestore:", err);
        }
    );
}

// ── BASE DE DATOS (Firebase Firestore con Subcolecciones) ──────
const db = {
    async open() {
        return true;
    },

    async getLists() {
        try {
            const querySnapshot = await getDocs(collection(firestoreDb, "listas"));
            const fetchedLists = [];

            for (const d of querySnapshot.docs) {
                const listaData = d.data();
                // No precargar subcolecciones de productos por rendimiento (Lazy Loading)
                listaData.products = [];
                fetchedLists.push(listaData);
            }

            // Ordenar listas de más antiguas a más nuevas
            fetchedLists.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            return fetchedLists;
        } catch (err) {
            console.error("Error al obtener listas de Firestore:", err);
            throw err;
        }
    },

    async saveList(lista) {
        try {
            const { products: listProducts, ...listaMeta } = lista;
            const docRef = doc(firestoreDb, "listas", lista.id);
            await setDoc(docRef, listaMeta);

            // Si la lista trae productos (por ejemplo, en migraciones), guardarlos individualmente
            if (Array.isArray(listProducts)) {
                for (const prod of listProducts) {
                    await setDoc(doc(firestoreDb, "listas", lista.id, "productos", prod.id), prod);
                }
            }
        } catch (err) {
            console.error("Error al guardar lista en Firestore:", err);
            throw err;
        }
    },

    async deleteList(id) {
        try {
            // Eliminar primero todos los productos en la subcolección
            const prodSnapshot = await getDocs(collection(firestoreDb, "listas", id, "productos"));
            const deletePromises = [];
            prodSnapshot.forEach((pDoc) => {
                deletePromises.push(deleteDoc(doc(firestoreDb, "listas", id, "productos", pDoc.id)));
            });
            await Promise.all(deletePromises);

            // Eliminar el documento de la lista
            const docRef = doc(firestoreDb, "listas", id);
            await deleteDoc(docRef);
        } catch (err) {
            console.error("Error al eliminar lista de Firestore:", err);
            throw err;
        }
    },

    async saveProduct(listId, product) {
        try {
            await setDoc(doc(firestoreDb, "listas", listId, "productos", product.id), product);
        } catch (err) {
            console.error("Error al guardar producto atómicamente:", err);
            throw err;
        }
    },

    async deleteProduct(listId, productId) {
        try {
            await deleteDoc(doc(firestoreDb, "listas", listId, "productos", productId));
        } catch (err) {
            console.error("Error al eliminar producto atómicamente:", err);
            throw err;
        }
    },

    async updateListMetadata(listId, name) {
        try {
            const listRef = doc(firestoreDb, "listas", listId);
            await setDoc(listRef, {
                id: listId,
                name: name,
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (err) {
            console.error("Error al actualizar metadata de lista:", err);
        }
    },

    async saveDelivery(listId, delivery) {
        try {
            await setDoc(doc(firestoreDb, "listas", listId, "entregas", delivery.compradora), delivery);
        } catch (err) {
            console.error("Error al guardar entrega:", err);
            throw err;
        }
    },

    async getDeliveries(listId) {
        try {
            const querySnapshot = await getDocs(collection(firestoreDb, "listas", listId, "entregas"));
            const deliveries = [];
            querySnapshot.forEach(d => {
                deliveries.push(d.data());
            });
            return deliveries;
        } catch (err) {
            console.error("Error al obtener entregas:", err);
            return [];
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
            // Obtener todas las listas actuales para borrarlas con sus subcolecciones
            const querySnapshot = await getDocs(collection(firestoreDb, "listas"));
            for (const d of querySnapshot.docs) {
                await this.deleteList(d.id);
            }

            // Subir las nuevas listas, sus productos y sus entregas uno a uno
            let lIdx = 1;
            for (const lista of listsArray) {
                const { products: listProducts, entregas: listEntregas, ...listaMeta } = lista;
                showToast('info', `Restaurando lista ${lIdx} de ${listsArray.length}...`);

                // Guardar la metadata de la lista
                const docRef = doc(firestoreDb, "listas", lista.id);
                await setDoc(docRef, listaMeta);

                // Guardar cada producto individualmente de forma secuencial en su subcolección
                if (Array.isArray(listProducts)) {
                    let pIdx = 1;
                    for (const prod of listProducts) {
                        showToast('info', `Restaurando: Lista ${lIdx}/${listsArray.length} (Prenda ${pIdx}/${listProducts.length})...`);
                        await setDoc(doc(firestoreDb, "listas", lista.id, "productos", prod.id), prod);
                        // Delay mínimo de 80ms para evitar saturación del WebChannel
                        await new Promise(resolve => setTimeout(resolve, 80));
                        pIdx++;
                    }
                }

                // Restaurar entregas de la lista si existen en el backup
                if (Array.isArray(listEntregas)) {
                    for (const entrega of listEntregas) {
                        await setDoc(doc(firestoreDb, "listas", lista.id, "entregas", entrega.compradora), entrega);
                    }
                }

                lIdx++;
            }

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
// ── PERSISTENCIA ─────────────────────────────────────────────
async function loadFromStorage() {
    try {
        // Cargar listas e ID activo
        lists = await db.getLists();
        activeListId = await db.getConfig('activeListId');

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

        // Seleccionar siempre la lista más reciente al ingresar a la aplicación
        if (lists.length > 0) {
            const sortedRecent = [...lists].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            activeListId = sortedRecent[0].id;
            await db.saveConfig('activeListId', activeListId);
        }

        // Cargar productos de la lista activa (inicialmente vacío por carga diferida)
        products = [];
    } catch (err) {
        showToast('error', 'Error al cargar de la base de datos: ' + err.message);
        products = [];
    }
}

// ── UTILIDADES ───────────────────────────────────────────────
function debounce(fn, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

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

// Redimensiona y comprime imagen para ahorrar Firestore y ancho de banda
function fileToBase64(file, maxPx = 650, q = 0.70) {
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
const inputTalla = document.getElementById('input-talla');
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
const editTalla = document.getElementById('edit-talla');
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
const btnOptimizeImages = document.getElementById('btn-optimize-images');
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

// Auth DOM
const welcomeOverlay = document.getElementById('welcome-overlay');
const btnLoginGoogle = document.getElementById('btn-login-google');
const btnVisitor = document.getElementById('btn-visitor');
const btnLogout = document.getElementById('btn-logout');

// Modal Vista Previa de Imagen (Visitante)
const imagePreviewModal = document.getElementById('image-preview-modal');
const imagePreviewImg = document.getElementById('image-preview-img');
const imagePreviewTitle = document.getElementById('image-preview-title');
const imagePreviewPrice = document.getElementById('image-preview-price');
const imagePreviewTime = document.getElementById('image-preview-time');
const btnCloseImagePreview = document.getElementById('btn-close-image-preview');

// Control de entregas
const btnShowDeliveries = document.getElementById('btn-show-deliveries');
const btnCloseDeliveries = document.getElementById('btn-close-deliveries');
const deliveriesView = document.getElementById('deliveries-view');
const deliverySearchInput = document.getElementById('delivery-search-input');
const deliveriesList = document.getElementById('deliveries-list');
const deliveriesEmptyState = document.getElementById('deliveries-empty-state');
const deliveryStatTotalMoney = document.getElementById('delivery-stat-total-money');
const deliveryStatPaidQty = document.getElementById('delivery-stat-paid-qty');
const deliveryStatPendingQty = document.getElementById('delivery-stat-pending-qty');

// ── AUTENTICACIÓN Y CONTROL DE ROLES (Google Sign-In) ─────────

/**
 * Actualiza de forma reactiva la interfaz del DOM según si el usuario es Admin o Visitante
 */
function updateRoleUI() {
    // 1. Ocultar pantalla de bienvenida si ya inició sesión como Admin
    if (welcomeOverlay && isAdmin) {
        welcomeOverlay.style.display = 'none';
    }

    // 2. Alternar clases de rol en el body
    if (isAdmin) {
        document.body.classList.add('is-admin');
        document.body.classList.remove('is-visitor');
    } else {
        document.body.classList.add('is-visitor');
        document.body.classList.remove('is-admin');
    }

    // 3. Deshabilitar/Habilitar visualmente el select de listas
    if (btnListSelect) {
        if (isAdmin) {
            btnListSelect.classList.remove('disabled');
            btnListSelect.removeAttribute('aria-disabled');
        } else {
            btnListSelect.classList.add('disabled');
            btnListSelect.setAttribute('aria-disabled', 'true');
        }
    }

    // 4. Mostrar/Ocultar totales de dinero en las columnas
    const totalAvailEl = document.getElementById('total-price-available');
    const totalSoldEl = document.getElementById('total-price-sold');
    if (totalAvailEl) {
        totalAvailEl.style.display = isAdmin ? 'inline-block' : 'none';
    }
    if (totalSoldEl) {
        totalSoldEl.style.display = isAdmin ? 'inline-block' : 'none';
    }

    // 5. Botón de cerrar sesión en el header
    if (btnLogout) {
        btnLogout.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (btnShowDeliveries) {
        btnShowDeliveries.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // 6. Botón de agregar producto
    if (btnToggleForm) {
        btnToggleForm.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // 7. Selector de herramientas administrativas (engranaje)
    const toolsContainer = document.querySelector('.tools-selector-container');
    if (toolsContainer) {
        toolsContainer.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // 8. Botones de acción administrativa en el menú de listas
    const dropdownActions = document.querySelector('.dropdown-actions');
    if (dropdownActions) {
        dropdownActions.style.display = isAdmin ? 'flex' : 'none';
    }
    const dropdownDivider = document.querySelector('.dropdown-divider');
    if (dropdownDivider) {
        dropdownDivider.style.display = isAdmin ? 'block' : 'none';
    }

    // 9. Comportamiento interactivo en el modal de edición/detalle de producto (solo para admin)
    if (editModal && editModal.style.display === 'flex') {
        const titleEl = document.getElementById('edit-modal-title');
        const submitBtn = editForm.querySelector('.btn-save-edit');
        const overlayImgAction = document.querySelector('.edit-image-overlay');
        const linkBtnImgAction = document.getElementById('btn-edit-add-image');

        if (isAdmin) {
            if (titleEl) titleEl.textContent = "Editar Producto";
            editName.disabled = false;
            editPrice.disabled = false;
            editCompradora.disabled = false;
            if (submitBtn) submitBtn.style.display = 'inline-flex';
            if (btnDeleteProduct) btnDeleteProduct.style.display = 'inline-flex';
            if (overlayImgAction) overlayImgAction.style.display = 'flex';
            if (linkBtnImgAction) linkBtnImgAction.style.display = 'inline-block';
        } else {
            // Teóricamente inalcanzable ahora que los visitantes no pueden abrir el modal
            if (titleEl) titleEl.textContent = "Detalle del Producto";
            editName.disabled = true;
            editPrice.disabled = true;
            editCompradora.disabled = true;
            if (submitBtn) submitBtn.style.display = 'none';
            if (btnDeleteProduct) btnDeleteProduct.style.display = 'none';
            if (overlayImgAction) overlayImgAction.style.display = 'none';
            if (linkBtnImgAction) linkBtnImgAction.style.display = 'none';
        }
    }
}

// Escuchar cambios de estado en Firebase Auth
onAuthStateChanged(firebaseAuth, async (user) => {
    if (user) {
        if (user.email === ADMIN_EMAIL) {
            isAdmin = true;
            userRoleDecided = true;
            showToast('success', `¡Bienvenido Administrador: ${user.displayName || user.email}!`);
        } else {
            // Usuario autenticado con Google pero no es el administrador
            isAdmin = false;
            userRoleDecided = true;
            showToast('error', 'Acceso denegado. Esta cuenta no es el Administrador.');
            // Cerrar sesión en Firebase inmediatamente
            try {
                await signOut(firebaseAuth);
            } catch (err) {
                console.error("Error al cerrar sesión no autorizada:", err);
            }
        }
    } else {
        isAdmin = false;
    }
    updateRoleUI();
    // Forzar renderizado para ajustar elementos según rol
    renderProducts();
});

// Registrar eventos de botones de la pantalla de bienvenida
if (btnLoginGoogle) {
    btnLoginGoogle.addEventListener('click', async () => {
        try {
            showToast('info', 'Conectando con Google...');
            await signInWithPopup(firebaseAuth, googleProvider);
        } catch (err) {
            console.error("Error al iniciar sesión con Google:", err);
            showToast('error', 'Error al conectar con Google: ' + err.message);
        }
    });
}

if (btnVisitor) {
    btnVisitor.addEventListener('click', () => {
        if (welcomeOverlay) {
            welcomeOverlay.style.display = 'none';
        }
        showToast('info', 'Sigues en modo de solo lectura (Visitante).');
    });
}

if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
        if (confirm('¿Cerrar sesión de Administrador?')) {
            try {
                await signOut(firebaseAuth);
                showToast('success', 'Sesión cerrada. Ahora eres visitante.');
            } catch (err) {
                showToast('error', 'Error al cerrar sesión: ' + err.message);
            }
        }
    });
}

// Abrir modal de inicio de sesión al hacer clic en el badge de total-count
const totalCountEl = document.getElementById('total-count');
if (totalCountEl) {
    totalCountEl.style.cursor = 'pointer';
    totalCountEl.addEventListener('click', () => {
        if (!isAdmin) {
            if (welcomeOverlay) {
                welcomeOverlay.style.display = 'flex';
            }
        } else {
            showToast('info', 'Ya iniciaste sesión como Administrador.');
        }
    });
}

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
    if (!isAdmin) return; // Restringir a Administrador
    if (e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        dragOverlay.classList.add('active');
    }
});

document.addEventListener('dragleave', e => {
    if (!isAdmin) return; // Restringir a Administrador
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.classList.remove('active');
    }
});

document.addEventListener('dragover', e => {
    if (!isAdmin) return; // Restringir a Administrador
    e.preventDefault(); // necesario para que drop funcione
});

document.addEventListener('drop', async e => {
    if (!isAdmin) return; // Restringir a Administrador
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
    if (!isAdmin) return; // Restringir a Administrador
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
    const talla = inputTalla.value;

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
        talla,
        image: pendingImage,
        compradora: '',
        createdAt: now,
        priceHistory: [
            { price: fmtPrice(price), compradora: '', timestamp: now, isBase: true }
        ],
    };

    // Actualización optimista local
    products.unshift(product);
    const activeList = lists.find(l => l.id === activeListId);
    if (activeList) activeList.products = products;

    // Guardado atómico en la nube
    db.saveProduct(activeListId, product)
        .then(() => db.updateListMetadata(activeListId, activeList ? activeList.name : ''))
        .catch(err => showToast('error', 'Error al guardar en la nube: ' + err.message));

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

    // Limpiar el ID después de renderizar para que no brille en futuros filtrados/búsquedas
    lastUpdatedProductId = null;
}

// Función auxiliar para generar la tarjeta
function createProductCard(p, i) {
    const card = document.createElement('article');
    card.className = 'product-card';
    if (p.id === lastUpdatedProductId) {
        card.classList.add('just-updated');
    }
    card.dataset.id = p.id;
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
            <div class="card-price">$${escHtml(p.price)}${p.talla ? ` <span class="card-talla" style="font-size: 0.74rem; font-weight: 600; color: var(--text-3); margin-left: 4px; vertical-align: middle;">• Talla ${escHtml(p.talla)}</span>` : ''}</div>
            ${p.compradora ? `<div class="card-compradora-info"><i data-lucide="user-check"></i>${escHtml(p.compradora)}</div>` : ''}
        </div>
    `;

    // Hover preview sobre la imagen (solo para administrador)
    if (p.image && isAdmin) {
        const imgDiv = card.querySelector('.card-image');
        imgDiv.addEventListener('mouseenter', e => showHoverPreview(p.image, e));
        imgDiv.addEventListener('mousemove', e => positionHoverPreview(e));
        imgDiv.addEventListener('mouseleave', () => hideHoverPreview());
    }

    card.addEventListener('click', () => {
        if (isAdmin) {
            openEditModal(p.id);
        } else {
            openImagePreview(p);
        }
    });
    card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (isAdmin) {
                openEditModal(p.id);
            } else {
                openImagePreview(p);
            }
        }
    });

    return card;
}

    function updateCount() {
        totalCount.textContent = products.length;
    }

    // ── BÚSQUEDA ─────────────────────────────────────────────────
    searchInput.addEventListener('input', debounce(() => {
        searchTerm = searchInput.value;
        renderProducts();
    }, 100));

    summarySearchInput.addEventListener('input', debounce(() => {
        summarySearchTerm = summarySearchInput.value;
        filterSummaryView();
    }, 100));

    // Redirección automática de foco a la búsqueda (Type-to-Search)
    document.addEventListener('keydown', (e) => {
        // 0. Ignorar si la pantalla de bienvenida de roles está abierta
        if (welcomeOverlay && welcomeOverlay.style.display === 'flex') {
            return;
        }

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

            const revertBtn = (!isCurrent && isAdmin)
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
        editTalla.value = p.talla || '';
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

        // Renderizar historial (tomará en cuenta isAdmin)
        renderPriceHistory(p);

        editModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        // Aplicar adaptaciones visuales de rol al modal
        updateRoleUI();

        if (window.lucide) lucide.createIcons();

        // Foco condicional: solo para el administrador
        if (isAdmin) {
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
    }

    function closeEditModal() {
        editModal.style.display = 'none';
        document.body.style.overflow = '';
        editingImageBase64 = null;
    }

    // ── MODAL VISTA PREVIA DE IMAGEN (VISITANTE) ──
    function openImagePreview(p) {
        if (!p.image) {
            showToast('info', 'Esta prenda no cuenta con una imagen.');
            return;
        }
        imagePreviewImg.src = p.image;
        imagePreviewTitle.textContent = p.name;
        imagePreviewPrice.textContent = `$${p.price}${p.talla ? ` • Talla: ${p.talla}` : ''}`;

        // Obtener la hora aproximada de subasta (12 horas AM/PM) sin fecha
        let timeStr = '--:--';
        if (p.createdAt) {
            const d = new Date(p.createdAt);
            timeStr = d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit', hour12: true });
            timeStr = timeStr.replace(/a\.\s*m\./i, 'AM').replace(/p\.\s*m\./i, 'PM').replace(/am/i, 'AM').replace(/pm/i, 'PM');
        }
        if (imagePreviewTime) {
            imagePreviewTime.innerHTML = `<i data-lucide="clock" style="width: 12px; height: 12px; flex-shrink:0;"></i> Subido a las ${timeStr}`;
        }

        imagePreviewModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        if (window.lucide) lucide.createIcons();
    }

    function closeImagePreview() {
        imagePreviewModal.style.display = 'none';
        document.body.style.overflow = '';
        imagePreviewImg.src = '';
    }

    btnCloseModal.addEventListener('click', closeEditModal);
    editModal.addEventListener('click', e => { if (e.target === editModal) closeEditModal(); });

    if (btnCloseImagePreview) {
        btnCloseImagePreview.addEventListener('click', closeImagePreview);
    }
    if (imagePreviewModal) {
        imagePreviewModal.addEventListener('click', e => { if (e.target === imagePreviewModal) closeImagePreview(); });
    }
    if (imagePreviewTime) {
        imagePreviewTime.addEventListener('click', () => {
            if (WHATSAPP_GROUP_URL) {
                window.open(WHATSAPP_GROUP_URL, '_blank');
            }
        });
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (editModal.style.display === 'flex') closeEditModal();
            if (imagePreviewModal.style.display === 'flex') closeImagePreview();
        }
    });

    // Guardar edición (también con Enter)
    editForm.addEventListener('submit', e => {
        e.preventDefault();

        const name = editName.value.trim();
        const price = editPrice.value;
        const talla = editTalla.value;

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

        const updatedProduct = {
            ...products[idx],
            name,
            price: newPrice,
            talla,
            compradora: newComp,
            image: editingImageBase64,
            updatedAt: new Date().toISOString(),
            priceHistory: updatedHistory,
        };

        // Actualización optimista local
        products[idx] = updatedProduct;
        const activeList = lists.find(l => l.id === activeListId);
        if (activeList) activeList.products = products;

        // Guardado atómico en la nube
        db.saveProduct(activeListId, updatedProduct)
            .then(() => db.updateListMetadata(activeListId, activeList ? activeList.name : ''))
            .catch(err => showToast('error', 'Error al guardar cambios: ' + err.message));

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

        // Actualización optimista local
        products = products.filter(x => x.id !== id);
        const activeList = lists.find(l => l.id === activeListId);
        if (activeList) activeList.products = products;

        // Eliminación atómica en la nube
        db.deleteProduct(activeListId, id)
            .then(() => db.updateListMetadata(activeListId, activeList ? activeList.name : ''))
            .catch(err => showToast('error', 'Error al eliminar el producto en la nube: ' + err.message));

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
        activeListName.textContent = activeList ? activeList.name : 'Sin nombre';

        // Iniciar listener de productos en tiempo real para esta nueva lista
        listenToActiveListProducts();
        listenToActiveListDeliveries();

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
        if (!isAdmin) return; // Bloquear dropdown de listas para visitante
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
            activeListName.textContent = activeListObj.name;

            // Iniciar el listener de la nueva lista seleccionada
            listenToActiveListProducts();
            listenToActiveListDeliveries();

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
                activeListName.textContent = val;

                closePromptModal();
                // Iniciar listener en tiempo real de la nueva lista
                listenToActiveListProducts();
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
            showToast('info', 'Generando copia de seguridad, por favor espera...');
            const allLists = await db.getLists();
            const activeId = await db.getConfig('activeListId');

            if (allLists.length === 0) {
                showToast('error', 'No hay información para exportar.');
                return;
            }

            // Cargar de forma explícita los productos y entregas de cada lista para el backup
            for (const lista of allLists) {
                const prodSnapshot = await getDocs(collection(firestoreDb, "listas", lista.id, "productos"));
                const prodList = [];
                prodSnapshot.forEach((pDoc) => {
                    prodList.push(pDoc.data());
                });
                prodList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                lista.products = prodList;

                lista.entregas = await db.getDeliveries(lista.id);
            }

            const backupData = {
                version: 2,
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

    // Auxiliar para redimensionar y comprimir una cadena Base64 existente
    function optimizeBase64Image(base64, maxPx = 650, q = 0.70) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
            img.onload = () => {
                let { width: w, height: h } = img;
                if (w > maxPx || h > maxPx) {
                    const r = Math.min(maxPx / w, maxPx / h);
                    w = Math.round(w * r);
                    h = Math.round(h * r);
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', q));
            };
            img.src = base64;
        });
    }

    // Proceso secuencial de optimización de imágenes en lote para Firestore
    async function handleMassImageOptimization() {
        if (!isAdmin) return;
        const confirmMsg = `¿Deseas iniciar la optimización masiva de fotos existentes?\n\n` +
            `Este proceso reducirá todas las imágenes de tu base de datos a un máximo de 650px y 70% de calidad.\n` +
            `¡RECOMENDACIÓN!: Genera una copia de seguridad en el menú de herramientas antes de proceder.`;
        
        if (!confirm(confirmMsg)) return;

        try {
            showToast('info', 'Obteniendo listas de Firestore para optimizar...');
            const allLists = await db.getLists();
            let totalProcessed = 0;
            let totalCompressed = 0;

            for (let lIdx = 0; lIdx < allLists.length; lIdx++) {
                const lista = allLists[lIdx];
                const prodSnapshot = await getDocs(collection(firestoreDb, "listas", lista.id, "productos"));
                const productsArray = [];
                prodSnapshot.forEach(doc => {
                    productsArray.push(doc.data());
                });

                for (let pIdx = 0; pIdx < productsArray.length; pIdx++) {
                    const prod = productsArray[pIdx];
                    if (prod.image && prod.image.startsWith('data:image/')) {
                        showToast('info', `Comprimiendo: Lista ${lIdx + 1}/${allLists.length} (Prenda ${pIdx + 1}/${productsArray.length})...`);
                        
                        try {
                            const optimized = await optimizeBase64Image(prod.image);
                            if (optimized && optimized.length < prod.image.length) {
                                prod.image = optimized;
                                prod.updatedAt = new Date().toISOString();
                                await db.saveProduct(lista.id, prod);
                                totalCompressed++;
                            }
                        } catch (imgErr) {
                            console.error(`Error al optimizar imagen de prenda ${prod.name}:`, imgErr);
                        }
                    }
                    totalProcessed++;
                }

                if (lista.id === activeListId) {
                    products = productsArray;
                    lista.products = productsArray;
                    renderProducts();
                    updateCount();
                }
            }

            showToast('success', `¡Optimización completada! Se analizaron ${totalProcessed} prendas y se comprimieron ${totalCompressed} imágenes.`);
        } catch (err) {
            console.error("Error en optimización masiva de fotos:", err);
            showToast('error', 'Error al optimizar imágenes de Firestore: ' + err.message);
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

    if (btnOptimizeImages) {
        btnOptimizeImages.addEventListener('click', async () => {
            closeToolsDropdown();
            await handleMassImageOptimization();
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

    function filterSummaryView() {
        const term = summarySearchTerm.toLowerCase().trim();
        const cards = Array.from(summaryBuyersList.querySelectorAll('.summary-group-card'));
        let visibleCount = 0;

        cards.forEach(card => {
            const compName = card.dataset.compName ? card.dataset.compName.toLowerCase() : '';
            const prodNames = card.dataset.prodNames ? card.dataset.prodNames.toLowerCase() : '';
            const match = compName.includes(term) || prodNames.includes(term);
            card.style.display = match ? 'block' : 'none';
            if (match) visibleCount++;
        });

        if (cards.length === 0) {
            summaryEmptyState.style.display = 'flex';
            summaryBuyersList.style.display = 'none';
            summaryEmptyState.querySelector('h2').textContent = 'Sin ventas adjudicadas';
            summaryEmptyState.querySelector('p').textContent = 'Asigna una Compradora a tus productos en el listado para ver sus cuentas aquí.';
        } else if (visibleCount === 0) {
            summaryEmptyState.style.display = 'flex';
            summaryBuyersList.style.display = 'none';
            summaryEmptyState.querySelector('h2').textContent = 'Sin coincidencias';
            summaryEmptyState.querySelector('p').textContent = 'No hay cuentas ni productos que coincidan con tu búsqueda.';
        } else {
            summaryEmptyState.style.display = 'none';
            summaryBuyersList.style.display = 'flex';
        }
    }

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

        summaryEmptyState.style.display = 'none';
        summaryBuyersList.style.display = 'flex';

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
            groupCard.dataset.compName = g.name;
            groupCard.dataset.prodNames = g.products.map(p => p.name).join(' | ');

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
        if (availableProducts.length > 0) {
            const availCard = document.createElement('div');
            availCard.className = 'summary-group-card';
            availCard.id = 'group-card-disponibles';
            availCard.dataset.compName = 'disponibles';
            availCard.dataset.prodNames = availableProducts.map(p => p.name).join(' | ');

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
                    <span class="group-qty-badge">${availableProducts.length} ${availableProducts.length === 1 ? 'producto' : 'productos'}</span>
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

            availableProducts.forEach(p => {
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
            const lastModifiedTimeAvail = Math.max(...availableProducts.map(p => getLatestHistoryDate(p).getTime()));
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

        // Aplicar el filtro de búsqueda actual al finalizar el renderizado
        filterSummaryView();

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
        } else if (deliveriesView && deliveriesView.style.display === 'flex') {
            const current = deliveriesView.scrollTop;
            const max = deliveriesView.scrollHeight - deliveriesView.clientHeight;
            return { current, max, container: deliveriesView };
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

            // Iniciar la escucha en tiempo real de productos
            listenToActiveListProducts();
            listenToActiveListDeliveries();
        } catch (err) {
            showToast('error', 'Error al inicializar la base de datos.');
            renderProducts();
            updateCount();
        }

        // Inicializar listeners del scroll flotante
        window.addEventListener('scroll', updateScrollButton);
        if (summaryView) {
            summaryView.addEventListener('scroll', updateScrollButton);
        }
        if (deliveriesView) {
            deliveriesView.addEventListener('scroll', updateScrollButton);
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

    function getBuyerMapFromProducts(productsArray) {
        const buyerMap = {};
        productsArray.forEach(p => {
            if (!p.compradora) return;
            const name = p.compradora.trim();
            if (!buyerMap[name]) buyerMap[name] = { total: 0, items: [], images: [] };
            buyerMap[name].total += parseFloat(p.price) || 0;
            buyerMap[name].items.push({ name: p.name, price: p.price });
            if (p.image) buyerMap[name].images.push({ src: p.image, name: p.name });
        });
        return buyerMap;
    }

    async function loadHistoricalDeliveries() {
        if (historicalDeliveriesData || isLoadingHistory) return;
        isLoadingHistory = true;

        // Mostrar un pequeño indicador en el header del panel de entregas
        let indicator = document.getElementById('history-loading-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'history-loading-indicator';
            indicator.className = 'history-loading-indicator';
            indicator.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 14px; height: 14px;"></i> Cargando historial...';
            const header = document.querySelector('.summary-view-header');
            if (header) {
                const headerActions = header.querySelector('.summary-header-actions');
                if (headerActions) {
                    header.insertBefore(indicator, headerActions);
                } else {
                    header.appendChild(indicator);
                }
            }
            if (window.lucide) lucide.createIcons();
        }

        try {
            const history = {};
            const pastLists = lists.filter(l => l.id !== activeListId);

            const promises = pastLists.map(async (lista) => {
                try {
                    const [prodSnapshot, delSnapshot] = await Promise.all([
                        getDocs(collection(firestoreDb, "listas", lista.id, "productos")),
                        getDocs(collection(firestoreDb, "listas", lista.id, "entregas"))
                    ]);

                    const prods = [];
                    prodSnapshot.forEach(doc => prods.push(doc.data()));

                    const dels = [];
                    delSnapshot.forEach(doc => dels.push(doc.data()));

                    history[lista.id] = {
                        id: lista.id,
                        name: lista.name,
                        createdAt: lista.createdAt,
                        products: prods,
                        deliveries: dels
                    };
                } catch (e) {
                    console.error(`Error cargando historial de la lista ${lista.name}:`, e);
                }
            });

            await Promise.all(promises);
            historicalDeliveriesData = history;
        } catch (err) {
            console.error("Error al cargar historial de entregas:", err);
        } finally {
            isLoadingHistory = false;
            const ind = document.getElementById('history-loading-indicator');
            if (ind) ind.remove();

            if (deliverySearchTerm) {
                filterDeliveries();
            }
        }
    }

    // ── SECCIÓN ENTREGAS ──────────────────────────────────────────

    function openDeliveriesView() {
        // Resetear variables de filtros al abrir
        deliverySearchTerm = '';
        deliveryFilterStatus = 'todos';
        deliveryFilterPlace = 'todos';
        deliveryFilterPayment = 'todos';
        deliverySortBy = 'name-asc';

        // Sincronizar UI de filtros
        if (deliverySearchInput) deliverySearchInput.value = '';
        
        const statusSegments = document.querySelectorAll('#delivery-filter-status .btn-segment');
        statusSegments.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.value === 'todos');
        });

        const paymentSegments = document.querySelectorAll('#delivery-filter-payment .btn-segment');
        paymentSegments.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.value === 'todos');
        });

        const placeSelect = document.getElementById('delivery-filter-place');
        if (placeSelect) placeSelect.value = 'todos';

        const sortBySelect = document.getElementById('delivery-sort-by');
        if (sortBySelect) sortBySelect.value = 'name-asc';

        renderDeliveries();
        deliveriesView.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        updateScrollButton();
        if (window.lucide) lucide.createIcons();

        // Cargar el historial en segundo plano para las búsquedas
        loadHistoricalDeliveries();
    }

    function closeDeliveriesView() {
        deliveriesView.style.display = 'none';
        document.body.style.overflow = '';
        if (deliverySearchInput) deliverySearchInput.value = '';
        deliverySearchTerm = '';
        updateScrollButton();
    }

    function filterDeliveries() {
        const term = deliverySearchTerm.toLowerCase().trim();
        const rows = Array.from(deliveriesList.querySelectorAll('.delivery-row'));

        if (!term) {
            // Si el buscador por texto está vacío, mostramos solo entregas de la lista activa (DOM actual)
            let visibleCount = 0;
            rows.forEach(row => {
                // Asegurar que no mostramos registros del historial pasada si no hay búsqueda
                if (row.classList.contains('past-list-row')) {
                    row.style.display = 'none';
                    return;
                }

                const status = row.dataset.status;
                const lugar = row.dataset.lugar;
                const paymentType = row.dataset.paymentType;

                let matchStatus = true;
                if (deliveryFilterStatus !== 'todos') {
                    matchStatus = (status === deliveryFilterStatus);
                }

                let matchPlace = true;
                if (deliveryFilterPlace !== 'todos') {
                    if (deliveryFilterPlace === 'sin_especificar') {
                        matchPlace = (lugar === '');
                    } else {
                        matchPlace = (lugar === deliveryFilterPlace);
                    }
                }

                let matchPayment = true;
                if (deliveryFilterPayment !== 'todos') {
                    if (deliveryFilterPayment === 'sin_especificar') {
                        matchPayment = (paymentType === '');
                    } else {
                        matchPayment = (paymentType === deliveryFilterPayment);
                    }
                }

                const visible = matchStatus && matchPlace && matchPayment;
                row.style.display = visible ? 'flex' : 'none';
                if (visible) visibleCount++;
            });

            // Ocultar métricas si hay filtros de estatus/lugar/pago activos
            const hasActiveFilters = deliveryFilterStatus !== 'todos' || deliveryFilterPlace !== 'todos' || deliveryFilterPayment !== 'todos';
            const statsGrid = deliveriesView ? deliveriesView.querySelector('.summary-stats-grid') : null;
            if (statsGrid) statsGrid.style.display = hasActiveFilters ? 'none' : '';

            const filtersBar = deliveriesView ? deliveriesView.querySelector('.deliveries-filters-bar') : null;
            if (filtersBar) filtersBar.style.display = 'grid';

            if (rows.filter(r => !r.classList.contains('past-list-row')).length === 0) {
                deliveriesList.style.display = 'none';
                deliveriesEmptyState.style.display = 'block';
                deliveriesEmptyState.querySelector('h2').textContent = 'Sin entregas que mostrar';
                deliveriesEmptyState.querySelector('p').textContent = 'Adjudica productos a compradoras para ver e iniciar la gestión de entregas.';
            } else if (visibleCount === 0) {
                deliveriesList.style.display = 'none';
                deliveriesEmptyState.style.display = 'block';
                deliveriesEmptyState.querySelector('h2').textContent = 'Sin coincidencias';
                deliveriesEmptyState.querySelector('p').textContent = 'No hay entregas que coincidan con los filtros aplicados.';
            } else {
                deliveriesList.style.display = 'flex';
                deliveriesEmptyState.style.display = 'none';
            }
            return;
        }

        // --- BÚSQUEDA ACTIVA POR TEXTO (INCLUYE HISTORIAL PASADO) ---
        const results = [];

        // 1. Coincidencias de la lista activa
        const activeBuyerMap = getBuyerMapFromProducts(products);
        const activeListMeta = lists.find(l => l.id === activeListId) || { name: 'Lista Activa', createdAt: new Date().toISOString() };

        Object.keys(activeBuyerMap).forEach(name => {
            const buyerData = activeBuyerMap[name];
            const prodNames = buyerData.items.map(i => i.name).join(' | ');

            if (name.toLowerCase().includes(term) || prodNames.toLowerCase().includes(term)) {
                const delivery = activeDeliveries.find(d => d.compradora === name) || {
                    compradora: name, status: 'pendiente', paymentType: '', lugar: '', updatedAt: new Date().toISOString()
                };
                results.push({
                    isCurrentList: true,
                    listId: activeListId,
                    listName: activeListMeta.name,
                    listCreatedAt: activeListMeta.createdAt,
                    compradora: name,
                    total: buyerData.total,
                    items: buyerData.items,
                    images: buyerData.images,
                    delivery: delivery
                });
            }
        });

        // 2. Coincidencias de las listas pasadas (historial cargado)
        if (historicalDeliveriesData) {
            Object.keys(historicalDeliveriesData).forEach(listId => {
                const hist = historicalDeliveriesData[listId];
                const histBuyerMap = getBuyerMapFromProducts(hist.products);

                Object.keys(histBuyerMap).forEach(name => {
                    const buyerData = histBuyerMap[name];
                    const prodNames = buyerData.items.map(i => i.name).join(' | ');

                    if (name.toLowerCase().includes(term) || prodNames.toLowerCase().includes(term)) {
                        const delivery = hist.deliveries.find(d => d.compradora === name) || {
                            compradora: name, status: 'pendiente', paymentType: '', lugar: '', updatedAt: new Date().toISOString()
                        };
                        results.push({
                            isCurrentList: false,
                            listId: listId,
                            listName: hist.name,
                            listCreatedAt: hist.createdAt,
                            compradora: name,
                            total: buyerData.total,
                            items: buyerData.items,
                            images: buyerData.images,
                            delivery: delivery
                        });
                    }
                });
            });
        }

        // 3. Ordenar resultados: más recientes primero (listCreatedAt desc)
        results.sort((a, b) => new Date(b.listCreatedAt) - new Date(a.listCreatedAt));

        // Ocultar barra de filtros y métricas si hay búsqueda activa por texto (libera espacio en móvil)
        const filtersBar = deliveriesView ? deliveriesView.querySelector('.deliveries-filters-bar') : null;
        if (filtersBar) filtersBar.style.display = 'none';

        const statsGrid = deliveriesView ? deliveriesView.querySelector('.summary-stats-grid') : null;
        if (statsGrid) statsGrid.style.display = 'none';

        // Pintar resultados compilados
        if (results.length === 0) {
            deliveriesList.style.display = 'none';
            deliveriesEmptyState.style.display = 'block';
            deliveriesEmptyState.querySelector('h2').textContent = 'Sin coincidencias';
            deliveriesEmptyState.querySelector('p').textContent = 'No encontramos compras ni prendas con ese nombre en ninguna de las listas.';
            return;
        }

        deliveriesList.style.display = 'flex';
        deliveriesEmptyState.style.display = 'none';
        deliveriesList.innerHTML = '';

        results.forEach(res => {
            const row = document.createElement('div');
            row.className = `delivery-row ${res.isCurrentList ? '' : 'past-list-row'}`;
            row.dataset.compradora = res.compradora;
            row.dataset.status = res.delivery.status;
            row.dataset.lugar = res.delivery.lugar || '';
            row.dataset.paymentType = res.delivery.paymentType || '';

            const imagesHtml = res.images.length > 0
                ? `<div class="delivery-images-grid">${res.images.map(img =>
                    `<img class="delivery-thumb" src="${img.src}" alt="${escHtml(img.name)}" title="${escHtml(img.name)}">`
                  ).join('')}</div>`
                : '';

            if (res.isCurrentList) {
                const isPagado = res.delivery.status === 'pagado';
                const statusClass = isPagado ? 'status-pagado' : 'status-pendiente';
                const statusIcon = isPagado ? 'check-circle' : 'clock';
                const statusLabel = isPagado ? 'Pagado' : 'Pendiente';
                const paymentDisabledClass = isPagado ? '' : 'disabled';

                row.innerHTML = `
                    <div class="delivery-card-header">
                        <div class="delivery-buyer-name">
                            <i data-lucide="user"></i>
                            ${escHtml(res.compradora)}
                            <span class="badge-list-current">Lista Activa</span>
                        </div>
                        <div class="delivery-header-right">
                            <div class="delivery-buyer-total">$${res.total.toFixed(2)}</div>
                            <div class="delivery-buyer-items-hint">${res.items.length} prenda${res.items.length !== 1 ? 's' : ''}</div>
                        </div>
                    </div>
                    <div class="delivery-card-body">
                        ${imagesHtml}
                        <div class="delivery-card-controls">
                            <div class="delivery-place-selector">
                                <label>Lugar de Entrega</label>
                                <select class="delivery-place-select" data-compradora="${escHtml(res.compradora)}">
                                    <option value="">— Sin especificar —</option>
                                    <option value="Tuxtla" ${res.delivery.lugar === 'Tuxtla' ? 'selected' : ''}>Tuxtla</option>
                                    <option value="Berriozabal" ${res.delivery.lugar === 'Berriozabal' ? 'selected' : ''}>Berriozabal</option>
                                    <option value="Patria" ${res.delivery.lugar === 'Patria' ? 'selected' : ''}>Patria</option>
                                    <option value="Shanka" ${res.delivery.lugar === 'Shanka' ? 'selected' : ''}>Shanka</option>
                                    <option value="Otro" ${res.delivery.lugar === 'Otro' ? 'selected' : ''}>Otro</option>
                                </select>
                           </div>
                           <div class="delivery-status-control">
                               <span>Estatus</span>
                               <button class="btn-status-toggle ${statusClass}" data-compradora="${escHtml(res.compradora)}">
                                   <i data-lucide="${statusIcon}"></i>
                                   ${statusLabel}
                               </button>
                           </div>
                           <div class="delivery-payment-control">
                               <label>Tipo de Pago</label>
                               <div class="payment-options-segment ${paymentDisabledClass}">
                                   <button class="btn-payment-option ${res.delivery.paymentType === 'efectivo' ? 'active' : ''}" data-compradora="${escHtml(res.compradora)}" data-type="efectivo">
                                       Efectivo
                                   </button>
                                   <button class="btn-payment-option ${res.delivery.paymentType === 'transferencia' ? 'active' : ''}" data-compradora="${escHtml(res.compradora)}" data-type="transferencia">
                                       Transferencia
                                   </button>
                               </div>
                           </div>
                        </div>
                    </div>
                `;
            } else {
                // Umbral: solo listas creadas a partir del 29 de junio de 2026 tienen estatus de entrega
                const STATUS_THRESHOLD = new Date('2026-06-29T00:00:00');
                const listDate = new Date(res.listCreatedAt);
                const hasStatusData = listDate >= STATUS_THRESHOLD;

                let statusBoxHtml = '';
                if (hasStatusData) {
                    const isPagado = res.delivery.status === 'pagado';
                    const statusLabel = isPagado ? 'Pagado' : 'Pendiente';
                    const statusBadgeClass = isPagado ? 'status-pagado-badge' : 'status-pendiente-badge';
                    const statusIcon = isPagado ? 'check' : 'clock';

                    let deliveryDetailText = '';
                    if (res.delivery.paymentType || res.delivery.lugar) {
                        const detailParts = [];
                        if (res.delivery.paymentType) detailParts.push(res.delivery.paymentType.toUpperCase());
                        if (res.delivery.lugar) detailParts.push(res.delivery.lugar);
                        deliveryDetailText = ` (${detailParts.join(' en ')})`;
                    }

                    statusBoxHtml = `
                        <div class="past-delivery-status-box">
                            <span class="${statusBadgeClass}">
                                <i data-lucide="${statusIcon}"></i>
                                ${statusLabel}${deliveryDetailText}
                            </span>
                            <span class="past-date-label">Creada: ${listDate.toLocaleDateString('es-ES')}</span>
                        </div>
                    `;
                } else {
                    statusBoxHtml = `
                        <div class="past-delivery-status-box past-delivery-status-box--no-status">
                            <span class="past-date-label">Creada: ${listDate.toLocaleDateString('es-ES')}</span>
                        </div>
                    `;
                }

                row.innerHTML = `
                    <div class="delivery-card-header">
                        <div class="delivery-buyer-name">
                            <i data-lucide="user" style="opacity: 0.5;"></i>
                            ${escHtml(res.compradora)}
                            <span class="badge-list-past" title="${escHtml(res.listName)}">${escHtml(res.listName)}</span>
                        </div>
                        <div class="delivery-header-right">
                            <div class="delivery-buyer-total past-total">$${res.total.toFixed(2)}</div>
                            <div class="delivery-buyer-items-hint">${res.items.length} prenda${res.items.length !== 1 ? 's' : ''}</div>
                        </div>
                    </div>
                    <div class="delivery-card-body">
                        ${imagesHtml}
                        ${statusBoxHtml}
                    </div>
                `;
            }

            deliveriesList.appendChild(row);
        });

        // Registrar los event listeners interactivos solo para las filas de la lista activa
        registerInteractiveDeliveryListeners();

        if (window.lucide) lucide.createIcons();
    }

    function registerInteractiveDeliveryListeners() {
        deliveriesList.querySelectorAll('.btn-status-toggle').forEach(btn => {
            btn.addEventListener('click', async () => {
                const compradora = btn.dataset.compradora;
                const existing = activeDeliveries.find(d => d.compradora === compradora) || {
                    compradora, status: 'pendiente', paymentType: '', lugar: '', updatedAt: new Date().toISOString()
                };
                const newStatus = existing.status === 'pagado' ? 'pendiente' : 'pagado';
                const updated = { ...existing, status: newStatus, updatedAt: new Date().toISOString() };

                const idx = activeDeliveries.findIndex(d => d.compradora === compradora);
                if (idx >= 0) activeDeliveries[idx] = updated;
                else activeDeliveries.push(updated);

                if (deliverySearchTerm.trim()) {
                    filterDeliveries();
                } else {
                    renderDeliveries();
                }
                if (window.lucide) lucide.createIcons();

                try {
                    await db.saveDelivery(activeListId, updated);
                } catch (err) {
                    showToast('error', 'Error al guardar estatus: ' + err.message);
                }
            });
        });

        deliveriesList.querySelectorAll('.btn-payment-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const compradora = btn.dataset.compradora;
                const type = btn.dataset.type;
                const existing = activeDeliveries.find(d => d.compradora === compradora) || {
                    compradora, status: 'pendiente', paymentType: '', lugar: '', updatedAt: new Date().toISOString()
                };
                const newType = existing.paymentType === type ? '' : type;
                const updated = { ...existing, paymentType: newType, updatedAt: new Date().toISOString() };

                const idx = activeDeliveries.findIndex(d => d.compradora === compradora);
                if (idx >= 0) activeDeliveries[idx] = updated;
                else activeDeliveries.push(updated);

                if (deliverySearchTerm.trim()) {
                    filterDeliveries();
                } else {
                    renderDeliveries();
                }
                if (window.lucide) lucide.createIcons();

                try {
                    await db.saveDelivery(activeListId, updated);
                } catch (err) {
                    showToast('error', 'Error al guardar tipo de pago: ' + err.message);
                }
            });
        });

        deliveriesList.querySelectorAll('.delivery-place-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                const compradora = sel.dataset.compradora;
                const lugar = sel.value;
                const existing = activeDeliveries.find(d => d.compradora === compradora) || {
                    compradora, status: 'pendiente', paymentType: '', lugar: '', updatedAt: new Date().toISOString()
                };
                const updated = { ...existing, lugar, updatedAt: new Date().toISOString() };

                const idx = activeDeliveries.findIndex(d => d.compradora === compradora);
                if (idx >= 0) activeDeliveries[idx] = updated;
                else activeDeliveries.push(updated);

                try {
                    await db.saveDelivery(activeListId, updated);
                    showToast('success', `Lugar de entrega actualizado para ${compradora}.`);
                    
                    const row = deliveriesList.querySelector(`.delivery-row[data-compradora="${compradora}"]:not(.past-list-row)`);
                    if (row) {
                        row.dataset.lugar = lugar;
                    }
                } catch (err) {
                    showToast('error', 'Error al guardar lugar: ' + err.message);
                }
            });
        });
    }

    function renderDeliveries() {
        // Construir mapa de compradora -> { total, items, images }
        const buyerMap = getBuyerMapFromProducts(products);
        let buyerNames = Object.keys(buyerMap);

        // Aplicar ordenamiento dinámico
        if (deliverySortBy === 'name-asc') {
            buyerNames.sort((a, b) => a.localeCompare(b, 'es'));
        } else if (deliverySortBy === 'items-desc') {
            buyerNames.sort((a, b) => buyerMap[b].items.length - buyerMap[a].items.length);
        } else if (deliverySortBy === 'items-asc') {
            buyerNames.sort((a, b) => buyerMap[a].items.length - buyerMap[b].items.length);
        } else if (deliverySortBy === 'total-desc') {
            buyerNames.sort((a, b) => buyerMap[b].total - buyerMap[a].total);
        } else if (deliverySortBy === 'total-asc') {
            buyerNames.sort((a, b) => buyerMap[a].total - buyerMap[b].total);
        }

        // Calcular métricas rápidas (siempre sobre todos, no el filtrado)
        let totalMoney = 0;
        let paidCount = 0;
        let pendingMoney = 0;
        buyerNames.forEach(name => {
            totalMoney += buyerMap[name].total;
            const delivery = activeDeliveries.find(d => d.compradora === name);
            if (delivery && delivery.status === 'pagado') {
                paidCount++;
            } else {
                pendingMoney += buyerMap[name].total;
            }
        });

        if (deliveryStatTotalMoney) deliveryStatTotalMoney.textContent = `$${totalMoney.toFixed(2)}`;
        if (deliveryStatPaidQty) deliveryStatPaidQty.textContent = `${paidCount} / ${buyerNames.length}`;
        if (deliveryStatPendingQty) deliveryStatPendingQty.textContent = `$${pendingMoney.toFixed(2)}`;

        if (buyerNames.length === 0) {
            deliveriesList.style.display = 'none';
            deliveriesEmptyState.style.display = 'block';
            deliveriesEmptyState.querySelector('h2').textContent = 'Sin entregas que mostrar';
            deliveriesEmptyState.querySelector('p').textContent = 'Adjudica productos a compradoras para ver e iniciar la gestión de entregas.';
            return;
        }

        deliveriesList.style.display = 'flex';
        deliveriesEmptyState.style.display = 'none';
        deliveriesList.innerHTML = '';

        buyerNames.forEach(name => {
            const buyerData = buyerMap[name];
            const delivery = activeDeliveries.find(d => d.compradora === name) || {
                compradora: name,
                status: 'pendiente',
                paymentType: '',
                lugar: '',
                updatedAt: new Date().toISOString()
            };

            const isPagado = delivery.status === 'pagado';
            const statusClass = isPagado ? 'status-pagado' : 'status-pendiente';
            const statusIcon = isPagado ? 'check-circle' : 'clock';
            const statusLabel = isPagado ? 'Pagado' : 'Pendiente';
            const paymentDisabledClass = isPagado ? '' : 'disabled';

            // Cuadrícula de imágenes
            const imagesHtml = buyerData.images.length > 0
                ? `<div class="delivery-images-grid">${buyerData.images.map(img =>
                    `<img class="delivery-thumb" src="${img.src}" alt="${escHtml(img.name)}" title="${escHtml(img.name)}">`
                  ).join('')}</div>`
                : '';

            const row = document.createElement('div');
            row.className = 'delivery-row';
            row.dataset.compradora = name;
            row.dataset.status = delivery.status;
            row.dataset.lugar = delivery.lugar || '';
            row.dataset.paymentType = delivery.paymentType || '';
            row.dataset.prodNames = buyerData.items.map(i => i.name).join(' | ');

            row.innerHTML = `
                <!-- Cabecera: nombre + total -->
                <div class="delivery-card-header">
                    <div class="delivery-buyer-name">
                        <i data-lucide="user"></i>
                        ${escHtml(name)}
                    </div>
                    <div class="delivery-header-right">
                        <div class="delivery-buyer-total">$${buyerData.total.toFixed(2)}</div>
                        <div class="delivery-buyer-items-hint">${buyerData.items.length} prenda${buyerData.items.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>
                <!-- Cuerpo: imágenes + controles -->
                <div class="delivery-card-body">
                    ${imagesHtml}
                    <div class="delivery-card-controls">
                        <div class="delivery-place-selector">
                            <label>Lugar de Entrega</label>
                            <select class="delivery-place-select" data-compradora="${escHtml(name)}">
                                <option value="">— Sin especificar —</option>
                                <option value="Tuxtla" ${delivery.lugar === 'Tuxtla' ? 'selected' : ''}>Tuxtla</option>
                                <option value="Berriozabal" ${delivery.lugar === 'Berriozabal' ? 'selected' : ''}>Berriozabal</option>
                                <option value="Patria" ${delivery.lugar === 'Patria' ? 'selected' : ''}>Patria</option>
                                <option value="Shanka" ${delivery.lugar === 'Shanka' ? 'selected' : ''}>Shanka</option>
                                <option value="Otro" ${delivery.lugar === 'Otro' ? 'selected' : ''}>Otro</option>
                            </select>
                        </div>
                        <div class="delivery-status-control">
                            <span>Estatus</span>
                            <button class="btn-status-toggle ${statusClass}" data-compradora="${escHtml(name)}">
                                <i data-lucide="${statusIcon}"></i>
                                ${statusLabel}
                            </button>
                        </div>
                        <div class="delivery-payment-control">
                            <label>Tipo de Pago</label>
                            <div class="payment-options-segment ${paymentDisabledClass}">
                                <button class="btn-payment-option ${delivery.paymentType === 'efectivo' ? 'active' : ''}" data-compradora="${escHtml(name)}" data-type="efectivo">
                                    Efectivo
                                </button>
                                <button class="btn-payment-option ${delivery.paymentType === 'transferencia' ? 'active' : ''}" data-compradora="${escHtml(name)}" data-type="transferencia">
                                    Transferencia
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            deliveriesList.appendChild(row);
        });

        // Registrar eventos después de pintar
        registerInteractiveDeliveryListeners();

        // Aplicar el filtro de búsqueda actual al finalizar el pintado
        filterDeliveries();

        if (window.lucide) lucide.createIcons();
    }

    // Eventos del panel de entregas
    if (btnShowDeliveries) {
        btnShowDeliveries.addEventListener('click', openDeliveriesView);
    }
    if (btnCloseDeliveries) {
        btnCloseDeliveries.addEventListener('click', closeDeliveriesView);
    }
    if (deliverySearchInput) {
        deliverySearchInput.addEventListener('input', debounce(() => {
            deliverySearchTerm = deliverySearchInput.value.trim();
            filterDeliveries();
        }, 100));
    }

    // Filtros de estatus de entregas (segmentados)
    const statusSegments = document.querySelectorAll('#delivery-filter-status .btn-segment');
    statusSegments.forEach(btn => {
        btn.addEventListener('click', () => {
            statusSegments.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            deliveryFilterStatus = btn.dataset.value;
            filterDeliveries();
        });
    });

    // Filtros de método de pago (segmentados)
    const paymentSegments = document.querySelectorAll('#delivery-filter-payment .btn-segment');
    paymentSegments.forEach(btn => {
        btn.addEventListener('click', () => {
            paymentSegments.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            deliveryFilterPayment = btn.dataset.value;
            filterDeliveries();
        });
    });

    // Filtros de lugar de entrega (select)
    const placeSelect = document.getElementById('delivery-filter-place');
    if (placeSelect) {
        placeSelect.addEventListener('change', () => {
            deliveryFilterPlace = placeSelect.value;
            filterDeliveries();
        });
    }

    // Ordenamiento de entregas (select)
    const sortBySelect = document.getElementById('delivery-sort-by');
    if (sortBySelect) {
        sortBySelect.addEventListener('change', () => {
            deliverySortBy = sortBySelect.value;
            renderDeliveries(); // Volver a pintar para aplicar el orden en el DOM
        });
    }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
