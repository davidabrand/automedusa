import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';
import CAR_MODELS from './car-models.js';

// No inventory is embedded in this file. It is served publicly, so real customer
// names, VINs and prices must only ever live in Supabase behind sign-in.

// Supabase cloud configuration. The publishable key is intentionally safe for browser use;
// Row Level Security (RLS) is what protects the actual dealership data (see SUPABASE_SECURITY.md).
const SUPABASE_URL = 'https://jkbptboysyecacmdmgtd.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FL-jC0TNxVTO6vqLxGhqlw_h9q8NSF9';
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

// Add ?debug to the URL to show the cloud diagnostic (it writes a test row).
const DEBUG = new URLSearchParams(window.location.search).has('debug');

// Mileage is in km, so money is Canadian dollars.
const LOCALE = 'en-CA';
const CURRENCY = 'CAD';

// Failed writes retry automatically this many times, then wait for a manual Refresh.
const MAX_SYNC_ATTEMPTS = 5;

const LEGACY_STORAGE_KEYS = {
    cars: 'automedusa_cloud_cache_cars_v1',
    expenses: 'automedusa_cloud_cache_expenses_v1',
    acquisitions: 'automedusa_cloud_cache_acquisitions_v1',
    pending: 'automedusa_cloud_pending_ops_v1'
};

// The offline cache is scoped to the signed-in user and wiped on sign-out.
function storageKey(name) {
    return `automedusa_v2_${currentUser?.id || 'anon'}_${name}`;
}

// App State Management
let cars = [];
let expenses = [];
let acquisitions = [];
let acquisitionsCloudReady = false;
let profitChart = null;
let expenseChart = null;
let currentUser = null;
let realtimeChannel = null;
let realtimeHealthy = false;
let cloudRefreshTimer = null;
let realtimeReloadTimer = null;
let cloudLoadInFlight = null;
let lastCloudLoadAt = 0;
let authMode = 'signin';

const TAB_TITLES = {
    dashboard: 'Dashboard',
    inventory: 'Inventory',
    expenses: 'Expenses',
    sourcing: 'Sourcing',
    reports: 'Reports'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Every value from the database or a form goes through esc() before it is put into HTML.
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Only plain web links can be opened from a listing; blocks javascript: and data: URLs.
function safeUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

// The local calendar date. toISOString() is UTC, which is tomorrow during a Canadian evening.
function localDateISO(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function randomToken(length = 6) {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { console.warn('Could not write cache:', err); }
}

function vehicleName(item) {
    return `${item.year || ''} ${item.make || ''} ${item.model || ''}`.replace(/\s+/g, ' ').trim() || item.id || 'Vehicle';
}

function formatCurrency(val) {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY }).format(Number(val) || 0);
}

function formatCurrencyCompact(val) {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, notation: 'compact', maximumFractionDigits: 1 }).format(Number(val) || 0);
}

function formatDisplayDate(value) {
    const d = parseLocalDate(value);
    return d ? d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

function inferVehicleType(car) {
    const name = `${car.make || ''} ${car.model || ''}`.toLowerCase();
    if (name.includes('grand caravan') || name.includes('odyssey') || name.includes('sienna') || name.includes('pacifica')) return 'Minivan';
    if (name.includes('express') || name.includes('transit') || name.includes('sprinter') || name.includes('promaster')) return 'Van';
    if (name.includes('1500') || name.includes('2500') || name.includes('3500') || name.includes('f-150') || name.includes('silverado') || name.includes('sierra') || name.includes('tacoma') || name.includes('tundra')) return 'Truck';
    if (name.includes('cherokee') || name.includes('outlander') || name.includes('rav4') || name.includes('cr-v') || name.includes('escape') || name.includes('equinox') || name.includes('explorer') || name.includes('highlander')) return 'SUV';
    return 'Other';
}

function migrateCarSchema(car) {
    return {
        ...car,
        listedDate: car.listedDate || car.purchaseDate || '',
        vehicleType: car.vehicleType || inferVehicleType(car)
    };
}

function parseLocalDate(value) {
    if (!value) return null;
    const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function getDaysOnMarket(car) {
    const start = parseLocalDate(car.listedDate || car.purchaseDate);
    if (!start) return 0;
    const end = car.status === 'SOLD' && car.saleDate ? parseLocalDate(car.saleDate) : new Date();
    if (!end) return 0;
    return Math.max(0, Math.floor((end - start) / 86400000));
}

function getAgeBucket(days) {
    if (days <= 14) return '0-14';
    if (days <= 30) return '15-30';
    if (days <= 60) return '31-60';
    return '61+';
}

function carFromDb(row) {
    return migrateCarSchema({
        id: row.id || row.stock_number,
        year: Number(row.year || 0),
        make: row.make || '',
        model: row.model || '',
        vehicleType: row.vehicle_type || 'Other',
        vin: row.vin || '',
        mileage: Number(row.mileage || 0),
        purchasePrice: Number(row.purchase_price || 0),
        purchaseDate: row.purchase_date || '',
        listedDate: row.listed_date || row.purchase_date || '',
        source: row.source || 'Private Seller',
        targetPrice: row.target_price == null ? null : Number(row.target_price),
        status: row.status || 'IN_PREP',
        notes: row.notes || '',
        salePrice: row.sale_price == null ? null : Number(row.sale_price),
        saleDate: row.sold_date || null,
        buyer: row.buyer || null
    });
}

function carToDb(car) {
    return {
        id: car.id,
        stock_number: car.id,
        year: Number(car.year || 0),
        make: car.make || '',
        model: car.model || '',
        vehicle_type: car.vehicleType || inferVehicleType(car),
        vin: car.vin || null,
        mileage: Number(car.mileage || 0),
        purchase_price: Number(car.purchasePrice || 0),
        purchase_date: car.purchaseDate || null,
        listed_date: car.listedDate || car.purchaseDate || null,
        source: car.source || 'Private Seller',
        target_price: car.targetPrice == null ? null : Number(car.targetPrice),
        status: car.status || 'IN_PREP',
        sale_price: car.salePrice == null ? null : Number(car.salePrice),
        sold_date: car.saleDate || null,
        buyer: car.buyer || null,
        notes: car.notes || ''
    };
}

function acquisitionFromDb(row) {
    return {
        id: row.id,
        stage: row.stage || 'WATCHLIST',
        year: Number(row.year || 0),
        make: row.make || '',
        model: row.model || '',
        vehicleType: row.vehicle_type || 'Other',
        vin: row.vin || '',
        mileage: Number(row.mileage || 0),
        source: row.source || 'Other',
        sourceUrl: row.source_url || '',
        auctionAt: row.auction_at || '',
        currentBid: Number(row.current_bid || 0),
        maxBid: row.max_bid == null ? null : Number(row.max_bid),
        expectedSalePrice: Number(row.expected_sale_price || 0),
        desiredProfit: Number(row.desired_profit || 0),
        estimatedFees: Number(row.estimated_fees || 0),
        estimatedTransport: Number(row.estimated_transport || 0),
        estimatedRepairs: Number(row.estimated_repairs || 0),
        purchasePrice: row.purchase_price == null ? null : Number(row.purchase_price),
        purchaseDate: row.purchase_date || '',
        transportEta: row.transport_eta || '',
        notes: row.notes || '',
        createdAt: row.created_at || ''
    };
}

function acquisitionToDb(acq) {
    return {
        id: acq.id,
        stage: acq.stage || 'WATCHLIST',
        year: Number(acq.year || 0),
        make: acq.make || '',
        model: acq.model || '',
        vehicle_type: acq.vehicleType || 'Other',
        vin: acq.vin || null,
        mileage: Number(acq.mileage || 0),
        source: acq.source || 'Other',
        source_url: safeUrl(acq.sourceUrl) || null,
        auction_at: acq.auctionAt || null,
        current_bid: Number(acq.currentBid || 0),
        max_bid: acq.maxBid == null || acq.maxBid === '' ? null : Number(acq.maxBid),
        expected_sale_price: Number(acq.expectedSalePrice || 0),
        desired_profit: Number(acq.desiredProfit || 0),
        estimated_fees: Number(acq.estimatedFees || 0),
        estimated_transport: Number(acq.estimatedTransport || 0),
        estimated_repairs: Number(acq.estimatedRepairs || 0),
        purchase_price: acq.purchasePrice == null || acq.purchasePrice === '' ? null : Number(acq.purchasePrice),
        purchase_date: acq.purchaseDate || null,
        transport_eta: acq.transportEta || null,
        notes: acq.notes || ''
    };
}

function getAcquisitionSafeBid(acq) {
    return Math.max(
        0,
        Number(acq.expectedSalePrice || 0)
        - Number(acq.desiredProfit || 0)
        - Number(acq.estimatedFees || 0)
        - Number(acq.estimatedTransport || 0)
        - Number(acq.estimatedRepairs || 0)
    );
}

function getAcquisitionProjectedProfit(acq, bidOverride = null) {
    const bid = bidOverride == null ? Number(acq.currentBid || 0) : Number(bidOverride || 0);
    return Number(acq.expectedSalePrice || 0)
        - bid
        - Number(acq.estimatedFees || 0)
        - Number(acq.estimatedTransport || 0)
        - Number(acq.estimatedRepairs || 0);
}

function expenseFromDb(row) {
    return {
        id: row.id,
        type: row.type || (row.vehicle_id ? 'VEHICLE' : 'OVERHEAD'),
        carId: row.vehicle_id || null,
        category: row.category || 'Other',
        amount: Number(row.amount || 0),
        date: row.date || '',
        notes: row.notes || ''
    };
}

function expenseToDb(expense) {
    return {
        id: expense.id,
        vehicle_id: expense.type === 'VEHICLE' ? (expense.carId || null) : null,
        type: expense.type || (expense.carId ? 'VEHICLE' : 'OVERHEAD'),
        category: expense.category || 'Other',
        amount: Number(expense.amount || 0),
        date: expense.date || null,
        notes: expense.notes || ''
    };
}

function getCarRecondCost(carId) {
    return expenses
        .filter(e => e.carId === carId)
        .reduce((sum, e) => sum + Number(e.amount || 0), 0);
}

function getCarCostBasis(car) {
    return Number(car.purchasePrice || 0) + getCarRecondCost(car.id);
}

function generateStockId() {
    let id;
    do {
        id = `CAR-${randomToken(6)}`;
    } while (cars.some(c => c.id === id));
    return id;
}

// Newest first by date; records with no date go last, in the order they were added.
function byDateDesc(getDate) {
    return (a, b) => {
        const da = getDate(a) || '';
        const db = getDate(b) || '';
        if (da === db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? 1 : -1;
    };
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

const SYNC_LABELS = {
    synced: 'Up to date',
    syncing: 'Syncing…',
    pending: 'Waiting to sync',
    offline: 'Offline',
    error: 'Not synced',
    signedout: 'Signed out'
};

function setSyncStatus(state, detail = '') {
    const label = detail || SYNC_LABELS[state] || SYNC_LABELS.error;
    document.querySelectorAll('[data-sync-dot]').forEach(el => { el.dataset.state = state; });
    document.querySelectorAll('[data-sync-label]').forEach(el => { el.textContent = label; });
}

function refreshSyncStatusFromQueue() {
    const ops = getPendingOps();
    const failed = ops.filter(op => (op.attempts || 0) >= MAX_SYNC_ATTEMPTS).length;
    if (failed) setSyncStatus('error', `${failed} ${failed === 1 ? 'change' : 'changes'} not saved`);
    else if (ops.length) setSyncStatus('pending', `${ops.length} pending`);
    else setSyncStatus('synced', `Synced at ${new Date().toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' })}`);
}


// ---------------------------------------------------------------------------
// Offline cache and pending-write queue
// ---------------------------------------------------------------------------

// Moves an old, unscoped v1 cache into the signed-in user's cache once, then removes it.
function migrateLegacyCache() {
    try {
        const legacyPending = readJSON(LEGACY_STORAGE_KEYS.pending, []);
        if (legacyPending.length) {
            const ops = getPendingOps();
            legacyPending.forEach(op => { if (!ops.some(o => cloudOpIdentity(o) === cloudOpIdentity(op))) ops.push(op); });
            setPendingOps(ops);
        }
        Object.values(LEGACY_STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    } catch (err) {
        console.warn('Legacy cache migration skipped:', err);
    }
}

function loadLocalCache() {
    cars = readJSON(storageKey('cars'), []).map(migrateCarSchema);
    expenses = readJSON(storageKey('expenses'), []);
    acquisitions = readJSON(storageKey('acquisitions'), []);
}

function clearUserCache() {
    ['cars', 'expenses', 'acquisitions', 'pending'].forEach(name => {
        try { localStorage.removeItem(storageKey(name)); } catch { /* storage unavailable */ }
    });
}

function saveState() {
    if (currentUser) {
        writeJSON(storageKey('cars'), cars);
        writeJSON(storageKey('expenses'), expenses);
        writeJSON(storageKey('acquisitions'), acquisitions);
    }
}

function getPendingOps() {
    return readJSON(storageKey('pending'), []);
}

function setPendingOps(ops) {
    writeJSON(storageKey('pending'), ops);
}

function cloudOpIdentity(op) {
    if (op.kind === 'upsert_car' || op.kind === 'delete_car') return `car:${op.payload?.id || op.id || ''}`;
    if (op.kind === 'upsert_expense' || op.kind === 'delete_expense') return `expense:${op.payload?.id || op.id || ''}`;
    if (op.kind === 'upsert_acquisition' || op.kind === 'delete_acquisition') return `acquisition:${op.payload?.id || op.id || ''}`;
    return `${op.kind}:${op.id || op.payload?.id || ''}`;
}

function queueCloudOp(op, { error = null } = {}) {
    const ops = getPendingOps();
    const identity = cloudOpIdentity(op);
    const existingIndex = ops.findIndex(existing => cloudOpIdentity(existing) === identity);
    const previous = existingIndex >= 0 ? ops[existingIndex] : null;
    const queued = {
        ...op,
        queuedAt: new Date().toISOString(),
        attempts: error ? (op.attempts || previous?.attempts || 0) + 1 : (op.attempts || 0),
        lastError: error ? formatCloudError(error) : (op.lastError || null)
    };
    if (existingIndex >= 0) ops[existingIndex] = queued;
    else ops.push(queued);
    setPendingOps(ops);
    refreshSyncStatusFromQueue();
}

function applyPendingOpsToLocalState() {
    for (const op of getPendingOps()) {
        if (op.kind === 'upsert_car' && op.payload) {
            const pendingCar = carFromDb(op.payload);
            const i = cars.findIndex(c => c.id === pendingCar.id);
            if (i >= 0) cars[i] = pendingCar; else cars.push(pendingCar);
        } else if (op.kind === 'upsert_expense' && op.payload) {
            const pendingExpense = expenseFromDb(op.payload);
            const i = expenses.findIndex(e => e.id === pendingExpense.id);
            if (i >= 0) expenses[i] = pendingExpense; else expenses.push(pendingExpense);
        } else if (op.kind === 'upsert_acquisition' && op.payload) {
            const pendingAcq = acquisitionFromDb(op.payload);
            const i = acquisitions.findIndex(a => a.id === pendingAcq.id);
            if (i >= 0) acquisitions[i] = pendingAcq; else acquisitions.push(pendingAcq);
        } else if (op.kind === 'delete_car') {
            cars = cars.filter(c => c.id !== op.id);
            expenses = expenses.filter(e => e.carId !== op.id);
        } else if (op.kind === 'delete_expense') {
            expenses = expenses.filter(e => e.id !== op.id);
        } else if (op.kind === 'delete_acquisition') {
            acquisitions = acquisitions.filter(a => a.id !== op.id);
        }
    }
}

function formatCloudError(err) {
    if (!err) return 'Unknown error';
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.code) parts.push(`code ${err.code}`);
    if (err.details) parts.push(err.details);
    if (err.hint) parts.push(`Hint: ${err.hint}`);
    return parts.filter(Boolean).join(' • ') || String(err);
}

async function diagnoseCloud() {
    if (!DEBUG) return;
    const lines = ['AutoMedusa cloud diagnostic', ''];

    if (!supabaseClient) {
        alert(lines.concat(['❌ Supabase JavaScript library did not load.']).join('\n'));
        return;
    }

    try {
        const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError) {
            lines.push(`❌ Auth session: ${formatCloudError(sessionError)}`);
            alert(lines.join('\n'));
            return;
        }
        if (!sessionData?.session?.user) {
            lines.push('❌ Auth session: not signed in');
            alert(lines.join('\n'));
            return;
        }
        lines.push(`✅ Signed in: ${sessionData.session.user.email || 'user'}`);

        for (const table of ['vehicles', 'expenses', 'acquisitions']) {
            const read = await supabaseClient.from(table).select('id').limit(1);
            lines.push(read.error ? `❌ ${table} SELECT: ${formatCloudError(read.error)}` : `✅ ${table} SELECT`);
        }

        const testId = `EXP-DIAG-${Date.now()}`;
        const probe = { id: testId, vehicle_id: null, type: 'OVERHEAD', category: 'Sync Test', amount: 0, date: localDateISO(), notes: 'Temporary AutoMedusa cloud diagnostic row' };
        const writeResult = await supabaseClient.from('expenses').upsert(probe, { onConflict: 'id' }).select('id').single();
        if (writeResult.error) {
            lines.push(`❌ expenses UPSERT: ${formatCloudError(writeResult.error)}`);
        } else {
            lines.push('✅ expenses UPSERT');
            const deleteResult = await supabaseClient.from('expenses').delete().eq('id', testId);
            lines.push(deleteResult.error ? `⚠️ Cleanup DELETE: ${formatCloudError(deleteResult.error)}` : '✅ cleanup DELETE');
        }

        const failed = getPendingOps().filter(op => op.lastError);
        if (failed.length) {
            lines.push('', `Queued changes with errors: ${failed.length}`);
            failed.slice(0, 5).forEach(op => lines.push(`• ${cloudOpIdentity(op)}: ${op.lastError}`));
        }
        alert(lines.join('\n'));
    } catch (err) {
        lines.push(`❌ Diagnostic exception: ${formatCloudError(err)}`);
        alert(lines.join('\n'));
    }
}

async function executeCloudOp(op) {
    const tables = { car: 'vehicles', expense: 'expenses', acquisition: 'acquisitions' };
    const [action, entity] = op.kind.split('_');
    const table = tables[entity];
    if (!table) return { error: new Error(`Unknown sync operation: ${op.kind}`) };
    if (action === 'upsert') {
        return await supabaseClient.from(table).upsert(op.payload, { onConflict: 'id' }).select('*').single();
    }
    if (action === 'delete') {
        return await supabaseClient.from(table).delete().eq('id', op.id);
    }
    return { error: new Error(`Unknown sync operation: ${op.kind}`) };
}

function removePendingOp(op) {
    const identity = cloudOpIdentity(op);
    setPendingOps(getPendingOps().filter(existing => cloudOpIdentity(existing) !== identity));
}

async function runOrQueueCloudOp(op, successMessage = '') {
    if (!currentUser || !navigator.onLine) {
        queueCloudOp(op);
        if (successMessage) showToast(`${successMessage}. It will sync when you're back online.`);
        return false;
    }
    setSyncStatus('syncing');
    try {
        const result = await executeCloudOp(op);
        if (result.error) throw result.error;
        // A newer write for the same record supersedes any older queued copy.
        removePendingOp(op);

        // Server-confirmed writes replace the optimistic local copy so a realtime
        // refresh cannot make a just-saved record appear to vanish.
        if (op.kind === 'upsert_expense' && result.data) {
            const saved = expenseFromDb(result.data);
            const i = expenses.findIndex(e => e.id === saved.id);
            if (i >= 0) expenses[i] = saved; else expenses.push(saved);
        } else if (op.kind === 'upsert_car' && result.data) {
            const saved = carFromDb(result.data);
            const i = cars.findIndex(c => c.id === saved.id);
            if (i >= 0) cars[i] = saved; else cars.push(saved);
        } else if (op.kind === 'upsert_acquisition' && result.data) {
            const saved = acquisitionFromDb(result.data);
            const i = acquisitions.findIndex(a => a.id === saved.id);
            if (i >= 0) acquisitions[i] = saved; else acquisitions.push(saved);
            acquisitionsCloudReady = true;
        }
        if (result.data) {
            saveState();
            refreshUI();
        }

        refreshSyncStatusFromQueue();
        if (successMessage) showToast(successMessage);
        return true;
    } catch (err) {
        console.error('Cloud write failed:', err);
        queueCloudOp(op, { error: err });
        const network = /fetch|network|load failed/i.test(String(err?.message || err));
        showToast(network
            ? "Saved on this device. It will sync when you're back online."
            : `Saved on this device only. ${err?.message || 'The cloud rejected the change.'}`, 'error');
        return false;
    }
}

async function flushPendingOps({ retryFailed = false } = {}) {
    if (!currentUser || !navigator.onLine) return;
    const ops = getPendingOps();
    if (!ops.length) return;
    setSyncStatus('syncing', `Syncing ${ops.length}`);
    const remaining = [];
    for (const op of ops) {
        if (!retryFailed && (op.attempts || 0) >= MAX_SYNC_ATTEMPTS) {
            remaining.push(op);
            continue;
        }
        try {
            const { error } = await executeCloudOp(op);
            if (error) throw error;
        } catch (err) {
            console.error('Pending sync failed:', err);
            remaining.push({ ...op, attempts: (op.attempts || 0) + 1, lastError: formatCloudError(err) });
        }
    }
    setPendingOps(remaining);
    refreshSyncStatusFromQueue();
}

async function loadCloudData({ silent = false } = {}) {
    if (!currentUser) return false;
    // Collapse overlapping reloads (realtime burst + focus + poll) into one request.
    if (cloudLoadInFlight) return cloudLoadInFlight;
    cloudLoadInFlight = (async () => {
        if (!silent) setSyncStatus('syncing');
        try {
            const [vehicleResult, expenseResult, acquisitionResult] = await Promise.all([
                supabaseClient.from('vehicles').select('*').order('purchase_date', { ascending: false }),
                supabaseClient.from('expenses').select('*'),
                supabaseClient.from('acquisitions').select('*').order('created_at', { ascending: false })
            ]);
            if (vehicleResult.error) throw vehicleResult.error;
            if (expenseResult.error) throw expenseResult.error;

            cars = (vehicleResult.data || []).map(carFromDb);
            expenses = (expenseResult.data || []).map(expenseFromDb);

            if (acquisitionResult.error) {
                acquisitionsCloudReady = false;
                console.warn('Acquisition pipeline cloud table is not ready:', acquisitionResult.error);
            } else {
                acquisitionsCloudReady = true;
                acquisitions = (acquisitionResult.data || []).map(acquisitionFromDb);
            }

            // Keep unsynced local changes visible while they are queued.
            applyPendingOpsToLocalState();

            lastCloudLoadAt = Date.now();
            saveState();
            refreshUI();
            refreshSyncStatusFromQueue();
            return true;
        } catch (err) {
            console.error('Cloud load failed:', err);
            loadLocalCache();
            applyPendingOpsToLocalState();
            refreshUI();
            setSyncStatus(navigator.onLine ? 'error' : 'offline');
            if (!silent) showToast("Couldn't reach the cloud. Showing what's saved on this device.", 'error');
            return false;
        } finally {
            cloudLoadInFlight = null;
        }
    })();
    return cloudLoadInFlight;
}

async function refreshCloudData({ retryFailed = false } = {}) {
    if (!currentUser) return showAuthOverlay();
    await flushPendingOps({ retryFailed });
    await loadCloudData();
}

function scheduleRealtimeReload() {
    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(() => loadCloudData({ silent: true }), 350);
}

function setupRealtime() {
    teardownRealtime();
    if (!currentUser) return;
    realtimeChannel = supabaseClient
        .channel('automedusa-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicles' }, scheduleRealtimeReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, scheduleRealtimeReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'acquisitions' }, scheduleRealtimeReload)
        .subscribe(status => { realtimeHealthy = status === 'SUBSCRIBED'; });

    // Fallback only: poll while realtime is not connected.
    cloudRefreshTimer = setInterval(() => {
        if (!realtimeHealthy && document.visibilityState === 'visible' && navigator.onLine) loadCloudData({ silent: true });
    }, 30000);
}

function teardownRealtime() {
    if (realtimeChannel) {
        supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
    realtimeHealthy = false;
    if (cloudRefreshTimer) {
        clearInterval(cloudRefreshTimer);
        cloudRefreshTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Sign in, password reset, sign out
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function updateUserUI() {
    const email = currentUser?.email || 'Not signed in';
    const initial = (currentUser?.email || '?').trim().charAt(0).toUpperCase() || '?';
    document.querySelectorAll('[data-user-email]').forEach(el => { el.textContent = email; });
    document.querySelectorAll('[data-avatar-initial]').forEach(el => { el.textContent = initial; });
}

function showAuthOverlay() {
    closeSheet({ immediate: true });
    closeAddMenu();
    $('app-shell').hidden = true;
    $('auth-overlay').hidden = false;
    const loginVideo = $('automedusa-login-video');
    if (loginVideo) {
        loginVideo.muted = true;
        loginVideo.play().catch(() => {});
    }
    if (!currentUser) setSyncStatus('signedout');
    setTimeout(() => $(authMode === 'new-password' ? 'auth-password' : 'auth-email')?.focus(), 50);
}

function hideAuthOverlay() {
    $('auth-overlay').hidden = true;
    $('automedusa-login-video')?.pause();
    $('app-shell').hidden = false;
}

function setAuthMode(mode) {
    authMode = mode;
    showAuthMessage(null);
    const copy = {
        'signin': { subtitle: 'Sign in to your dealership.', button: 'Sign in', toggle: 'Forgot password?' },
        'reset': { subtitle: "We'll email you a link to reset it.", button: 'Send reset link', toggle: 'Back to sign in' },
        'new-password': { subtitle: 'Choose a new password.', button: 'Save password', toggle: 'Cancel' }
    }[mode];

    $('auth-subtitle').textContent = copy.subtitle;
    $('auth-mode-toggle').textContent = copy.toggle;
    setAuthButton(copy.button);
    $('auth-email-row').hidden = mode === 'new-password';
    $('auth-password-row').hidden = mode === 'reset';
    const password = $('auth-password');
    password.autocomplete = mode === 'new-password' ? 'new-password' : 'current-password';
    password.placeholder = mode === 'new-password' ? 'New password' : 'Password';
    password.value = '';
}

function toggleAuthMode() {
    if (authMode === 'signin') setAuthMode('reset');
    else if (authMode === 'new-password') {
        setAuthMode('signin');
        if (currentUser) hideAuthOverlay();
    } else setAuthMode('signin');
}

function setAuthButton(label, busy = false) {
    const button = $('auth-submit');
    button.disabled = busy;
    button.textContent = label;
}

function showAuthMessage(kind, text = '') {
    $('auth-error').hidden = kind !== 'error';
    $('auth-info').hidden = kind !== 'info';
    if (kind === 'error') $('auth-error').textContent = text;
    if (kind === 'info') $('auth-info').textContent = text;
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    showAuthMessage(null);

    if (authMode === 'signin') {
        if (!email || !password) return showAuthMessage('error', 'Enter your email and password.');
        setAuthButton('Signing in…', true);
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            currentUser = data.user;
            $('auth-password').value = '';
            await enterApp();
        } catch (err) {
            showAuthMessage('error', err.message || "Couldn't sign in. Check your email and password.");
        } finally {
            setAuthButton('Sign in');
        }
        return;
    }

    if (authMode === 'reset') {
        if (!email) return showAuthMessage('error', 'Enter the email you sign in with.');
        setAuthButton('Sending…', true);
        try {
            const redirectTo = `${window.location.origin}${window.location.pathname}`;
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
            if (error) throw error;
            showAuthMessage('info', 'If that email has an account, a reset link is on its way.');
        } catch (err) {
            showAuthMessage('error', err.message || "Couldn't send the reset email.");
        } finally {
            setAuthButton('Send reset link');
        }
        return;
    }

    if (authMode === 'new-password') {
        if (password.length < 8) return showAuthMessage('error', 'Use at least 8 characters.');
        setAuthButton('Saving…', true);
        try {
            const { data, error } = await supabaseClient.auth.updateUser({ password });
            if (error) throw error;
            currentUser = data.user || currentUser;
            setAuthMode('signin');
            await enterApp();
            showToast('Password updated');
        } catch (err) {
            showAuthMessage('error', err.message || "Couldn't update the password.");
        } finally {
            if (authMode === 'new-password') setAuthButton('Save password');
        }
    }
}

async function enterApp() {
    migrateLegacyCache();
    loadLocalCache();
    applyPendingOpsToLocalState();
    updateUserUI();
    hideAuthOverlay();
    refreshUI();
    await flushPendingOps();
    await loadCloudData();
    setupRealtime();
}

// Clears everything about the previous user from memory and the screen.
function leaveApp() {
    teardownRealtime();
    currentUser = null;
    cars = [];
    expenses = [];
    acquisitions = [];
    refreshUI();
    updateUserUI();
    setAuthMode('signin');
    showAuthOverlay();
}

async function signOutAutoMedusa() {
    if (!currentUser) return leaveApp();
    await flushPendingOps({ retryFailed: true });
    const pending = getPendingOps().length;
    if (pending) {
        const ok = await confirmAction({
            title: 'Sign out?',
            message: `${pending} ${pending === 1 ? 'change hasn’t' : 'changes haven’t'} reached the cloud yet. Signing out removes ${pending === 1 ? 'it' : 'them'} from this device.`,
            confirmLabel: 'Sign out'
        });
        if (!ok) return;
    }
    // Remove the cached dealership data so the next person on this device can't see it.
    clearUserCache();
    try {
        await supabaseClient.auth.signOut({ scope: 'local' });
    } catch (err) {
        console.warn('Sign-out request failed; local session cleared anyway:', err);
    }
    leaveApp();
}

// ---------------------------------------------------------------------------
// App start
// ---------------------------------------------------------------------------

async function checkForAppUpdate() {
    // Home-screen web clips can hold an older HTML document. Fetch a cache-busted copy
    // of the same URL and reload only when its embedded app version changes.
    try {
        const localVersion = document.querySelector('meta[name="automedusa-version"]')?.content || '';
        const checkUrl = `${window.location.pathname}?automedusa_check=${Date.now()}`;
        const response = await fetch(checkUrl, { cache: 'no-store' });
        if (!response.ok) return;
        const html = await response.text();
        const match = html.match(/<meta\s+name=["']automedusa-version["']\s+content=["']([^"']+)["']/i);
        const remoteVersion = match?.[1] || '';
        if (localVersion && remoteVersion && localVersion !== remoteVersion) {
            const url = new URL(window.location.href);
            url.searchParams.set('v', remoteVersion);
            window.location.replace(url.toString());
        }
    } catch (err) {
        console.debug('Version check skipped:', err);
    }
}

async function initApp() {
    checkForAppUpdate();
    document.querySelectorAll('[data-debug-only]').forEach(el => { el.hidden = !DEBUG; });
    wireUI();
    setAuthMode('signin');
    refreshUI();

    let savedTab = null;
    try { savedTab = sessionStorage.getItem('automedusa_tab'); } catch { /* storage unavailable */ }
    switchTab(TAB_TITLES[savedTab] ? savedTab : 'dashboard');

    // Registered first so a password-reset link's PASSWORD_RECOVERY event is never missed.
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
            if (currentUser) leaveApp();
        } else if (event === 'PASSWORD_RECOVERY') {
            currentUser = session?.user || currentUser;
            setAuthMode('new-password');
            showAuthOverlay();
        }
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) console.warn('Session check:', error);
    currentUser = data?.session?.user || null;

    if (currentUser && authMode !== 'new-password') await enterApp();
    else if (!currentUser) showAuthOverlay();

    window.addEventListener('online', async () => {
        if (!currentUser) return;
        await flushPendingOps();
        await loadCloudData({ silent: true });
    });
    window.addEventListener('offline', () => setSyncStatus('offline'));
    document.addEventListener('visibilitychange', () => {
        const stale = Date.now() - lastCloudLoadAt > 15000;
        if (document.visibilityState === 'visible' && currentUser && navigator.onLine && stale) refreshCloudData();
    });
}

// ---------------------------------------------------------------------------
// Formatting for the screen
// ---------------------------------------------------------------------------

const STATUS = {
    FOR_SALE: { label: 'For sale', tone: 'blue' },
    IN_PREP: { label: 'In prep', tone: 'orange' },
    PENDING: { label: 'Pending', tone: 'gray' },
    SOLD: { label: 'Sold', tone: 'green' }
};
const statusOf = car => STATUS[car.status] || { label: car.status || 'Unknown', tone: 'gray' };

function formatWhole(val) {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 }).format(Math.round(Number(val) || 0));
}

function formatSigned(val) {
    const n = Number(val) || 0;
    return `${n > 0 ? '+' : ''}${formatWhole(n)}`;
}

function plural(n, word, many = `${word}s`) {
    return `${n} ${n === 1 ? word : many}`;
}

function shortDate(value) {
    const d = parseLocalDate(value);
    if (!d) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(LOCALE, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(LOCALE, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function daysSince(value) {
    const d = parseLocalDate(value);
    return d ? Math.max(0, Math.floor((Date.now() - d) / 86400000)) : 0;
}

function categoryLabel(value) {
    const opt = [...$('expense-category-filter').options].find(o => o.value === value);
    return opt ? opt.textContent : value;
}

const SOURCE_LABELS = {
    'Copart Auction': 'Copart', 'Adesa Auction': 'ADESA', 'Private Seller': 'Private seller',
    'Trade-in': 'Trade-in', 'Off-Lease': 'Off-lease'
};
const sourceLabel = value => SOURCE_LABELS[value] || value || '';

function joinParts(...parts) {
    return parts.filter(Boolean).join(', ');
}

// One list row. Everything passed in is escaped here.
function row({ action, id, title, subtitle, value, valueSub, valueTone, subTone, dot, sr, cols = [], chevron = true, strong = false }) {
    const tag = action ? 'button' : 'div';
    const attrs = action ? ` type="button" data-action="${esc(action)}" data-id="${esc(id)}"` : '';
    return `<li><${tag} class="row${strong ? ' strong' : ''}"${attrs}>
        ${dot ? `<span class="dot dot-${dot}" aria-hidden="true"></span>` : ''}
        <span class="row-main">
            <span class="row-title">${esc(title)}</span>
            ${subtitle ? `<span class="row-sub">${esc(subtitle)}</span>` : ''}
            ${sr ? `<span class="sr-only">${esc(sr)}</span>` : ''}
        </span>
        ${cols.map(c => `<span class="row-col">${esc(c)}</span>`).join('')}
        ${value != null || valueSub ? `<span class="row-trail">
            ${value != null ? `<span class="row-value num${valueTone ? ` tone-${valueTone}` : ''}">${esc(value)}</span>` : ''}
            ${valueSub ? `<span class="row-sub num${subTone ? ` tone-${subTone}` : ''}">${esc(valueSub)}</span>` : ''}
        </span>` : ''}
        ${action && chevron ? '<i class="fa-solid fa-chevron-right row-chevron" aria-hidden="true"></i>' : ''}
    </${tag}></li>`;
}

function emptyRow(title, text, actionLabel, action) {
    return `<li class="empty">
        <p class="empty-title">${esc(title)}</p>
        ${text ? `<p>${esc(text)}</p>` : ''}
        ${actionLabel ? `<button type="button" class="btn btn-secondary btn-small" data-action="${esc(action)}">${esc(actionLabel)}</button>` : ''}
    </li>`;
}

function field(label, value, { mono = false, tone = '' } = {}) {
    return `<div class="field"><span>${esc(label)}</span><span class="field-value${mono ? ' mono' : ''}${tone ? ` tone-${tone}` : ''}">${esc(value)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ui = {
    tab: 'dashboard',
    inventoryStatus: 'ALL',
    expenseType: 'ALL',
    sourcingStage: 'WATCHLIST',
    detail: null // { kind: 'car' | 'expense' | 'acq', id }
};

function refreshUI() {
    renderDashboard();
    renderInventory();
    renderExpenses();
    renderSourcing();
    renderReports();
    populateCarSelectOptions();
    renderCharts();
    refreshDetail();
    saveState();
}

function totals() {
    const active = cars.filter(c => c.status !== 'SOLD');
    const sold = cars.filter(c => c.status === 'SOLD');
    const sum = (list, fn) => list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
    const overhead = sum(expenses.filter(e => e.type === 'OVERHEAD'), e => e.amount);
    const recon = sum(expenses.filter(e => e.type === 'VEHICLE'), e => e.amount);
    const revenue = sum(sold, c => c.salePrice);
    const soldCost = sum(sold, getCarCostBasis);
    const gross = revenue - soldCost;
    return {
        active, sold, overhead, recon, revenue, soldCost, gross,
        net: gross - overhead,
        inventoryValue: sum(active, getCarCostBasis),
        expenses: overhead + recon
    };
}

function renderDashboard() {
    const t = totals();

    const hero = $('kpi-net-profit');
    hero.textContent = formatWhole(t.net);
    hero.classList.toggle('negative', t.sold.length > 0 && t.net < 0);
    hero.classList.toggle('neutral', t.sold.length === 0);
    $('kpi-net-note').textContent = t.sold.length
        ? `From ${plural(t.sold.length, 'sold car')}, after ${formatWhole(t.overhead)} in overhead.`
        : cars.length ? 'Record your first sale to see profit here.' : 'Add your first car to get started.';

    $('kpi-inv-value').textContent = formatWhole(t.inventoryValue);
    $('kpi-inv-sub').textContent = `${plural(t.active.length, 'car')} in stock`;
    $('kpi-revenue').textContent = formatWhole(t.revenue);
    $('kpi-revenue-sub').textContent = `${t.sold.length} sold`;
    $('kpi-expenses').textContent = formatWhole(t.expenses);
    $('kpi-expenses-sub').textContent = `${formatWhole(t.overhead)} overhead`;

    const aging = t.active.filter(c => getDaysOnMarket(c) > 30).sort((a, b) => getDaysOnMarket(b) - getDaysOnMarket(a));
    $('attention-block').hidden = aging.length === 0;
    $('attention-list').className = 'list dotted';
    $('attention-list').innerHTML = aging.map(car => row({
        action: 'view-car', id: car.id, dot: statusOf(car).tone, sr: statusOf(car).label,
        title: vehicleName(car), subtitle: `Cost ${formatWhole(getCarCostBasis(car))}`,
        value: `${getDaysOnMarket(car)} days`, valueTone: 'red'
    })).join('');

    const recent = [...cars].sort(byDateDesc(c => c.purchaseDate)).slice(0, 5);
    $('recent-cars-list').className = 'list dotted';
    $('recent-cars-list').innerHTML = recent.length
        ? recent.map(car => row({
            action: 'view-car', id: car.id, dot: statusOf(car).tone, sr: statusOf(car).label,
            title: vehicleName(car),
            subtitle: joinParts(statusOf(car).label, car.purchaseDate ? `bought ${shortDate(car.purchaseDate)}` : ''),
            value: formatWhole(getCarCostBasis(car))
        })).join('')
        : emptyRow('No cars yet', 'Cars you buy show up here.', 'Add car', 'new-car');

    const byCategory = {};
    expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0); });
    const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const max = categories[0]?.[1] || 1;
    $('category-list').innerHTML = categories.length
        ? categories.map(([cat, amount]) => `<li><div class="row compact">
            <span class="row-main"><span class="row-title">${esc(categoryLabel(cat))}</span><span class="bar"><span style="width:${Math.max(2, (amount / max) * 100).toFixed(1)}%"></span></span></span>
            <span class="row-trail"><span class="row-value num">${esc(formatWhole(amount))}</span></span>
          </div></li>`).join('')
        : emptyRow('No expenses yet', 'Repairs, parts and overhead show up here.', 'Add expense', 'new-expense');
}

const INVENTORY_FILTER_DEFAULTS = {
    'filter-vehicle-type': 'ALL',
    'filter-age': 'ALL',
    'filter-min-price': '',
    'filter-max-price': '',
    'filter-date-from': '',
    'filter-date-to': '',
    'sort-inventory': 'newest'
};

function resetInventoryFilters() {
    Object.entries(INVENTORY_FILTER_DEFAULTS).forEach(([id, value]) => { $(id).value = value; });
    syncCombos($('sheet-filters'));
    renderInventory();
}

function renderInventory() {
    const v = id => $(id)?.value || '';
    const searchTerm = v('inventory-search').toLowerCase().trim();
    const typeFilter = v('filter-vehicle-type') || 'ALL';
    const ageFilter = v('filter-age') || 'ALL';
    const minPrice = v('filter-min-price') === '' ? null : Number(v('filter-min-price'));
    const maxPrice = v('filter-max-price') === '' ? null : Number(v('filter-max-price'));
    const dateFrom = v('filter-date-from');
    const dateTo = v('filter-date-to');
    const sortVal = v('sort-inventory') || 'newest';

    const activeFilters = Object.entries(INVENTORY_FILTER_DEFAULTS)
        .filter(([id, def]) => id !== 'sort-inventory' && v(id) !== def).length;
    $('filter-badge').hidden = activeFilters === 0;
    $('filter-badge').textContent = activeFilters || '';

    const unsold = cars.filter(c => c.status !== 'SOLD');
    $('inventory-subtitle').textContent = cars.length
        ? `${formatWhole(unsold.reduce((s, c) => s + getCarCostBasis(c), 0))} in ${plural(unsold.length, 'unsold car')}`
        : 'Cars you buy are tracked here from purchase to sale.';

    const filtered = cars.filter(c => {
        const costBasis = getCarCostBasis(c);
        const days = getDaysOnMarket(c);
        return (ui.inventoryStatus === 'ALL' || c.status === ui.inventoryStatus)
            && `${c.year} ${c.make} ${c.model} ${c.vin || ''} ${c.id} ${c.vehicleType || ''}`.toLowerCase().includes(searchTerm)
            && (typeFilter === 'ALL' || c.vehicleType === typeFilter)
            && (ageFilter === 'ALL' || getAgeBucket(days) === ageFilter)
            && (minPrice == null || costBasis >= minPrice)
            && (maxPrice == null || costBasis <= maxPrice)
            && (!dateFrom || c.purchaseDate >= dateFrom)
            && (!dateTo || c.purchaseDate <= dateTo);
    });

    const profitOf = c => c.status === 'SOLD' ? Number(c.salePrice || 0) - getCarCostBasis(c) : -Infinity;
    filtered.sort((a, b) => {
        if (sortVal === 'newest') return byDateDesc(c => c.purchaseDate)(a, b);
        if (sortVal === 'oldest') return byDateDesc(c => c.purchaseDate)(b, a);
        if (sortVal === 'age-desc') return getDaysOnMarket(b) - getDaysOnMarket(a);
        if (sortVal === 'age-asc') return getDaysOnMarket(a) - getDaysOnMarket(b);
        if (sortVal === 'price-desc') return getCarCostBasis(b) - getCarCostBasis(a);
        if (sortVal === 'price-asc') return getCarCostBasis(a) - getCarCostBasis(b);
        if (sortVal === 'profit-desc') return profitOf(b) - profitOf(a);
        return 0;
    });

    const list = $('inventory-list');
    list.className = 'list dotted';
    $('tab-inventory').querySelector('.list-head').hidden = filtered.length === 0;

    if (!filtered.length) {
        list.innerHTML = cars.length
            ? emptyRow('No matches', 'Try a different search or filter.', activeFilters ? 'Clear filters' : '', 'reset-filters')
            : emptyRow('No cars yet', 'Add a car when you buy it to track its costs and profit.', 'Add car', 'new-car');
        return;
    }

    list.innerHTML = filtered.map(car => {
        const sold = car.status === 'SOLD';
        const days = getDaysOnMarket(car);
        const profit = sold ? Number(car.salePrice || 0) - getCarCostBasis(car) : null;
        return row({
            action: 'view-car', id: car.id, dot: statusOf(car).tone, sr: statusOf(car).label,
            title: vehicleName(car),
            subtitle: joinParts(car.vehicleType || 'Other', `${Number(car.mileage || 0).toLocaleString(LOCALE)} km`),
            cols: [car.id, shortDate(car.purchaseDate) || '—', statusOf(car).label],
            value: sold ? formatSigned(profit) : formatWhole(getCarCostBasis(car)),
            valueTone: sold ? (profit >= 0 ? 'green' : 'red') : '',
            valueSub: sold ? `sold ${shortDate(car.saleDate)}` : `${days} ${days === 1 ? 'day' : 'days'}`,
            subTone: !sold && days > 30 ? 'red' : ''
        });
    }).join('');
}

function monthLabel(key) {
    return new Date(`${key}-01T12:00:00`).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
}

function renderExpenses() {
    const catFilter = $('expense-category-filter').value;
    const filtered = expenses.filter(e =>
        (ui.expenseType === 'ALL' || e.type === ui.expenseType) && (catFilter === 'ALL' || e.category === catFilter)
    ).reverse().sort(byDateDesc(e => e.date));

    const total = filtered.reduce((s, e) => s + Number(e.amount || 0), 0);
    $('expenses-subtitle').textContent = expenses.length ? `${formatWhole(total)} ${ui.expenseType === 'ALL' && catFilter === 'ALL' ? 'in total' : 'shown'}` : 'Repairs, parts and running costs.';

    const container = $('expenses-groups');
    if (!filtered.length) {
        container.innerHTML = `<ul class="list" style="margin-top:12px">${expenses.length
            ? emptyRow('No matches', 'Nothing in this category yet.')
            : emptyRow('No expenses yet', 'Log repairs against a car to see its true cost.', 'Add expense', 'new-expense')}</ul>`;
        return;
    }

    const groups = new Map();
    filtered.forEach(e => {
        const key = /^\d{4}-\d{2}/.test(e.date || '') ? e.date.slice(0, 7) : 'undated';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    });

    container.innerHTML = [...groups.entries()].map(([key, items]) => {
        const sum = items.reduce((s, e) => s + Number(e.amount || 0), 0);
        return `<div class="list-section-head"><span>${esc(key === 'undated' ? 'No date' : monthLabel(key))}</span><strong class="num">${esc(formatWhole(sum))}</strong></div>
            <ul class="list">${items.map(exp => {
                const car = cars.find(c => c.id === exp.carId);
                return row({
                    action: 'view-expense', id: exp.id,
                    title: categoryLabel(exp.category),
                    subtitle: joinParts(car ? vehicleName(car) : 'Overhead', exp.notes),
                    value: formatCurrency(exp.amount),
                    valueSub: shortDate(exp.date)
                });
            }).join('')}</ul>`;
    }).join('');
}

function renderSourcing() {
    const watching = acquisitions.filter(a => a.stage !== 'TRANSIT');
    const transit = acquisitions.filter(a => a.stage === 'TRANSIT');
    const prep = cars.filter(c => c.status === 'IN_PREP');

    $('count-watch').textContent = watching.length || '';
    $('count-transit').textContent = transit.length || '';
    $('count-prep').textContent = prep.length || '';
    $('acquisition-cloud-note').hidden = acquisitionsCloudReady || !currentUser;

    const list = $('sourcing-list');
    if (ui.sourcingStage === 'WATCHLIST') {
        list.innerHTML = watching.length ? watching.map(acq => {
            const safe = getAcquisitionSafeBid(acq);
            const over = Number(acq.currentBid || 0) > safe && safe > 0;
            return row({
                action: 'view-acq', id: acq.id,
                title: vehicleName(acq),
                subtitle: joinParts(sourceLabel(acq.source), formatDateTime(acq.auctionAt)),
                value: formatWhole(acq.currentBid),
                valueSub: over ? `over ${formatWhole(safe)} limit` : `safe to ${formatWhole(safe)}`,
                subTone: over ? 'red' : ''
            });
        }).join('') : emptyRow('Nothing on your watchlist', 'Track an auction car or private listing before you spend money.', 'Watch a car', 'new-acq');
    } else if (ui.sourcingStage === 'TRANSIT') {
        list.innerHTML = transit.length ? transit.map(acq => row({
            action: 'view-acq', id: acq.id,
            title: vehicleName(acq),
            subtitle: acq.transportEta ? `Arrives ${shortDate(acq.transportEta)}` : 'Arrival date not set',
            value: formatWhole(acq.purchasePrice || acq.currentBid)
        })).join('') : emptyRow('Nothing in transport', 'Cars you win wait here until they arrive.');
    } else {
        list.innerHTML = prep.length ? prep.map(car => row({
            action: 'view-car', id: car.id,
            title: vehicleName(car),
            subtitle: `${plural(daysSince(car.purchaseDate), 'day')} since purchase`,
            value: formatWhole(getCarCostBasis(car))
        })).join('') : emptyRow('Nothing in prep', 'Cars waiting for inspection or reconditioning show up here.');
    }
}

function renderReports() {
    const t = totals();
    const purchase = t.sold.reduce((s, c) => s + Number(c.purchasePrice || 0), 0);
    const recon = t.sold.reduce((s, c) => s + getCarRecondCost(c.id), 0);
    const margin = t.revenue - purchase;
    const net = margin - recon - t.overhead;

    $('pl-list').innerHTML = [
        row({ title: 'Sales', value: formatCurrency(t.revenue) }),
        row({ title: 'Purchase cost', value: `−${formatCurrency(purchase)}` }),
        row({ title: 'Gross margin', value: formatCurrency(margin), strong: true }),
        row({ title: 'Reconditioning', subtitle: 'On sold cars', value: `−${formatCurrency(recon)}` }),
        row({ title: 'Overhead', value: `−${formatCurrency(t.overhead)}` }),
        row({ title: 'Net profit', value: formatCurrency(net), valueTone: net < 0 ? 'red' : 'green', strong: true })
    ].join('');

    const sold = [...t.sold].sort(byDateDesc(c => c.saleDate));
    $('sold-list').innerHTML = sold.length ? sold.map(car => {
        const cost = getCarCostBasis(car);
        const profit = Number(car.salePrice || 0) - cost;
        const roi = cost > 0 ? (profit / cost) * 100 : NaN;
        return row({
            action: 'view-car', id: car.id,
            title: vehicleName(car),
            subtitle: `${formatWhole(car.salePrice)}, sold ${shortDate(car.saleDate)}`,
            value: formatSigned(profit), valueTone: profit >= 0 ? 'green' : 'red',
            valueSub: Number.isFinite(roi) ? `${roi.toFixed(1)}% return` : ''
        });
    }).join('') : emptyRow('No sales yet', 'Record a sale from a car in Inventory.');
}

function populateCarSelectOptions() {
    const select = $('expense-car-id');
    const previous = select.value;
    const activeCars = cars.filter(c => c.status !== 'SOLD');
    select.innerHTML = '';
    const add = (value, text) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
    };
    add('', activeCars.length ? 'Choose' : 'No unsold cars');
    activeCars.forEach(car => add(car.id, vehicleName(car)));
    if (activeCars.some(c => c.id === previous)) select.value = previous;
    syncCombos(select.closest('form') || document);
}

function renderCharts() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = 'rgba(235, 235, 245, 0.6)';

    // Undated expenses can't be placed on a timeline; they're called out underneath.
    const monthly = new Map();
    let undatedTotal = 0;
    const bucket = key => {
        if (!monthly.has(key)) monthly.set(key, { sales: 0, expenses: 0 });
        return monthly.get(key);
    };
    const monthOf = date => (/^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 7) : null);
    cars.filter(c => c.status === 'SOLD').forEach(c => { const k = monthOf(c.saleDate); if (k) bucket(k).sales += Number(c.salePrice || 0); });
    expenses.forEach(e => { const k = monthOf(e.date); if (k) bucket(k).expenses += Number(e.amount || 0); else undatedTotal += Number(e.amount || 0); });

    const keys = [...monthly.keys()].sort().slice(-12);
    const labels = keys.map(k => new Date(`${k}-01T12:00:00`).toLocaleDateString(LOCALE, { month: 'short' }));
    const sales = keys.map(k => monthly.get(k).sales);
    const spend = keys.map(k => monthly.get(k).expenses);

    const note = $('chart-profit-note');
    note.hidden = !undatedTotal;
    note.textContent = undatedTotal ? `${formatWhole(undatedTotal)} of expenses have no date, so they aren't shown.` : '';

    const canvas = $('chart-profit');
    const hasData = keys.length > 0;
    canvas.hidden = !hasData;
    $('chart-profit-empty').hidden = hasData;
    if (!hasData) {
        profitChart?.destroy();
        profitChart = null;
        return;
    }
    if (profitChart) {
        profitChart.data.labels = labels;
        profitChart.data.datasets[0].data = sales;
        profitChart.data.datasets[1].data = spend;
        profitChart.update();
        return;
    }
    profitChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Sales', data: sales, backgroundColor: '#0A84FF', borderRadius: 5, borderSkipped: false, maxBarThickness: 22, categoryPercentage: .6, barPercentage: .9 },
                { label: 'Expenses', data: spend, backgroundColor: '#FF9F0A', borderRadius: 5, borderSkipped: false, maxBarThickness: 22, categoryPercentage: .6, barPercentage: .9 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500, easing: 'easeOutQuart' },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(44, 44, 46, .95)', padding: 10, cornerRadius: 10,
                    titleFont: { size: 13, weight: '600' }, bodyFont: { size: 13 }, displayColors: true, boxPadding: 4,
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatWhole(ctx.parsed.y)}` }
                }
            },
            scales: {
                x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 12 } } },
                y: {
                    position: 'right',
                    grid: { color: 'rgba(84, 84, 88, 0.35)', drawTicks: false },
                    border: { display: false },
                    ticks: { font: { size: 12 }, padding: 8, maxTicksLimit: 4, callback: val => formatCurrencyCompact(val) }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Detail sheets
// ---------------------------------------------------------------------------

function showDetail(kind, id) {
    ui.detail = { kind, id };
    if (!refreshDetail()) return;
    openSheet('sheet-detail');
}

// Re-renders the open detail sheet (e.g. after a sync). Returns false if the record is gone.
function refreshDetail() {
    if (!ui.detail) return false;
    const { kind, id } = ui.detail;
    const record = kind === 'car' ? cars.find(c => c.id === id)
        : kind === 'expense' ? expenses.find(e => e.id === id)
        : acquisitions.find(a => a.id === id);
    if (!record) {
        if (openSheetId === 'sheet-detail') closeSheet();
        ui.detail = null;
        return false;
    }
    const render = { car: carDetail, expense: expenseDetail, acq: acqDetail }[kind];
    const { title, html } = render(record);
    $('detail-title').textContent = title;
    $('detail-body').innerHTML = html;
    return true;
}

function heroBlock(value, label, tone = '') {
    return `<div class="detail-hero"><p class="detail-hero-value num${tone ? ` tone-${tone}` : ''}">${esc(value)}</p><p class="detail-hero-label">${esc(label)}</p></div>`;
}

function actionButtons(buttons) {
    const list = buttons.filter(Boolean);
    if (!list.length) return '';
    return `<div class="detail-actions">${list.map(b =>
        `<button type="button" class="btn ${b.primary ? 'btn-primary' : 'btn-secondary'}" data-action="${esc(b.action)}" data-id="${esc(b.id)}">${esc(b.label)}</button>`
    ).join('')}</div>`;
}

function carDetail(car) {
    const id = car.id;
    const cost = getCarCostBasis(car);
    const recon = getCarRecondCost(id);
    const sold = car.status === 'SOLD';
    const profit = sold ? Number(car.salePrice || 0) - cost : null;
    const carExpenses = expenses.filter(e => e.carId === id).sort(byDateDesc(e => e.date));

    const hero = sold
        ? heroBlock(formatSigned(profit), `Profit on a ${formatWhole(car.salePrice)} sale`, profit >= 0 ? 'green' : 'red')
        : heroBlock(formatCurrency(cost), `Total cost, ${plural(getDaysOnMarket(car), 'day')} on market`);

    const actions = actionButtons([
        car.status === 'IN_PREP' && { label: 'Ready for sale', action: 'ready-car', id, primary: true },
        (car.status === 'FOR_SALE' || car.status === 'PENDING') && { label: 'Record sale', action: 'sell-car', id, primary: true },
        !sold && { label: 'Add expense', action: 'new-expense-for', id }
    ]);

    const money = `<div class="group">
        ${field('Paid', formatCurrency(car.purchasePrice))}
        ${field('Reconditioning', formatCurrency(recon))}
        ${field('Total cost', formatCurrency(cost))}
        ${sold ? field('Sold for', formatCurrency(car.salePrice)) : field('Asking price', car.targetPrice == null ? 'Not set' : formatCurrency(car.targetPrice))}
        ${sold && car.buyer ? field('Buyer', car.buyer) : ''}
    </div>`;

    const reconList = carExpenses.length ? `<h3 class="detail-section-title">Reconditioning</h3>
        <ul class="list" style="margin-bottom:24px">${carExpenses.map(e => row({
            action: 'view-expense', id: e.id, title: categoryLabel(e.category),
            subtitle: joinParts(shortDate(e.date), e.notes), value: formatCurrency(e.amount)
        })).join('')}</ul>` : '';

    const details = `<div class="group">
        ${field('Status', statusOf(car).label)}
        ${field('Stock number', id)}
        ${field('VIN', car.vin || 'Not entered', { mono: !!car.vin })}
        ${field('Type', car.vehicleType || 'Other')}
        ${field('Mileage', `${Number(car.mileage || 0).toLocaleString(LOCALE)} km`)}
        ${field('From', sourceLabel(car.source) || '—')}
        ${field('Bought', formatDisplayDate(car.purchaseDate) || '—')}
        ${field('Listed', formatDisplayDate(car.listedDate || car.purchaseDate) || '—')}
        ${sold ? field('Sold', formatDisplayDate(car.saleDate) || '—') : ''}
    </div>
    ${car.notes ? `<h3 class="detail-section-title">Notes</h3><div class="group"><div class="field"><span class="row-sub detail-note" style="color:var(--label);padding:11px 0">${esc(car.notes)}</span></div></div>` : ''}`;

    const remove = `<div class="group"><button type="button" class="field field-action destructive" data-action="delete-car" data-id="${esc(id)}">Delete car</button></div>`;
    return { title: vehicleName(car), html: hero + actions + money + reconList + details + remove };
}

function expenseDetail(exp) {
    const car = cars.find(c => c.id === exp.carId);
    const html = heroBlock(formatCurrency(exp.amount), categoryLabel(exp.category))
        + `<div class="group">
            ${car
                ? `<button type="button" class="field field-action" data-action="view-car" data-id="${esc(car.id)}"><span style="color:var(--label)">For</span><span class="field-value" style="color:var(--tint)">${esc(vehicleName(car))}</span></button>`
                : field('For', 'Overhead')}
            ${field('Date', formatDisplayDate(exp.date) || 'Not provided')}
            ${exp.notes ? field('Note', exp.notes) : ''}
        </div>
        <div class="group"><button type="button" class="field field-action destructive" data-action="delete-expense" data-id="${esc(exp.id)}">Delete expense</button></div>`;
    return { title: 'Expense', html };
}

function acqDetail(acq) {
    const id = acq.id;
    const transit = acq.stage === 'TRANSIT';
    const safe = getAcquisitionSafeBid(acq);
    const projected = getAcquisitionProjectedProfit(acq, transit ? acq.purchasePrice : null);
    const over = !transit && Number(acq.currentBid || 0) > safe && safe > 0;
    const href = safeUrl(acq.sourceUrl);

    const hero = transit
        ? heroBlock(formatWhole(acq.purchasePrice || acq.currentBid), acq.transportEta ? `Paid, arrives ${shortDate(acq.transportEta)}` : 'Paid')
        : heroBlock(formatWhole(acq.currentBid), over ? `Current bid, over your ${formatWhole(safe)} safe limit` : 'Current bid', over ? 'red' : '');

    const actions = actionButtons([
        transit ? { label: 'Mark arrived', action: 'arrived', id, primary: true } : { label: 'Mark as won', action: 'won-acq', id, primary: true },
        { label: 'Edit', action: 'edit-acq', id }
    ]);

    const numbers = `<div class="group">
        ${transit ? '' : field('Max safe bid', formatWhole(safe))}
        ${field(transit ? 'Expected profit' : 'Profit at this bid', formatWhole(projected), { tone: projected >= Number(acq.desiredProfit || 0) ? 'green' : projected >= 0 ? 'orange' : 'red' })}
        ${!transit && acq.maxBid ? field('Your limit', formatWhole(acq.maxBid)) : ''}
        ${field('Expected sale', formatWhole(acq.expectedSalePrice))}
        ${field('Fees, transport, repairs', formatWhole(Number(acq.estimatedFees || 0) + Number(acq.estimatedTransport || 0) + Number(acq.estimatedRepairs || 0)))}
    </div>`;

    const details = `<div class="group">
        ${field('From', sourceLabel(acq.source) || '—')}
        ${acq.auctionAt ? field('Auction', formatDateTime(acq.auctionAt)) : ''}
        ${acq.vin ? field('VIN', acq.vin, { mono: true }) : ''}
        ${acq.mileage ? field('Mileage', `${Number(acq.mileage).toLocaleString(LOCALE)} km`) : ''}
        ${field('Type', acq.vehicleType || 'Other')}
        ${href ? `<a class="field field-action" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open listing<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" style="margin-left:auto;font-size:13px"></i></a>` : ''}
    </div>
    ${acq.notes ? `<h3 class="detail-section-title">Notes</h3><div class="group"><div class="field"><span class="row-sub detail-note" style="color:var(--label);padding:11px 0">${esc(acq.notes)}</span></div></div>` : ''}`;

    const remove = `<div class="group"><button type="button" class="field field-action destructive" data-action="delete-acq" data-id="${esc(id)}">Remove from sourcing</button></div>`;
    return { title: vehicleName(acq), html: hero + actions + numbers + details + remove };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openNewCar() {
    $('form-add-car').reset();
    const today = localDateISO();
    $('car-purchase-date').value = today;
    $('car-listed-date').value = today;
    $('car-source').value = 'Private Seller';
    openSheet('sheet-add-car');
}

async function handleAddCar(event) {
    event.preventDefault();
    if (!$('form-add-car').reportValidity()) return;

    const targetRaw = $('car-target-price').value;
    const purchaseDate = $('car-purchase-date').value;
    const newCar = {
        id: generateStockId(),
        year: Number($('car-year').value),
        make: $('car-make').value.trim(),
        model: $('car-model').value.trim(),
        vin: $('car-vin').value.trim().toUpperCase(),
        mileage: Number($('car-mileage').value),
        purchasePrice: Number($('car-purchase-price').value),
        purchaseDate,
        listedDate: $('car-listed-date').value || purchaseDate,
        vehicleType: $('car-vehicle-type').value,
        source: $('car-source').value,
        targetPrice: targetRaw === '' ? null : Number(targetRaw),
        status: 'IN_PREP',
        notes: $('car-notes').value.trim(),
        salePrice: null, saleDate: null, buyer: null
    };

    cars.push(newCar);
    refreshUI();
    closeSheet();
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(newCar) }, `Added ${vehicleName(newCar)}`);
}

function setExpenseType(type) {
    $('expense-type').value = type;
    setSegment($('expense-type-segment'), type);
    $('expense-vehicle-row').hidden = type === 'OVERHEAD';
}

function openNewExpense(carId = '') {
    $('form-add-expense').reset();
    populateCarSelectOptions();
    setExpenseType('VEHICLE');
    $('expense-date').value = localDateISO();
    if (carId) $('expense-car-id').value = carId;
    openSheet('sheet-add-expense');
}

async function handleAddExpense(event) {
    event.preventDefault();
    const form = $('form-add-expense');
    const type = $('expense-type').value;
    const carId = type === 'VEHICLE' ? $('expense-car-id').value : null;

    if (type === 'VEHICLE' && !carId) {
        showToast('Choose which car this is for', 'error');
        $('expense-car-id-search').focus();
        return;
    }
    if (!form.reportValidity()) return;

    const amount = Number($('expense-amount').value);
    const newExpense = {
        id: `EXP-${Date.now()}-${randomToken(5)}`,
        type,
        carId,
        category: $('expense-category').value,
        amount,
        date: $('expense-date').value,
        notes: $('expense-notes').value.trim()
    };

    expenses.push(newExpense);
    refreshUI();
    closeSheet();
    await runOrQueueCloudOp({ kind: 'upsert_expense', payload: expenseToDb(newExpense) }, `${formatCurrency(amount)} expense added`);
}

function openRecordSale(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;
    $('form-record-sale').reset();
    $('sale-car-id').value = car.id;
    $('sale-vehicle-title').textContent = `${vehicleName(car)}, total cost ${formatCurrency(getCarCostBasis(car))}`;
    $('sale-price').value = car.targetPrice || '';
    $('sale-date').value = localDateISO();
    updateSalePreview();
    openSheet('sheet-record-sale');
}

function updateSalePreview() {
    const car = cars.find(c => c.id === $('sale-car-id').value);
    const price = $('sale-price').value;
    const el = $('sale-profit-preview');
    if (!car || price === '') { el.textContent = ''; return; }
    const profit = Number(price) - getCarCostBasis(car);
    el.textContent = `${profit >= 0 ? 'Profit' : 'Loss'} on this sale: ${formatCurrency(Math.abs(profit))}`;
    el.className = `group-footer num ${profit >= 0 ? 'tone-green' : 'tone-red'}`;
}

async function handleRecordSale(event) {
    event.preventDefault();
    if (!$('form-record-sale').reportValidity()) return;
    const car = cars.find(c => c.id === $('sale-car-id').value);
    if (!car) return;

    car.status = 'SOLD';
    car.salePrice = Number($('sale-price').value);
    car.saleDate = $('sale-date').value;
    car.buyer = $('sale-buyer').value.trim();

    refreshUI();
    closeSheet();
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) }, `Sold for ${formatWhole(car.salePrice)}`);
}

let confirmResolve = null;

// One iOS-style alert for every yes/no question in the app.
function confirmAction({ title = 'Delete?', message = '', confirmLabel = 'Delete', destructive = true } = {}) {
    const layer = $('confirm-dialog');
    const cancelBtn = $('confirm-cancel');
    const acceptBtn = $('confirm-accept');
    if (confirmResolve) confirmResolve(false);

    const returnFocus = document.activeElement;
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    acceptBtn.textContent = confirmLabel;
    acceptBtn.classList.toggle('destructive', destructive);

    const openSheetEl = openSheetId ? $(openSheetId) : null;
    layer.hidden = false;
    $('app-shell').inert = true;
    if (openSheetEl) openSheetEl.inert = true;

    return new Promise(resolve => {
        const onKey = event => {
            if (event.key === 'Escape') { event.stopPropagation(); close(false); }
        };
        const close = result => {
            layer.hidden = true;
            if (openSheetEl) openSheetEl.inert = false;
            if (!openSheetId) $('app-shell').inert = false;
            cancelBtn.onclick = acceptBtn.onclick = layer.onclick = null;
            document.removeEventListener('keydown', onKey, true);
            confirmResolve = null;
            returnFocus?.focus?.({ preventScroll: true });
            resolve(result);
        };
        confirmResolve = close;
        cancelBtn.onclick = () => close(false);
        acceptBtn.onclick = () => close(true);
        layer.onclick = event => { if (event.target === layer) close(false); };
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => cancelBtn.focus(), 0);
    });
}

async function deleteCar(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;
    const related = expenses.filter(e => e.carId === carId).map(e => e.id);
    const ok = await confirmAction({
        title: `Delete ${vehicleName(car)}?`,
        message: related.length
            ? `Its ${plural(related.length, 'expense')} will be deleted too. This can't be undone.`
            : "This can't be undone."
    });
    if (!ok) return;

    cars = cars.filter(c => c.id !== carId);
    expenses = expenses.filter(e => e.carId !== carId);
    refreshUI();
    for (const expId of related) await runOrQueueCloudOp({ kind: 'delete_expense', id: expId });
    await runOrQueueCloudOp({ kind: 'delete_car', id: carId }, 'Car deleted');
}

async function deleteExpense(expId) {
    const exp = expenses.find(e => e.id === expId);
    if (!exp) return;
    const ok = await confirmAction({
        title: 'Delete this expense?',
        message: `${categoryLabel(exp.category)}, ${formatCurrency(exp.amount)}. This can't be undone.`
    });
    if (!ok) return;

    expenses = expenses.filter(e => e.id !== expId);
    refreshUI();
    await runOrQueueCloudOp({ kind: 'delete_expense', id: expId }, 'Expense deleted');
}

function acquisitionFormNumber(id) {
    return Number($(id)?.value || 0);
}

function updateAcquisitionCalculator() {
    const preview = {
        expectedSalePrice: acquisitionFormNumber('acq-expected-sale'),
        desiredProfit: acquisitionFormNumber('acq-desired-profit'),
        estimatedFees: acquisitionFormNumber('acq-est-fees'),
        estimatedTransport: acquisitionFormNumber('acq-est-transport'),
        estimatedRepairs: acquisitionFormNumber('acq-est-repairs'),
        currentBid: acquisitionFormNumber('acq-current-bid')
    };
    const safe = getAcquisitionSafeBid(preview);
    const projected = getAcquisitionProjectedProfit(preview);
    $('acq-safe-bid-preview').textContent = formatWhole(safe);
    const profitEl = $('acq-profit-preview');
    profitEl.textContent = formatWhole(projected);
    profitEl.className = `calc-value num ${projected >= preview.desiredProfit ? 'tone-green' : projected >= 0 ? 'tone-orange' : 'tone-red'}`;
}

function toDatetimeLocal(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openAcquisitionForm(id = '') {
    const form = $('form-acquisition');
    form.reset();
    const acq = id ? acquisitions.find(a => a.id === id) : null;
    $('acq-id').value = acq?.id || '';
    $('sheet-acquisition-title').textContent = acq ? 'Edit watched car' : 'Watch a car';
    $('acq-submit').textContent = acq ? 'Save' : 'Add';
    if (acq) {
        const set = (fieldId, value) => { $(fieldId).value = value ?? ''; };
        set('acq-year', acq.year || '');
        set('acq-make', acq.make);
        set('acq-model', acq.model);
        set('acq-vehicle-type', acq.vehicleType || 'Other');
        set('acq-mileage', acq.mileage || '');
        set('acq-vin', acq.vin);
        set('acq-source', acq.source || 'Other');
        set('acq-auction-at', toDatetimeLocal(acq.auctionAt));
        set('acq-source-url', acq.sourceUrl);
        set('acq-current-bid', acq.currentBid || '');
        set('acq-max-bid', acq.maxBid || '');
        set('acq-expected-sale', acq.expectedSalePrice || '');
        set('acq-desired-profit', acq.desiredProfit || '');
        set('acq-est-fees', acq.estimatedFees || '');
        set('acq-est-transport', acq.estimatedTransport || '');
        set('acq-est-repairs', acq.estimatedRepairs || '');
        set('acq-notes', acq.notes);
    }
    updateAcquisitionCalculator();
    openSheet('sheet-acquisition');
}

async function handleSaveAcquisition(event) {
    event.preventDefault();
    if (!$('form-acquisition').reportValidity()) return;

    const existingId = $('acq-id').value;
    const existing = acquisitions.find(a => a.id === existingId);
    const urlRaw = $('acq-source-url').value.trim();
    if (urlRaw && !safeUrl(urlRaw)) {
        showToast('The listing link must start with https://', 'error');
        $('acq-source-url').focus();
        return;
    }
    const auctionRaw = $('acq-auction-at').value;

    const acq = {
        id: existingId || `ACQ-${Date.now()}-${randomToken(4)}`,
        stage: existing?.stage || 'WATCHLIST',
        year: Number($('acq-year').value),
        make: $('acq-make').value.trim(),
        model: $('acq-model').value.trim(),
        vehicleType: $('acq-vehicle-type').value,
        vin: $('acq-vin').value.trim().toUpperCase(),
        mileage: acquisitionFormNumber('acq-mileage'),
        source: $('acq-source').value,
        sourceUrl: safeUrl(urlRaw),
        auctionAt: auctionRaw ? new Date(auctionRaw).toISOString() : '',
        currentBid: acquisitionFormNumber('acq-current-bid'),
        maxBid: $('acq-max-bid').value ? acquisitionFormNumber('acq-max-bid') : null,
        expectedSalePrice: acquisitionFormNumber('acq-expected-sale'),
        desiredProfit: acquisitionFormNumber('acq-desired-profit'),
        estimatedFees: acquisitionFormNumber('acq-est-fees'),
        estimatedTransport: acquisitionFormNumber('acq-est-transport'),
        estimatedRepairs: acquisitionFormNumber('acq-est-repairs'),
        purchasePrice: existing?.purchasePrice ?? null,
        purchaseDate: existing?.purchaseDate || '',
        transportEta: existing?.transportEta || '',
        notes: $('acq-notes').value.trim(),
        createdAt: existing?.createdAt || new Date().toISOString()
    };

    const index = acquisitions.findIndex(a => a.id === acq.id);
    if (index >= 0) acquisitions[index] = acq;
    else acquisitions.unshift(acq);

    refreshUI();
    closeSheet();
    if (!existingId) setSourcingStage('WATCHLIST');
    await runOrQueueCloudOp({ kind: 'upsert_acquisition', payload: acquisitionToDb(acq) }, existingId ? 'Changes saved' : 'Added to your watchlist');
}

function openMarkWon(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;
    $('form-acq-won').reset();
    $('acq-won-id').value = acq.id;
    $('acq-won-vehicle').textContent = joinParts(vehicleName(acq), sourceLabel(acq.source));
    $('acq-won-price').value = Number(acq.currentBid || acq.maxBid || 0) || '';
    $('acq-won-date').value = localDateISO();
    $('acq-transport-eta').value = acq.transportEta || '';
    openSheet('sheet-acq-won');
}

async function handleMarkAcquisitionWon(event) {
    event.preventDefault();
    if (!$('form-acq-won').reportValidity()) return;
    const acq = acquisitions.find(a => a.id === $('acq-won-id').value);
    if (!acq) return;

    acq.stage = 'TRANSIT';
    acq.purchasePrice = Number($('acq-won-price').value || 0);
    acq.currentBid = acq.purchasePrice;
    acq.purchaseDate = $('acq-won-date').value;
    acq.transportEta = $('acq-transport-eta').value;

    refreshUI();
    closeSheet();
    setSourcingStage('TRANSIT');
    await runOrQueueCloudOp({ kind: 'upsert_acquisition', payload: acquisitionToDb(acq) }, 'Moved to In transport');
}

async function markAcquisitionArrived(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;
    const ok = await confirmAction({
        title: 'Mark as arrived?',
        message: `${vehicleName(acq)} will be added to your inventory as In prep.`,
        confirmLabel: 'Add to inventory',
        destructive: false
    });
    if (!ok) return;

    const car = migrateCarSchema({
        id: generateStockId(),
        year: acq.year,
        make: acq.make,
        model: acq.model,
        vehicleType: acq.vehicleType || inferVehicleType(acq),
        vin: acq.vin || '',
        mileage: Number(acq.mileage || 0),
        purchasePrice: Number(acq.purchasePrice || acq.currentBid || 0),
        purchaseDate: acq.purchaseDate || localDateISO(),
        listedDate: '',
        source: acq.source || 'Other',
        targetPrice: Number(acq.expectedSalePrice || 0) || null,
        status: 'IN_PREP',
        notes: acq.notes || '',
        salePrice: null,
        saleDate: null,
        buyer: null
    });

    cars.unshift(car);
    acquisitions = acquisitions.filter(a => a.id !== id);
    refreshUI();
    closeSheet();
    setSourcingStage('PREP');
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) });
    await runOrQueueCloudOp({ kind: 'delete_acquisition', id }, 'Added to inventory');
}

async function markCarReadyForSale(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;
    car.status = 'FOR_SALE';
    if (!car.listedDate) car.listedDate = localDateISO();
    refreshUI();
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) }, 'Marked for sale');
}

async function deleteAcquisition(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;
    const ok = await confirmAction({
        title: `Remove ${vehicleName(acq)}?`,
        message: "It will be removed from sourcing. This can't be undone.",
        confirmLabel: 'Remove'
    });
    if (!ok) return;

    acquisitions = acquisitions.filter(a => a.id !== id);
    refreshUI();
    await runOrQueueCloudOp({ kind: 'delete_acquisition', id }, 'Removed');
}

// Quotes every field and neutralises values a spreadsheet would run as a formula.
function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function exportCarsCSV() {
    const header = ['StockID', 'Year', 'Make', 'Model', 'VehicleType', 'VIN', 'Mileage', 'PurchasePrice', 'PurchaseDate', 'ListedDate', 'DaysOnMarket', 'Source', 'RecondCost', 'CostBasis', 'Status', 'SalePrice', 'SaleDate', 'Buyer'];
    const lines = [header.join(',')];
    cars.forEach(c => {
        lines.push([
            c.id, c.year, c.make, c.model, c.vehicleType || 'Other', c.vin || '', c.mileage, c.purchasePrice,
            c.purchaseDate, c.listedDate || c.purchaseDate || '', getDaysOnMarket(c), c.source,
            getCarRecondCost(c.id), getCarCostBasis(c), c.status, c.salePrice ?? '', c.saleDate || '', c.buyer || ''
        ].map(csvCell).join(','));
    });

    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Dealership_Inventory_${localDateISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Inventory exported');
}

// ---------------------------------------------------------------------------
// Navigation, sheets, menus, segmented controls, toasts
// ---------------------------------------------------------------------------

let titleObserver = null;

function switchTab(tabId, { userInitiated = false } = {}) {
    if (!TAB_TITLES[tabId]) tabId = 'dashboard';

    // Tapping the current tab again scrolls back to the top, like iOS.
    if (tabId === ui.tab && userInitiated && !$(`tab-${tabId}`).hidden) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }

    ui.tab = tabId;
    document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== `tab-${tabId}`; });
    document.querySelectorAll('.nav-link[data-tab], .tab-bar [data-tab]').forEach(el => {
        if (el.dataset.tab === tabId) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
    $('navbar-title').textContent = TAB_TITLES[tabId];
    $('navbar').classList.remove('scrolled');
    document.title = `${TAB_TITLES[tabId]} · AutoMedusa`;
    window.scrollTo(0, 0);
    if (profitChart && tabId === 'dashboard') profitChart.resize();
    try { sessionStorage.setItem('automedusa_tab', tabId); } catch { /* storage unavailable */ }
}

// The compact title in the top bar appears once the page's large title scrolls under it.
function watchLargeTitles() {
    titleObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.target.closest('.tab')?.id !== `tab-${ui.tab}`) return;
            $('navbar').classList.toggle('scrolled', !entry.isIntersecting);
        });
    }, { rootMargin: '-48px 0px 0px 0px', threshold: 0 });
    document.querySelectorAll('.large-title').forEach(el => titleObserver.observe(el));
}

function setSegment(el, value) {
    const buttons = [...el.querySelectorAll('button[data-value]')];
    el.style.setProperty('--n', buttons.length);
    buttons.forEach((b, i) => {
        const on = b.dataset.value === value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on) el.style.setProperty('--i', i);
    });
}

function initSegment(el, initial, onChange) {
    setSegment(el, initial);
    el.addEventListener('click', event => {
        const button = event.target.closest('button[data-value]');
        if (!button) return;
        setSegment(el, button.dataset.value);
        onChange(button.dataset.value);
    });
    el.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const buttons = [...el.querySelectorAll('button[data-value]')];
        const current = buttons.findIndex(b => b.getAttribute('aria-checked') === 'true');
        const next = buttons[(current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
        event.preventDefault();
        next.focus();
        next.click();
    });
}

function setSourcingStage(stage) {
    ui.sourcingStage = stage;
    setSegment($('sourcing-segment'), stage);
    renderSourcing();
}

let openSheetId = null;
let sheetReturnFocus = null;

function openSheet(id) {
    const sheet = $(id);
    if (!sheet) return;
    closeAddMenu();
    if (openSheetId && openSheetId !== id) {
        if (openSheetId === 'sheet-detail') ui.detail = null;
        $(openSheetId).classList.remove('open');
        $(openSheetId).style.transform = '';
    } else if (!openSheetId) {
        sheetReturnFocus = document.activeElement;
    }
    openSheetId = id;
    sheet.querySelector('.sheet-body').scrollTop = 0;
    sheet.style.transform = '';
    // Force a style flush so the slide-up always animates from the closed position.
    void sheet.offsetHeight;
    syncCombos(sheet);
    sheet.classList.add('open');
    $('sheet-backdrop').classList.add('visible');
    $('app-shell').inert = true;
    document.body.classList.add('sheet-open');

    const touch = window.matchMedia('(pointer: coarse)').matches;
    const first = !touch && sheet.querySelector('.sheet-body input:not([type="hidden"]):not(.combo-input):not([role="combobox"]), .sheet-body textarea');
    setTimeout(() => (first || sheet.querySelector('.sheet-header button'))?.focus({ preventScroll: true }), 60);
}

function closeSheet({ immediate = false } = {}) {
    if (!openSheetId) return;
    const sheet = $(openSheetId);
    if (sheet.id === 'sheet-detail') ui.detail = null;
    sheet.classList.remove('open', 'dragging');
    sheet.style.transform = '';
    if (immediate) {
        sheet.style.transition = 'none';
        void sheet.offsetHeight;
        sheet.style.transition = '';
    }
    openSheetId = null;
    $('sheet-backdrop').classList.remove('visible');
    $('sheet-backdrop').style.opacity = '';
    $('app-shell').inert = false;
    document.body.classList.remove('sheet-open');
    sheetReturnFocus?.focus?.({ preventScroll: true });
    sheetReturnFocus = null;
}

// Swipe a sheet down by its header to dismiss it (iPhone).
function enableSheetDrag(sheet) {
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let dragging = false;

    const onMove = event => {
        if (!dragging) return;
        dy = Math.max(0, event.clientY - startY);
        sheet.style.transform = `translateY(${dy}px)`;
        $('sheet-backdrop').style.opacity = String(Math.max(0, 1 - dy / (sheet.offsetHeight || 1)));
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove('dragging');
        $('sheet-backdrop').style.opacity = '';
        const velocity = dy / Math.max(1, Date.now() - startT);
        if (dy > 120 || velocity > 0.6) closeSheet();
        else sheet.style.transform = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
    };

    sheet.querySelectorAll('.sheet-header, .sheet-grabber').forEach(handle => {
        handle.addEventListener('pointerdown', event => {
            if (event.pointerType === 'mouse' || window.innerWidth >= 768) return;
            if (event.target.closest('button, a, input, select')) return;
            dragging = true;
            startY = event.clientY;
            startT = Date.now();
            dy = 0;
            sheet.classList.add('dragging');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        });
    });
}

function toggleAddMenu() {
    const menu = $('add-menu');
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    $('add-button').setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => menu.querySelector('button')?.focus({ preventScroll: true }), 50);
}

function closeAddMenu() {
    $('add-menu')?.classList.remove('open');
    $('add-button')?.setAttribute('aria-expanded', 'false');
}

let toastTimer = null;

function showToast(message, type = 'success') {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.toggle('error', type === 'error');
    toast.classList.remove('show');
    void toast.offsetHeight;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), type === 'error' ? 5000 : 2400);
}

// ---------------------------------------------------------------------------
// Type-to-filter fields. Dropdowns become text fields with a list underneath;
// options that don't match what you've typed disappear as you type.
// ---------------------------------------------------------------------------

const COMMON_MAKES = Object.keys(CAR_MODELS);

function modelsForMake(make) {
    const key = COMMON_MAKES.find(m => m.toLowerCase() === make.trim().toLowerCase());
    return key ? CAR_MODELS[key] : [];
}

const combos = [];
let comboSeq = 0;

// Every word typed must appear somewhere in the option: "ram 15" finds "2019 Ram 1500 Classic".
function comboMatches(label, query) {
    const text = label.toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

function uniqueSorted(values) {
    const seen = new Map();
    values.filter(Boolean).forEach(v => {
        const key = v.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, v.trim());
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * kind 'select': backed by a <select>; you must end on one of its options.
 * kind 'suggest': a free-text input that offers suggestions but accepts anything.
 */
function createCombo({ kind, select = null, input = null, getOptions, anchor, popover = false, placeholder = '' }) {
    const listId = `combo-list-${++comboSeq}`;
    const list = document.createElement('div');
    list.className = `combo-list${popover ? ' combo-popover' : ''}`;
    list.id = listId;
    list.setAttribute('role', 'listbox');

    if (kind === 'select') {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'combo-input';
        input.placeholder = placeholder;
        if (select.id) input.setAttribute('aria-label', select.closest('label')?.querySelector('span')?.textContent || select.id);
        select.hidden = true;
        select.tabIndex = -1;
        input.id = `${select.id}-search`;
        const label = select.closest('label');
        if (label) label.htmlFor = input.id;
        select.insertAdjacentElement('afterend', input);
    }
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    anchor.insertAdjacentElement('afterend', list);

    const state = { kind, select, input, list, getOptions, items: [], active: -1, open: false };

    const currentLabel = () => {
        if (kind !== 'select') return input.value;
        const opt = select.selectedOptions[0];
        return opt && opt.value !== '' ? opt.textContent : '';
    };

    const render = () => {
        const query = state.typed ? input.value.trim() : '';
        const options = getOptions().filter(o => !query || comboMatches(o.label, query));
        state.items = options.slice(0, 50);
        const selectedValue = kind === 'select' ? select.value : null;
        if (state.active >= state.items.length) state.active = state.items.length - 1;
        list.innerHTML = state.items.length
            ? state.items.map((o, i) => `<div class="combo-option${i === state.active ? ' active' : ''}" role="option" id="${listId}-${i}" data-index="${i}" aria-selected="${o.value === selectedValue}">
                <span>${esc(o.label)}</span>${o.value === selectedValue ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}</div>`).join('')
            : (kind === 'select' ? '<div class="combo-empty">No matches</div>' : '');
        const show = state.items.length > 0 || kind === 'select';
        state.open = show;
        list.classList.toggle('open', show);
        input.setAttribute('aria-expanded', String(show));
        if (state.active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${state.active}`);
        else input.removeAttribute('aria-activedescendant');
        list.querySelector('.combo-option.active')?.scrollIntoView({ block: 'nearest' });
    };

    const open = () => { state.active = -1; render(); };
    const close = () => {
        state.open = false;
        state.typed = false;
        list.classList.remove('open');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    };

    const choose = index => {
        const option = state.items[index];
        if (!option) return;
        if (kind === 'select') {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            input.value = option.label;
        } else {
            input.value = option.value;
            state.silent = true; // let other listeners react without reopening this list
            input.dispatchEvent(new Event('input', { bubbles: true }));
            state.silent = false;
        }
        close();
    };

    input.addEventListener('focus', () => {
        if (kind === 'select') input.select();
        open();
    });
    input.addEventListener('input', event => {
        if (state.silent) return;
        state.typed = true;
        state.active = input.value.trim() ? 0 : -1;
        render();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!state.open) open();
            const n = state.items.length;
            if (!n) return;
            state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
            render();
        } else if (event.key === 'Enter' && state.open && state.active >= 0) {
            event.preventDefault();
            choose(state.active);
        } else if (event.key === 'Escape' && state.open) {
            event.stopPropagation();
            input.value = currentLabel();
            close();
        } else if (event.key === 'Tab' && state.open && state.typed && state.active >= 0) {
            choose(state.active);
        }
    });
    input.addEventListener('blur', () => {
        if (kind === 'select') {
            // Accept an exact match typed in full; otherwise go back to the current choice.
            const typed = input.value.trim().toLowerCase();
            const exact = typed && getOptions().find(o => o.label.toLowerCase() === typed);
            if (exact && exact.value !== select.value) {
                select.value = exact.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            input.value = currentLabel();
        }
        close();
    });
    // Keep focus in the field while tapping an option, so blur doesn't fire first.
    list.addEventListener('pointerdown', event => event.preventDefault());
    list.addEventListener('click', event => {
        const el = event.target.closest('.combo-option');
        if (el) choose(Number(el.dataset.index));
    });

    state.sync = () => { if (kind === 'select' && document.activeElement !== input) input.value = currentLabel(); };
    state.close = close;
    combos.push(state);
    state.sync();
    return state;
}

function syncCombos(root = document) {
    combos.forEach(c => { if (root.contains(c.input)) { c.sync(); c.close(); } });
}

function selectOptions(select) {
    return () => [...select.options].filter(o => o.value !== '').map(o => ({ value: o.value, label: o.textContent }));
}

function initCombos() {
    const asSelect = (id, placeholder) => {
        const select = $(id);
        createCombo({ kind: 'select', select, getOptions: selectOptions(select), anchor: select.closest('.field'), placeholder });
    };
    asSelect('expense-car-id', 'Search cars');
    asSelect('expense-category', 'Search categories');
    asSelect('car-vehicle-type', 'Type');
    asSelect('car-source', 'Source');
    asSelect('acq-vehicle-type', 'Type');
    asSelect('acq-source', 'Source');
    asSelect('filter-vehicle-type', 'Any');

    // The category filter on the Expenses page opens as a small floating list.
    const catSelect = $('expense-category-filter');
    createCombo({
        kind: 'select', select: catSelect, getOptions: selectOptions(catSelect),
        anchor: catSelect.closest('.plain-select'), popover: true, placeholder: 'All categories'
    });
    catSelect.closest('.plain-select').classList.add('plain-combo');

    // Make and model suggest from common makes and what's already in your inventory.
    const knownMakes = () => uniqueSorted([...COMMON_MAKES, ...cars.map(c => c.make), ...acquisitions.map(a => a.make)])
        .map(m => ({ value: m, label: m }));
    // Models for the chosen make: every model on record for it, plus any you've stocked before.
    const knownModels = makeInputId => () => {
        const make = $(makeInputId).value.trim().toLowerCase();
        const pool = [...cars, ...acquisitions].filter(x => !make || (x.make || '').toLowerCase() === make);
        const listed = make ? modelsForMake(make) : [];
        return uniqueSorted([...listed, ...pool.map(x => x.model)]).map(m => ({ value: m, label: m }));
    };
    [['car-make', 'car-model'], ['acq-make', 'acq-model']].forEach(([makeId, modelId]) => {
        createCombo({ kind: 'suggest', input: $(makeId), getOptions: knownMakes, anchor: $(makeId).closest('.field') });
        createCombo({ kind: 'suggest', input: $(modelId), getOptions: knownModels(makeId), anchor: $(modelId).closest('.field') });
    });
}

// Every button rendered from data uses data-action / data-id; nothing runs inline JavaScript.
const ACTIONS = {
    'view-car': id => showDetail('car', id),
    'view-expense': id => showDetail('expense', id),
    'view-acq': id => showDetail('acq', id),
    'sell-car': id => openRecordSale(id),
    'ready-car': id => markCarReadyForSale(id),
    'delete-car': id => deleteCar(id),
    'delete-expense': id => deleteExpense(id),
    'new-car': () => openNewCar(),
    'new-expense': () => openNewExpense(),
    'new-expense-for': id => openNewExpense(id),
    'new-acq': () => openAcquisitionForm(),
    'edit-acq': id => openAcquisitionForm(id),
    'delete-acq': id => deleteAcquisition(id),
    'won-acq': id => openMarkWon(id),
    'arrived': id => markAcquisitionArrived(id),
    'open-filters': () => openSheet('sheet-filters'),
    'reset-filters': () => resetInventoryFilters(),
    'export-csv': () => exportCarsCSV(),
    'open-account': () => openSheet('sheet-account'),
    'refresh': () => { closeSheet(); refreshCloudData({ retryFailed: true }); },
    'diagnose': () => diagnoseCloud(),
    'sign-out': () => { closeSheet(); signOutAutoMedusa(); },
    'close-sheet': () => closeSheet(),
    'toggle-add-menu': () => toggleAddMenu(),
    'toggle-auth-mode': () => toggleAuthMode()
};

function wireUI() {
    document.addEventListener('click', event => {
        const menu = $('add-menu');
        if (menu.classList.contains('open') && !event.target.closest('.menu-anchor')) closeAddMenu();

        const tabButton = event.target.closest('[data-tab]');
        if (tabButton) {
            switchTab(tabButton.dataset.tab, { userInitiated: true });
            return;
        }
        const actionEl = event.target.closest('[data-action]');
        if (actionEl && ACTIONS[actionEl.dataset.action]) {
            if (actionEl.closest('.menu')) closeAddMenu();
            ACTIONS[actionEl.dataset.action](actionEl.dataset.id);
        }
    });

    $('sheet-backdrop').addEventListener('click', () => closeSheet());

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if ($('add-menu').classList.contains('open')) { closeAddMenu(); $('add-button').focus(); }
        else if (openSheetId) closeSheet();
    });

    document.querySelectorAll('.sheet').forEach(enableSheetDrag);

    $('auth-form').addEventListener('submit', handleAuthSubmit);
    $('form-add-car').addEventListener('submit', handleAddCar);
    $('form-add-expense').addEventListener('submit', handleAddExpense);
    $('form-record-sale').addEventListener('submit', handleRecordSale);
    $('form-acquisition').addEventListener('submit', handleSaveAcquisition);
    $('form-acq-won').addEventListener('submit', handleMarkAcquisitionWon);

    $('form-acquisition').addEventListener('input', updateAcquisitionCalculator);
    $('sale-price').addEventListener('input', updateSalePreview);
    $('inventory-search').addEventListener('input', renderInventory);
    document.querySelectorAll('[data-filter]').forEach(el => {
        el.addEventListener('input', renderInventory);
        el.addEventListener('change', renderInventory);
    });
    $('expense-category-filter').addEventListener('change', renderExpenses);

    initSegment($('inventory-segment'), ui.inventoryStatus, value => { ui.inventoryStatus = value; renderInventory(); });
    initSegment($('expense-segment'), ui.expenseType, value => { ui.expenseType = value; renderExpenses(); });
    initSegment($('sourcing-segment'), ui.sourcingStage, value => { ui.sourcingStage = value; renderSourcing(); });
    initSegment($('expense-type-segment'), 'VEHICLE', value => setExpenseType(value));

    initCombos();
    watchLargeTitles();
}

// Initialize on page load
window.addEventListener('load', () => { initApp(); });
