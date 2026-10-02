import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';

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

function pill(text, tone) {
    const tones = {
        blue: 'bg-blue-600/15 text-blue-400',
        green: 'bg-emerald-500/15 text-emerald-400',
        orange: 'bg-amber-500/15 text-amber-400',
        red: 'bg-rose-500/15 text-rose-400',
        gray: 'bg-slate-700/60 text-slate-300'
    };
    return `<span class="inline-flex items-center whitespace-nowrap ${tones[tone] || tones.gray} text-xs font-semibold px-2 py-0.5 rounded-full">${esc(text)}</span>`;
}

function getAgingBadge(car) {
    const days = getDaysOnMarket(car);
    if (car.status === 'SOLD') return pill(`${days} days`, 'gray');
    if (days <= 14) return pill(`${days} days`, 'green');
    if (days <= 30) return pill(`${days} days`, 'gray');
    if (days <= 60) return pill(`${days} days`, 'orange');
    return pill(`${days} days`, 'red');
}

function getStatusBadge(status) {
    switch (status) {
        case 'FOR_SALE': return pill('For sale', 'blue');
        case 'IN_PREP': return pill('In prep', 'orange');
        case 'PENDING': return pill('Pending', 'gray');
        case 'SOLD': return pill('Sold', 'green');
        default: return pill(status || 'Unknown', 'gray');
    }
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

function setSyncStatus(state, detail = '') {
    const configs = {
        synced:   { label: detail || 'Synced', dot: 'bg-emerald-400', text: 'text-emerald-400', header: 'Synced' },
        syncing:  { label: detail || 'Syncing', dot: 'bg-blue-400 animate-pulse', text: 'text-blue-400', header: 'Syncing…' },
        pending:  { label: detail || 'Pending', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', header: 'Pending' },
        offline:  { label: detail || 'Offline', dot: 'bg-amber-400', text: 'text-amber-400', header: 'Offline' },
        error:    { label: detail || 'Sync error', dot: 'bg-rose-400', text: 'text-rose-400', header: 'Sync error' },
        signedout:{ label: 'Signed out', dot: 'bg-slate-500', text: 'text-slate-400', header: 'Signed out' }
    };
    const cfg = configs[state] || configs.error;

    const sidebar = document.getElementById('sync-status');
    if (sidebar) {
        sidebar.className = `${cfg.text} flex items-center gap-1`;
        sidebar.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${cfg.dot}"></span> ${esc(cfg.label)}`;
    }
    const header = document.getElementById('sync-status-header');
    if (header) {
        header.textContent = cfg.header;
        header.className = `hidden sm:inline-flex text-xs px-2.5 py-1 rounded-full bg-slate-800 ${cfg.text} whitespace-nowrap`;
    }
    const mobile = document.getElementById('mobile-sync-status');
    if (mobile) {
        mobile.textContent = cfg.label;
        mobile.className = `text-[15px] ${cfg.text} truncate`;
    }
    const dot = document.getElementById('account-sync-dot');
    if (dot) dot.className = `absolute top-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-black ${cfg.dot}`;
}

function refreshSyncStatusFromQueue() {
    const ops = getPendingOps();
    const failed = ops.filter(op => (op.attempts || 0) >= MAX_SYNC_ATTEMPTS).length;
    if (failed) setSyncStatus('error', `${failed} not saved · tap Refresh`);
    else if (ops.length) setSyncStatus('pending', `${ops.length} pending`);
    else setSyncStatus('synced', `Synced ${new Date().toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' })}`);
}

function updateUserUI() {
    const email = currentUser?.email || 'Not signed in';
    const el = document.getElementById('signed-in-user');
    if (el) el.textContent = email;
    const mobile = document.getElementById('mobile-signed-in-user');
    if (mobile) mobile.textContent = email;
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
    const countEl = document.getElementById('storage-count');
    if (countEl) countEl.textContent = `${cars.length} ${cars.length === 1 ? 'vehicle' : 'vehicles'}`;
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
        if (successMessage) showToast(`${successMessage} Saved on this device; it will sync when you're back online.`);
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
        showToast(`Saved on this device, but the cloud rejected it: ${formatCloudError(err)}`, 'error');
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
            if (!silent) showToast(`Couldn't reach the cloud. Showing data saved on this device. (${err.message || err})`, 'error');
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

function showAuthOverlay() {
    document.querySelectorAll('.app-modal').forEach(m => m.classList.add('hidden'));
    closeMobileNav();
    document.getElementById('app-shell')?.setAttribute('hidden', '');
    document.getElementById('auth-overlay')?.classList.remove('hidden');
    const loginVideo = document.getElementById('automedusa-login-video');
    if (loginVideo) {
        loginVideo.muted = true;
        loginVideo.play().catch(() => {});
    }
    if (!currentUser) setSyncStatus('signedout');
    setTimeout(() => document.getElementById(authMode === 'new-password' ? 'auth-password' : 'auth-email')?.focus(), 50);
}

function hideAuthOverlay() {
    document.getElementById('auth-overlay')?.classList.add('hidden');
    document.getElementById('automedusa-login-video')?.pause();
    document.getElementById('app-shell')?.removeAttribute('hidden');
}

function setAuthMode(mode) {
    authMode = mode;
    const subtitle = document.getElementById('auth-subtitle');
    const emailRow = document.getElementById('auth-email-row');
    const passwordRow = document.getElementById('auth-password-row');
    const password = document.getElementById('auth-password');
    const toggle = document.getElementById('auth-mode-toggle');
    document.getElementById('auth-error')?.classList.add('hidden');
    document.getElementById('auth-info')?.classList.add('hidden');

    const copy = {
        'signin': { subtitle: 'Sign in to your dealership.', button: 'Sign in', toggle: 'Forgot password?' },
        'reset': { subtitle: "Enter your email and we'll send you a reset link.", button: 'Send reset link', toggle: 'Back to sign in' },
        'new-password': { subtitle: 'Choose a new password.', button: 'Save password', toggle: 'Cancel' }
    }[mode];

    subtitle.textContent = copy.subtitle;
    setAuthButton(copy.button);
    toggle.textContent = copy.toggle;
    emailRow.hidden = mode === 'new-password';
    passwordRow.hidden = mode === 'reset';
    password.autocomplete = mode === 'new-password' ? 'new-password' : 'current-password';
    password.placeholder = mode === 'new-password' ? 'New password (8+ characters)' : 'Password';
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
    const button = document.getElementById('auth-submit');
    button.disabled = busy;
    button.innerHTML = busy ? `<i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>${esc(label)}` : esc(label);
}

function showAuthMessage(kind, text) {
    const errorEl = document.getElementById('auth-error');
    const infoEl = document.getElementById('auth-info');
    errorEl.classList.toggle('hidden', kind !== 'error');
    infoEl.classList.toggle('hidden', kind !== 'info');
    (kind === 'error' ? errorEl : infoEl).textContent = text;
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    document.getElementById('auth-error').classList.add('hidden');
    document.getElementById('auth-info').classList.add('hidden');

    if (authMode === 'signin') {
        if (!email || !password) return showAuthMessage('error', 'Enter your email and password.');
        setAuthButton('Signing in…', true);
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            currentUser = data.user;
            document.getElementById('auth-password').value = '';
            await enterApp();
            showToast('Signed in.');
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
            showToast('Password updated.');
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
    // of the same GitHub Pages URL and reload only when its embedded app version changes.
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

function resetFormDates() {
    const today = localDateISO();
    ['car-purchase-date', 'car-listed-date', 'expense-date', 'sale-date', 'acq-won-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = today;
    });
}

async function initApp() {
    checkForAppUpdate();
    document.querySelectorAll('[data-debug-only]').forEach(el => { el.hidden = !DEBUG; });
    resetFormDates();
    setAuthMode('signin');
    refreshUI();

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

    if (currentUser && authMode !== 'new-password') {
        await enterApp();
    } else if (!currentUser) {
        showAuthOverlay();
    }

    let savedTab = null;
    try { savedTab = sessionStorage.getItem('automedusa_tab'); } catch { /* storage unavailable */ }
    switchTab(TAB_TITLES[savedTab] ? savedTab : 'dashboard', { focus: false });

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
// Rendering
// ---------------------------------------------------------------------------

function refreshUI() {
    renderKPIs();
    renderRecentDashboard();
    renderInventoryTable();
    renderExpensesTable();
    renderPipeline();
    renderFinancialReport();
    populateCarSelectOptions();
    renderCharts();
    saveState();
}

function renderKPIs() {
    const activeCars = cars.filter(c => c.status !== 'SOLD');
    const soldCars = cars.filter(c => c.status === 'SOLD');

    const activeVal = activeCars.reduce((sum, c) => sum + getCarCostBasis(c), 0);
    document.getElementById('kpi-inv-value').textContent = formatCurrency(activeVal);
    document.getElementById('kpi-active-count').textContent = `${activeCars.length} in stock`;

    const totalExp = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const recondTotal = expenses.filter(e => e.type === 'VEHICLE').reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const overheadTotal = expenses.filter(e => e.type === 'OVERHEAD').reduce((sum, e) => sum + Number(e.amount || 0), 0);
    document.getElementById('kpi-total-expenses').textContent = formatCurrency(totalExp);
    document.getElementById('kpi-recond-split').textContent = `${formatCurrencyCompact(recondTotal)} recon · ${formatCurrencyCompact(overheadTotal)} overhead`;

    const totalRev = soldCars.reduce((sum, c) => sum + Number(c.salePrice || 0), 0);
    document.getElementById('kpi-total-revenue').textContent = formatCurrency(totalRev);
    document.getElementById('kpi-sold-count').textContent = `${soldCars.length} sold`;

    const grossVehicleProfit = soldCars.reduce((sum, c) => sum + Number(c.salePrice || 0) - getCarCostBasis(c), 0);
    const netProfit = grossVehicleProfit - overheadTotal;
    const kpiNetEl = document.getElementById('kpi-net-profit');
    kpiNetEl.textContent = formatCurrency(netProfit);
    kpiNetEl.className = `text-[28px] leading-tight font-semibold tracking-tight mt-2 num ${netProfit < 0 ? 'text-rose-400' : 'text-emerald-400'}`;

    const soldCostBasis = soldCars.reduce((sum, car) => sum + getCarCostBasis(car), 0);
    const avgROI = soldCostBasis > 0 ? (grossVehicleProfit / soldCostBasis) * 100 : NaN;
    document.getElementById('kpi-avg-roi').textContent = soldCars.length ? `${formatPercent(avgROI)} average return` : 'No sales yet';
}

function emptyListItem(text) {
    return `<li class="py-6 text-center text-[15px] text-slate-500">${esc(text)}</li>`;
}

function renderRecentDashboard() {
    const recentList = document.getElementById('recent-cars-list');
    const recentCars = [...cars].sort(byDateDesc(c => c.purchaseDate)).slice(0, 5);
    recentList.innerHTML = recentCars.length ? recentCars.map(car => {
        const recond = getCarRecondCost(car.id);
        return `
            <li>
                <button type="button" data-action="view-car" data-id="${esc(car.id)}" class="w-full text-left py-3 flex items-center justify-between gap-3 hover:bg-slate-800/40 -mx-2 px-2 rounded-lg">
                    <span class="min-w-0">
                        <span class="block text-[15px] text-white font-medium truncate">${esc(vehicleName(car))}</span>
                        <span class="block text-[13px] text-slate-500 truncate">${esc(formatDisplayDate(car.purchaseDate) || 'No purchase date')}</span>
                    </span>
                    <span class="text-right shrink-0">
                        <span class="block text-[15px] text-white num">${formatCurrency(car.purchasePrice)}</span>
                        <span class="block text-[13px] text-slate-500 num">${recond ? `+${formatCurrency(recond)} recon` : getStatusBadge(car.status)}</span>
                    </span>
                </button>
            </li>`;
    }).join('') : emptyListItem('No cars yet. Use Add car to log your first purchase.');

    const recentExpList = document.getElementById('recent-expenses-list');
    const recentExpenses = [...expenses].reverse().sort(byDateDesc(e => e.date)).slice(0, 5);
    recentExpList.innerHTML = recentExpenses.length ? recentExpenses.map(exp => {
        const car = cars.find(c => c.id === exp.carId);
        const carLabel = car ? vehicleName(car) : 'Overhead';
        return `
            <li class="py-3 flex items-center justify-between gap-3">
                <span class="min-w-0">
                    <span class="block text-[15px] text-white font-medium truncate">${esc(exp.category)}</span>
                    <span class="block text-[13px] text-slate-500 truncate">${esc(carLabel)} · ${esc(formatDisplayDate(exp.date) || 'No date')}</span>
                </span>
                <span class="text-[15px] text-white num shrink-0">${formatCurrency(exp.amount)}</span>
            </li>`;
    }).join('') : emptyListItem('No expenses yet.');
}

const INVENTORY_FILTER_DEFAULTS = {
    'inventory-search': '',
    'filter-status': 'ALL',
    'filter-vehicle-type': 'ALL',
    'filter-age': 'ALL',
    'filter-min-price': '',
    'filter-max-price': '',
    'filter-date-from': '',
    'filter-date-to': '',
    'sort-inventory': 'newest'
};

function resetInventoryFilters() {
    Object.entries(INVENTORY_FILTER_DEFAULTS).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
    renderInventoryTable();
}

function toggleInventoryFilters() {
    const panel = document.getElementById('inventory-filter-panel');
    const toggle = document.getElementById('inventory-filter-toggle');
    if (!panel || !toggle) return;
    const open = panel.classList.toggle('max-md:hidden') === false;
    toggle.setAttribute('aria-expanded', String(open));
}

function updateFilterToggleLabel() {
    const label = document.getElementById('inventory-filter-toggle-label');
    if (!label) return;
    const active = Object.entries(INVENTORY_FILTER_DEFAULTS)
        .filter(([id]) => id !== 'inventory-search' && id !== 'sort-inventory')
        .filter(([id, value]) => (document.getElementById(id)?.value || '') !== value).length;
    label.textContent = active ? `Filters (${active})` : 'Filters';
}

function renderInventorySummary(filtered) {
    const summary = document.getElementById('inventory-summary');
    if (!summary) return;

    const active = filtered.filter(c => c.status !== 'SOLD');
    const capital = active.reduce((sum, c) => sum + getCarCostBasis(c), 0);
    const avgDays = filtered.length ? Math.round(filtered.reduce((sum, c) => sum + getDaysOnMarket(c), 0) / filtered.length) : 0;
    const aging30 = active.filter(c => getDaysOnMarket(c) > 30).length;
    const oldest = active.length ? Math.max(...active.map(getDaysOnMarket)) : 0;

    const tile = (label, value, sub, valueClass = 'text-white') => `
        <div class="glass-panel rounded-2xl p-4">
            <div class="text-[13px] font-medium text-slate-400">${label}</div>
            <div class="text-[22px] font-semibold tracking-tight ${valueClass} mt-1 num">${value}</div>
            <div class="text-[13px] text-slate-500">${sub}</div>
        </div>`;

    summary.innerHTML =
        tile('Showing', filtered.length, `${active.length} unsold`) +
        tile('Money tied up', formatCurrency(capital), 'Total cost of unsold cars') +
        tile('Average days on market', avgDays, `Oldest unsold: ${oldest} days`) +
        tile('Over 30 days', aging30, 'Unsold cars to review', aging30 ? 'text-rose-400' : 'text-emerald-400');
}

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-tbody');
    const cardList = document.getElementById('inventory-cards');

    const searchTerm = (document.getElementById('inventory-search')?.value || '').toLowerCase().trim();
    const statusFilter = document.getElementById('filter-status')?.value || 'ALL';
    const typeFilter = document.getElementById('filter-vehicle-type')?.value || 'ALL';
    const ageFilter = document.getElementById('filter-age')?.value || 'ALL';
    const minPriceRaw = document.getElementById('filter-min-price')?.value || '';
    const maxPriceRaw = document.getElementById('filter-max-price')?.value || '';
    const minPrice = minPriceRaw === '' ? null : Number(minPriceRaw);
    const maxPrice = maxPriceRaw === '' ? null : Number(maxPriceRaw);
    const dateFrom = document.getElementById('filter-date-from')?.value || '';
    const dateTo = document.getElementById('filter-date-to')?.value || '';
    const sortVal = document.getElementById('sort-inventory')?.value || 'newest';
    updateFilterToggleLabel();

    const filtered = cars.filter(c => {
        const costBasis = getCarCostBasis(c);
        const days = getDaysOnMarket(c);
        const textMatch = `${c.year} ${c.make} ${c.model} ${c.vin || ''} ${c.id} ${c.vehicleType || ''}`.toLowerCase().includes(searchTerm);
        const statusMatch = statusFilter === 'ALL' || c.status === statusFilter;
        const typeMatch = typeFilter === 'ALL' || c.vehicleType === typeFilter;
        const ageMatch = ageFilter === 'ALL' || getAgeBucket(days) === ageFilter;
        const minMatch = minPrice == null || costBasis >= minPrice;
        const maxMatch = maxPrice == null || costBasis <= maxPrice;
        const fromMatch = !dateFrom || c.purchaseDate >= dateFrom;
        const toMatch = !dateTo || c.purchaseDate <= dateTo;
        return textMatch && statusMatch && typeMatch && ageMatch && minMatch && maxMatch && fromMatch && toMatch;
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

    renderInventorySummary(filtered);

    if (filtered.length === 0) {
        const message = cars.length ? 'No cars match these filters.' : 'No cars yet. Use Add car to log your first purchase.';
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-10 text-[15px] text-slate-500">${esc(message)}</td></tr>`;
        cardList.innerHTML = `<li class="p-8 text-center text-[15px] text-slate-500">${esc(message)}</li>`;
        return;
    }

    const rows = [];
    const cardsHtml = [];
    filtered.forEach(car => {
        const id = esc(car.id);
        const recond = getCarRecondCost(car.id);
        const costBasis = getCarCostBasis(car);
        const days = getDaysOnMarket(car);
        const sold = car.status === 'SOLD';
        const grossProfit = sold && car.salePrice != null ? Number(car.salePrice) - costBasis : null;
        const attention = !sold && days > 30;
        const profitLine = grossProfit != null
            ? `<div class="text-[13px] mt-1 ${grossProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-medium num">Profit ${formatCurrency(grossProfit)}</div>` : '';

        rows.push(`
            <tr class="hover:bg-slate-800/40 transition-colors">
                <td class="py-3 px-4">
                    <div class="font-semibold text-white text-[15px]">${esc(vehicleName(car))}</div>
                    <div class="text-[13px] text-slate-500">${esc(car.vehicleType || 'Other')} · <span class="num">${Number(car.mileage || 0).toLocaleString(LOCALE)}</span> km</div>
                    ${profitLine}
                </td>
                <td class="py-3 px-4 text-[13px] text-slate-300">
                    <div>${id}</div>
                    <div class="text-xs text-slate-500 font-mono">${esc(car.vin || 'No VIN')}</div>
                </td>
                <td class="py-3 px-4 text-[13px]">
                    <div><span class="text-slate-500">Bought</span> ${esc(formatDisplayDate(car.purchaseDate) || '—')}</div>
                    <div><span class="text-slate-500">Listed</span> ${esc(formatDisplayDate(car.listedDate || car.purchaseDate) || '—')}</div>
                    <div class="text-xs text-slate-500">${esc(car.source)}</div>
                </td>
                <td class="py-3 px-4 num text-slate-200 text-[15px]">${formatCurrency(car.purchasePrice)}</td>
                <td class="py-3 px-4 num">
                    <div class="text-slate-500 text-[13px]">+${formatCurrency(recond)}</div>
                    <div class="text-white font-semibold text-[15px]">${formatCurrency(costBasis)}</div>
                </td>
                <td class="py-3 px-4 text-[13px] ${car.saleDate ? 'text-slate-200' : 'text-slate-500'}">${esc(formatDisplayDate(car.saleDate) || '—')}</td>
                <td class="py-3 px-4">
                    ${getAgingBadge(car)}
                    ${attention ? '<div class="text-xs text-rose-400 mt-1">Review price</div>' : ''}
                </td>
                <td class="py-3 px-4">${getStatusBadge(car.status)}</td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1.5">
                        <button type="button" data-action="view-car" data-id="${id}" title="Details" aria-label="Details for ${esc(vehicleName(car))}" class="h-9 w-9 inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full text-sm">
                            <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
                        </button>
                        ${!sold ? `<button type="button" data-action="sell-car" data-id="${id}" class="h-9 px-3 inline-flex items-center bg-blue-600 hover:bg-blue-500 text-white rounded-full text-[13px] font-semibold">Record sale</button>` : ''}
                        <button type="button" data-action="delete-car" data-id="${id}" title="Delete" aria-label="Delete ${esc(vehicleName(car))}" class="h-9 w-9 inline-flex items-center justify-center hover:bg-rose-500/15 text-rose-400 rounded-full text-sm">
                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </div>
                </td>
            </tr>`);

        cardsHtml.push(`
            <li class="p-4">
                <div class="flex items-start justify-between gap-3">
                    <button type="button" data-action="view-car" data-id="${id}" class="min-w-0 flex-1 text-left">
                        <span class="block text-[17px] font-semibold text-white truncate">${esc(vehicleName(car))}</span>
                        <span class="block text-[13px] text-slate-500 truncate">${esc(car.vehicleType || 'Other')} · ${Number(car.mileage || 0).toLocaleString(LOCALE)} km · ${id}</span>
                    </button>
                    ${getStatusBadge(car.status)}
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-[13px]">
                    <div><div class="text-slate-500">Total cost</div><div class="text-white font-medium num">${formatCurrency(costBasis)}</div></div>
                    <div><div class="text-slate-500">${sold ? 'Sold for' : 'Target'}</div><div class="text-white font-medium num">${sold ? formatCurrency(car.salePrice) : (car.targetPrice ? formatCurrency(car.targetPrice) : '—')}</div></div>
                    <div><div class="text-slate-500">On market</div><div class="${attention ? 'text-rose-400' : 'text-white'} font-medium num">${days} days</div></div>
                </div>
                ${profitLine}
                <div class="mt-3 flex gap-2">
                    ${!sold ? `<button type="button" data-action="sell-car" data-id="${id}" class="flex-1 h-11 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-[15px] font-semibold">Record sale</button>` : ''}
                    <button type="button" data-action="view-car" data-id="${id}" class="flex-1 h-11 rounded-full bg-slate-800 text-slate-100 text-[15px] font-medium">Details</button>
                    <button type="button" data-action="delete-car" data-id="${id}" aria-label="Delete ${esc(vehicleName(car))}" class="w-11 h-11 shrink-0 rounded-full bg-slate-800 text-rose-400"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                </div>
            </li>`);
    });
    tbody.innerHTML = rows.join('');
    cardList.innerHTML = cardsHtml.join('');
}

function renderExpensesTable() {
    const tbody = document.getElementById('expenses-tbody');
    const cardList = document.getElementById('expenses-cards');

    const typeFilter = document.getElementById('expense-type-filter')?.value || 'ALL';
    const catFilter = document.getElementById('expense-category-filter')?.value || 'ALL';

    const filtered = expenses.filter(e => {
        const typeMatch = typeFilter === 'ALL' || e.type === typeFilter;
        const catMatch = catFilter === 'ALL' || e.category === catFilter;
        return typeMatch && catMatch;
    }).reverse().sort(byDateDesc(e => e.date));

    if (filtered.length === 0) {
        const message = expenses.length ? 'No expenses match these filters.' : 'No expenses recorded yet.';
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-10 text-[15px] text-slate-500">${esc(message)}</td></tr>`;
        cardList.innerHTML = `<li class="p-8 text-center text-[15px] text-slate-500">${esc(message)}</li>`;
        return;
    }

    tbody.innerHTML = filtered.map(exp => {
        const car = cars.find(c => c.id === exp.carId);
        const carLabel = car ? `${vehicleName(car)} (${car.id})` : 'Overhead';
        return `
            <tr class="hover:bg-slate-800/40 transition-colors">
                <td class="py-3 px-4 text-[13px] text-slate-300">${esc(formatDisplayDate(exp.date) || 'No date')}</td>
                <td class="py-3 px-4">${pill(exp.category, 'gray')}</td>
                <td class="py-3 px-4 text-[13px] ${car ? 'text-slate-200' : 'text-slate-500'}">${esc(carLabel)}</td>
                <td class="py-3 px-4 text-[13px] text-slate-400">${esc(exp.notes || '—')}</td>
                <td class="py-3 px-4 num font-semibold text-white text-[15px]">${formatCurrency(exp.amount)}</td>
                <td class="py-3 px-4 text-right">
                    <button type="button" data-action="delete-expense" data-id="${esc(exp.id)}" aria-label="Delete expense" class="h-9 w-9 inline-flex items-center justify-center rounded-full text-slate-500 hover:text-rose-400 hover:bg-rose-500/15"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                </td>
            </tr>`;
    }).join('');

    cardList.innerHTML = filtered.map(exp => {
        const car = cars.find(c => c.id === exp.carId);
        const carLabel = car ? vehicleName(car) : 'Overhead';
        return `
            <li class="pl-4 pr-2 py-3 flex items-center gap-3">
                <div class="min-w-0 flex-1">
                    <div class="flex items-baseline justify-between gap-3">
                        <span class="text-[15px] text-white font-medium truncate">${esc(exp.category)}</span>
                        <span class="text-[15px] text-white num shrink-0">${formatCurrency(exp.amount)}</span>
                    </div>
                    <div class="text-[13px] text-slate-500 truncate">${esc(carLabel)} · ${esc(formatDisplayDate(exp.date) || 'No date')}${exp.notes ? ` · ${esc(exp.notes)}` : ''}</div>
                </div>
                <button type="button" data-action="delete-expense" data-id="${esc(exp.id)}" aria-label="Delete expense" class="w-11 h-11 shrink-0 rounded-full text-slate-500 hover:text-rose-400"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
            </li>`;
    }).join('');
}

function formatAcquisitionDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(LOCALE, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statCell(label, value, valueClass = 'text-white') {
    return `<div class="bg-slate-900 rounded-lg p-2"><span class="block text-slate-500">${esc(label)}</span><span class="font-semibold num ${valueClass}">${value}</span></div>`;
}

function acquisitionCard(acq, stage) {
    const id = esc(acq.id);
    const safeBid = getAcquisitionSafeBid(acq);
    const projected = getAcquisitionProjectedProfit(acq);
    const projectedClass = projected >= Number(acq.desiredProfit || 0) ? 'text-emerald-400' : projected >= 0 ? 'text-amber-400' : 'text-rose-400';
    const overSafe = Number(acq.currentBid || 0) > safeBid && safeBid > 0;
    const href = safeUrl(acq.sourceUrl);
    const sourceLink = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center min-h-[32px] text-blue-400 hover:text-blue-300 text-[13px]">Open listing <i class="fa-solid fa-arrow-up-right-from-square ml-1 text-xs" aria-hidden="true"></i></a>`
        : '';
    const editDelete = `
        <button type="button" data-action="edit-acq" data-id="${id}" aria-label="Edit" class="w-11 h-11 shrink-0 rounded-full bg-slate-900 text-slate-300 hover:text-white"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
        <button type="button" data-action="delete-acq" data-id="${id}" aria-label="Remove" class="w-11 h-11 shrink-0 rounded-full bg-slate-900 text-rose-400"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`;

    if (stage === 'TRANSIT') {
        return `
            <div class="bg-slate-800 p-3.5 rounded-xl">
                <div class="flex justify-between items-start gap-3">
                    <div class="min-w-0">
                        <div class="font-semibold text-white text-[15px] truncate">${esc(vehicleName(acq))}</div>
                        <div class="text-[13px] text-slate-500 mt-0.5 truncate">${esc(acq.source || 'Source')}${acq.vin ? ` · <span class="font-mono">${esc(acq.vin)}</span>` : ''}</div>
                    </div>
                    <span class="num font-semibold text-white text-[15px] shrink-0">${formatCurrency(acq.purchasePrice || acq.currentBid)}</span>
                </div>
                <div class="grid grid-cols-2 gap-2 mt-3 text-[13px]">
                    ${statCell('Arrives', esc(formatDisplayDate(acq.transportEta) || 'Not set'))}
                    ${statCell('Expected sale', formatCurrency(acq.expectedSalePrice))}
                </div>
                <div class="flex gap-2 mt-3">
                    <button type="button" data-action="arrived" data-id="${id}" class="flex-1 h-11 bg-blue-600 hover:bg-blue-500 text-white rounded-full px-3 text-[15px] font-semibold">Mark arrived</button>
                    ${editDelete}
                </div>
            </div>`;
    }

    return `
        <div class="bg-slate-800 p-3.5 rounded-xl ${overSafe ? 'ring-1 ring-rose-500/50' : ''}">
            <div class="flex justify-between items-start gap-3">
                <div class="min-w-0">
                    <div class="font-semibold text-white text-[15px] truncate">${esc(vehicleName(acq))}</div>
                    <div class="text-[13px] text-slate-500 mt-0.5 truncate">${esc(acq.source || 'Source')}${acq.auctionAt ? ` · ${esc(formatAcquisitionDateTime(acq.auctionAt))}` : ''}</div>
                </div>
                ${overSafe ? pill('Over safe bid', 'red') : ''}
            </div>
            <div class="grid grid-cols-2 gap-2 mt-3 text-[13px]">
                ${statCell('Current bid', formatCurrency(acq.currentBid))}
                ${statCell('Max safe bid', formatCurrency(safeBid))}
                ${statCell('Projected profit', formatCurrency(projected), projectedClass)}
                ${statCell('Your bid cap', acq.maxBid ? formatCurrency(acq.maxBid) : '—')}
            </div>
            ${sourceLink ? `<div class="mt-2">${sourceLink}</div>` : ''}
            <div class="flex gap-2 mt-3">
                <button type="button" data-action="won-acq" data-id="${id}" class="flex-1 h-11 bg-blue-600 hover:bg-blue-500 text-white rounded-full px-3 text-[15px] font-semibold">Mark won</button>
                ${editDelete}
            </div>
        </div>`;
}

function renderPipeline() {
    const pipelineAuction = document.getElementById('pipeline-auction');
    const pipelineTransit = document.getElementById('pipeline-transit');
    const pipelineArrived = document.getElementById('pipeline-arrived');
    const cloudNote = document.getElementById('acquisition-cloud-note');
    if (!pipelineAuction || !pipelineTransit || !pipelineArrived) return;

    if (cloudNote) cloudNote.classList.toggle('hidden', acquisitionsCloudReady || !currentUser);

    const watchlist = acquisitions.filter(a => a.stage !== 'TRANSIT');
    const transit = acquisitions.filter(a => a.stage === 'TRANSIT');
    const inPrep = cars.filter(c => c.status === 'IN_PREP');

    document.getElementById('count-auction').textContent = watchlist.length;
    document.getElementById('count-transit').textContent = transit.length;
    document.getElementById('count-arrived').textContent = inPrep.length;

    pipelineAuction.innerHTML = watchlist.length
        ? watchlist.map(acq => acquisitionCard(acq, 'WATCHLIST')).join('')
        : `<button type="button" data-action="add-acq" class="w-full border border-dashed border-slate-700 hover:border-blue-500/60 rounded-xl p-5 text-left transition">
                <span class="block text-[15px] font-semibold text-blue-400">Add your first car to watch</span>
                <span class="block text-[13px] text-slate-500 mt-1">Track an auction car, private listing or trade-in before you spend money.</span>
           </button>`;

    pipelineTransit.innerHTML = transit.length
        ? transit.map(acq => acquisitionCard(acq, 'TRANSIT')).join('')
        : '<p class="text-[13px] text-slate-500">Cars you win move here until they’re delivered.</p>';

    pipelineArrived.innerHTML = inPrep.length ? inPrep.map(car => `
        <div class="bg-slate-800 p-3.5 rounded-xl">
            <div class="flex justify-between items-start gap-3">
                <div class="min-w-0">
                    <span class="block font-semibold text-white text-[15px] truncate">${esc(vehicleName(car))}</span>
                    <span class="block text-[13px] text-slate-500 mt-0.5 truncate">${esc(car.notes || 'Inspection and reconditioning')}</span>
                </div>
                <span class="text-white num text-[15px] shrink-0">${formatCurrency(getCarCostBasis(car))}</span>
            </div>
            <div class="flex gap-2 mt-3">
                <button type="button" data-action="ready-car" data-id="${esc(car.id)}" class="flex-1 h-11 bg-blue-600 hover:bg-blue-500 text-white rounded-full px-3 text-[15px] font-semibold">Ready for sale</button>
                <button type="button" data-action="view-car" data-id="${esc(car.id)}" class="h-11 px-4 rounded-full bg-slate-900 text-slate-200 text-[15px]">Details</button>
            </div>
        </div>`).join('')
        : '<p class="text-[13px] text-slate-500">Delivered cars waiting for inspection or reconditioning show up here.</p>';
}

function renderFinancialReport() {
    const soldCars = cars.filter(c => c.status === 'SOLD');

    const grossSales = soldCars.reduce((sum, c) => sum + Number(c.salePrice || 0), 0);
    const cogs = soldCars.reduce((sum, c) => sum + Number(c.purchasePrice || 0), 0);
    const recondTotal = soldCars.reduce((sum, car) => sum + getCarRecondCost(car.id), 0);
    const overheadTotal = expenses.filter(e => e.type === 'OVERHEAD').reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const grossMargin = grossSales - cogs;
    const netProfit = grossMargin - recondTotal - overheadTotal;

    document.getElementById('report-gross-sales').textContent = formatCurrency(grossSales);
    document.getElementById('report-cogs').textContent = `-${formatCurrency(cogs)}`;
    document.getElementById('report-gross-margin').textContent = formatCurrency(grossMargin);
    document.getElementById('report-recond-total').textContent = `-${formatCurrency(recondTotal)}`;
    document.getElementById('report-overhead-total').textContent = `-${formatCurrency(overheadTotal)}`;
    const netEl = document.getElementById('report-net-profit');
    netEl.textContent = formatCurrency(netProfit);
    netEl.classList.toggle('text-rose-400', netProfit < 0);
    netEl.classList.toggle('text-emerald-400', netProfit >= 0);

    const tbody = document.getElementById('sold-cars-report-tbody');
    if (soldCars.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-[15px] text-slate-500">No cars sold yet.</td></tr>';
        return;
    }

    tbody.innerHTML = soldCars.map(car => {
        const recond = getCarRecondCost(car.id);
        const costBasis = getCarCostBasis(car);
        const profit = Number(car.salePrice || 0) - costBasis;
        const roi = costBasis > 0 ? (profit / costBasis) * 100 : NaN;
        const tone = v => (v >= 0 ? 'text-emerald-400' : 'text-rose-400');
        return `
            <tr>
                <td class="p-3 font-medium text-white">${esc(vehicleName(car))}</td>
                <td class="p-3 num">${formatCurrency(car.purchasePrice)}</td>
                <td class="p-3 num text-slate-400">+${formatCurrency(recond)}</td>
                <td class="p-3 num text-slate-200 font-medium">${formatCurrency(costBasis)}</td>
                <td class="p-3 num text-white font-medium">${formatCurrency(car.salePrice)}</td>
                <td class="p-3 num font-semibold ${tone(profit)}">${formatCurrency(profit)}</td>
                <td class="p-3 num font-semibold ${Number.isFinite(roi) ? tone(roi) : 'text-slate-500'}">${formatPercent(roi)}</td>
            </tr>`;
    }).join('');
}

function populateCarSelectOptions() {
    const select = document.getElementById('expense-car-id');
    if (!select) return;
    // Keep the user's choice if this re-render was triggered by a background sync.
    const previous = select.value;
    select.innerHTML = '';

    const activeCars = cars.filter(c => c.status !== 'SOLD');
    if (activeCars.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No unsold cars';
        select.appendChild(opt);
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a car…';
    select.appendChild(placeholder);

    activeCars.forEach(car => {
        const opt = document.createElement('option');
        opt.value = car.id;
        opt.textContent = `${vehicleName(car)} (${car.id})${car.vin ? ` · ${car.vin.slice(-6)}` : ''}`;
        select.appendChild(opt);
    });
    if (activeCars.some(c => c.id === previous)) select.value = previous;
}

const CHART_TEXT = '#8E8E93';
const CHART_GRID = 'rgba(84, 84, 88, 0.35)';
const CHART_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
const CATEGORY_COLORS = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF', '#FFD60A', '#5E5CE6', '#AC8E68'];

function renderCharts() {
    Chart.defaults.font.family = CHART_FONT;
    Chart.defaults.color = CHART_TEXT;

    // Monthly totals. Undated expenses (e.g. imported recon totals) can't be placed
    // on a timeline, so they're left out of this chart and called out underneath.
    const monthly = new Map();
    let undatedTotal = 0;
    const bucketFor = key => {
        if (!monthly.has(key)) monthly.set(key, { sales: 0, expenses: 0 });
        return monthly.get(key);
    };
    const monthOf = date => (/^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 7) : null);

    cars.filter(car => car.status === 'SOLD').forEach(car => {
        const key = monthOf(car.saleDate);
        if (key) bucketFor(key).sales += Number(car.salePrice || 0);
    });
    expenses.forEach(expense => {
        const key = monthOf(expense.date);
        if (key) bucketFor(key).expenses += Number(expense.amount || 0);
        else undatedTotal += Number(expense.amount || 0);
    });

    const monthKeys = [...monthly.keys()].sort();
    const monthLabels = monthKeys.map(key => new Date(`${key}-01T12:00:00`).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' }));

    const profitCanvas = document.getElementById('chart-profit');
    const profitEmpty = document.getElementById('chart-profit-empty');
    const profitNote = document.getElementById('chart-profit-note');
    if (profitNote) {
        profitNote.textContent = undatedTotal ? `${formatCurrency(undatedTotal)} of expenses have no date, so they aren't shown here.` : '';
        profitNote.classList.toggle('hidden', !undatedTotal);
    }
    if (profitCanvas) {
        const hasData = monthKeys.length > 0;
        profitCanvas.classList.toggle('hidden', !hasData);
        profitEmpty?.classList.toggle('hidden', hasData);
        if (!hasData) {
            profitChart?.destroy();
            profitChart = null;
        } else if (profitChart) {
            profitChart.data.labels = monthLabels;
            profitChart.data.datasets[0].data = monthKeys.map(key => monthly.get(key).sales);
            profitChart.data.datasets[1].data = monthKeys.map(key => monthly.get(key).expenses);
            profitChart.update('none');
        } else {
            profitChart = new Chart(profitCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: monthLabels,
                    datasets: [
                        { label: 'Sales', data: monthKeys.map(key => monthly.get(key).sales), backgroundColor: '#0A84FF', borderRadius: 6, maxBarThickness: 36 },
                        { label: 'Expenses', data: monthKeys.map(key => monthly.get(key).expenses), backgroundColor: '#FF9F0A', borderRadius: 6, maxBarThickness: 36 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { align: 'end', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', font: { size: 13 } } },
                        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { font: { size: 12 } } },
                        y: { grid: { color: CHART_GRID }, border: { display: false }, ticks: { font: { size: 12 }, callback: v => formatCurrencyCompact(v) } }
                    }
                }
            });
        }
    }

    const catMap = {};
    expenses.forEach(e => { catMap[e.category] = (catMap[e.category] || 0) + Number(e.amount || 0); });
    const categories = Object.keys(catMap).sort((a, b) => catMap[b] - catMap[a]);

    const expCanvas = document.getElementById('chart-expenses');
    const expEmpty = document.getElementById('chart-expenses-empty');
    if (expCanvas) {
        const hasData = categories.length > 0;
        expCanvas.classList.toggle('hidden', !hasData);
        expEmpty?.classList.toggle('hidden', hasData);
        if (!hasData) {
            expenseChart?.destroy();
            expenseChart = null;
        } else if (expenseChart) {
            expenseChart.data.labels = categories;
            expenseChart.data.datasets[0].data = categories.map(c => catMap[c]);
            expenseChart.data.datasets[0].backgroundColor = categories.map((_, i) => CATEGORY_COLORS[i % CATEGORY_COLORS.length]);
            expenseChart.update('none');
        } else {
            expenseChart = new Chart(expCanvas.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: categories,
                    datasets: [{
                        data: categories.map(c => catMap[c]),
                        backgroundColor: categories.map((_, i) => CATEGORY_COLORS[i % CATEGORY_COLORS.length]),
                        borderColor: '#1C1C1E',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '68%',
                    plugins: {
                        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } },
                        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatCurrency(ctx.parsed)}` } }
                    }
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function resetCarForm() {
    document.getElementById('form-add-car').reset();
    const today = localDateISO();
    document.getElementById('car-purchase-date').value = today;
    document.getElementById('car-listed-date').value = today;
}

async function handleAddCar(event) {
    event.preventDefault();

    const targetRaw = document.getElementById('car-target-price').value;
    const purchaseDate = document.getElementById('car-purchase-date').value;
    const newCar = {
        id: generateStockId(),
        year: Number(document.getElementById('car-year').value),
        make: document.getElementById('car-make').value.trim(),
        model: document.getElementById('car-model').value.trim(),
        vin: document.getElementById('car-vin').value.trim().toUpperCase(),
        mileage: Number(document.getElementById('car-mileage').value),
        purchasePrice: Number(document.getElementById('car-purchase-price').value),
        purchaseDate,
        listedDate: document.getElementById('car-listed-date').value || purchaseDate,
        vehicleType: document.getElementById('car-vehicle-type').value,
        source: document.getElementById('car-source').value,
        targetPrice: targetRaw === '' ? null : Number(targetRaw),
        status: 'IN_PREP',
        notes: document.getElementById('car-notes').value.trim(),
        salePrice: null, saleDate: null, buyer: null
    };

    cars.push(newCar);
    saveState();
    refreshUI();
    closeModal('modal-add-car');
    resetCarForm();
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(newCar) }, `Added ${vehicleName(newCar)}.`);
}

function prepareExpenseForm() {
    populateCarSelectOptions();
    toggleExpenseVehicleSelect();
    const date = document.getElementById('expense-date');
    if (date && !date.value) date.value = localDateISO();
}

function resetExpenseForm() {
    document.getElementById('form-add-expense').reset();
    document.getElementById('expense-date').value = localDateISO();
    // reset() puts the type back to "Vehicle"; show the car picker to match.
    toggleExpenseVehicleSelect();
}

async function handleAddExpense(event) {
    event.preventDefault();

    const type = document.getElementById('expense-type').value;
    const carId = type === 'VEHICLE' ? document.getElementById('expense-car-id').value : null;

    if (type === 'VEHICLE' && !carId) {
        showToast('Choose which car this expense is for.', 'error');
        document.getElementById('expense-car-id').focus();
        return;
    }

    const amount = Number(document.getElementById('expense-amount').value);
    const newExpense = {
        id: `EXP-${Date.now()}-${randomToken(5)}`,
        type,
        carId,
        category: document.getElementById('expense-category').value,
        amount,
        date: document.getElementById('expense-date').value,
        notes: document.getElementById('expense-notes').value.trim()
    };

    expenses.push(newExpense);
    saveState();
    refreshUI();
    closeModal('modal-add-expense');
    resetExpenseForm();
    await runOrQueueCloudOp({ kind: 'upsert_expense', payload: expenseToDb(newExpense) }, `Expense of ${formatCurrency(amount)} saved.`);
}

function openRecordSaleModal(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;

    document.getElementById('sale-car-id').value = car.id;
    document.getElementById('sale-vehicle-title').textContent = vehicleName(car);
    document.getElementById('sale-vehicle-cost').textContent = `Total cost: ${formatCurrency(getCarCostBasis(car))}`;
    document.getElementById('sale-price').value = car.targetPrice || '';
    document.getElementById('sale-date').value = localDateISO();
    document.getElementById('sale-buyer').value = '';

    openModal('modal-record-sale');
}

async function handleRecordSale(event) {
    event.preventDefault();

    const carId = document.getElementById('sale-car-id').value;
    const car = cars.find(c => c.id === carId);
    if (!car) return;

    car.status = 'SOLD';
    car.salePrice = Number(document.getElementById('sale-price').value);
    car.saleDate = document.getElementById('sale-date').value;
    car.buyer = document.getElementById('sale-buyer').value.trim();

    saveState();
    refreshUI();
    closeModal('modal-record-sale');
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) }, `Sold for ${formatCurrency(car.salePrice)}.`);
}

function viewCarDetail(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;

    const carExpenses = expenses.filter(e => e.carId === car.id);
    const recondTotal = getCarRecondCost(car.id);
    const costBasis = getCarCostBasis(car);

    document.getElementById('detail-title').textContent = vehicleName(car);
    document.getElementById('detail-vin').textContent = `VIN ${car.vin || 'not entered'} · Stock ${car.id}`;

    const recondRows = carExpenses.length ? carExpenses.map(e => `
        <div class="flex justify-between items-center gap-3 py-2.5 border-b border-slate-800 last:border-0 text-[13px]">
            <div class="min-w-0">
                <span class="font-medium text-slate-200">${esc(e.category)}</span>
                <span class="text-slate-500 block truncate">${esc(e.notes || formatDisplayDate(e.date) || '—')}</span>
            </div>
            <span class="num text-white font-medium shrink-0">${formatCurrency(e.amount)}</span>
        </div>`).join('')
        : '<p class="text-[13px] text-slate-500 py-2">No reconditioning costs logged for this car.</p>';

    const row = (label, value) => `<div class="flex justify-between gap-4 py-2 border-b border-slate-800 last:border-0"><span class="text-slate-400">${esc(label)}</span><span class="text-slate-100 text-right">${esc(value)}</span></div>`;

    document.getElementById('detail-content').innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-800/60 p-4 rounded-xl">
            <div><span class="text-[13px] text-slate-400 block">Purchase price</span><span class="num text-white font-semibold">${formatCurrency(car.purchasePrice)}</span></div>
            <div><span class="text-[13px] text-slate-400 block">Reconditioning</span><span class="num text-white font-semibold">+${formatCurrency(recondTotal)}</span></div>
            <div><span class="text-[13px] text-slate-400 block">Total cost</span><span class="num text-white font-semibold text-[17px]">${formatCurrency(costBasis)}</span></div>
            <div><span class="text-[13px] text-slate-400 block">Target price</span><span class="num text-blue-400 font-semibold">${car.targetPrice == null ? '—' : formatCurrency(car.targetPrice)}</span></div>
        </div>

        <div>
            <h4 class="font-semibold text-white text-[15px] mb-2 flex items-center justify-between">
                <span>Reconditioning</span>
                <span class="text-[13px] text-slate-400 num">${formatCurrency(recondTotal)}</span>
            </h4>
            <div class="bg-slate-800/60 px-3 py-1 rounded-xl">${recondRows}</div>
        </div>

        <div class="bg-slate-800/60 px-3 py-1 rounded-xl text-[13px]">
            ${car.status === 'SOLD' ? row('Sold for', formatCurrency(car.salePrice)) + row('Sold on', formatDisplayDate(car.saleDate) || '—') + row('Buyer', car.buyer || '—') : ''}
            ${row('Status', { FOR_SALE: 'For sale', IN_PREP: 'In prep', PENDING: 'Pending', SOLD: 'Sold' }[car.status] || car.status)}
            ${row('Source', car.source || '—')}
            ${row('Bought', formatDisplayDate(car.purchaseDate) || '—')}
            ${row('Listed', formatDisplayDate(car.listedDate || car.purchaseDate) || '—')}
            ${row('Days on market', String(getDaysOnMarket(car)))}
            ${row('Type', car.vehicleType || 'Other')}
            ${row('Mileage', `${Number(car.mileage || 0).toLocaleString(LOCALE)} km`)}
            ${row('Notes', car.notes || '—')}
        </div>`;
    openModal('modal-car-detail');
}

let pendingConfirmResolve = null;

// One confirmation dialog for every yes/no question in the app.
function confirmAction({
    title = 'Confirm deletion',
    message = 'Are you sure you want to delete this record?',
    confirmLabel = 'Delete',
    destructive = true
} = {}) {
    const modal = document.getElementById('delete-confirm-modal');
    const titleEl = document.getElementById('delete-confirm-title');
    const messageEl = document.getElementById('delete-confirm-message');
    const cancelBtn = document.getElementById('delete-confirm-cancel');
    const acceptBtn = document.getElementById('delete-confirm-accept');

    if (!modal || !titleEl || !messageEl || !cancelBtn || !acceptBtn) {
        return Promise.resolve(window.confirm(message));
    }

    if (pendingConfirmResolve) {
        pendingConfirmResolve(false);
        pendingConfirmResolve = null;
    }

    const returnFocus = document.activeElement;
    titleEl.textContent = title;
    messageEl.textContent = message;
    acceptBtn.textContent = confirmLabel;
    acceptBtn.classList.toggle('text-rose-400', destructive);
    acceptBtn.classList.toggle('text-blue-400', !destructive);

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    return new Promise(resolve => {
        const onKeyDown = event => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close(false);
            } else if (event.key === 'Tab') {
                event.stopPropagation();
                trapFocus(event, modal);
            }
        };
        const close = result => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            pendingConfirmResolve = null;
            cancelBtn.onclick = null;
            acceptBtn.onclick = null;
            modal.onclick = null;
            document.removeEventListener('keydown', onKeyDown, true);
            returnFocus?.focus?.();
            resolve(result);
        };
        pendingConfirmResolve = close;

        cancelBtn.onclick = () => close(false);
        acceptBtn.onclick = () => close(true);
        modal.onclick = event => { if (event.target === modal) close(false); };
        document.addEventListener('keydown', onKeyDown, true);

        setTimeout(() => cancelBtn.focus(), 0);
    });
}

async function deleteCar(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;

    const relatedExpenseIds = expenses.filter(e => e.carId === carId).map(e => e.id);
    const linkedExpenseText = relatedExpenseIds.length
        ? ` Its ${relatedExpenseIds.length} linked ${relatedExpenseIds.length === 1 ? 'expense' : 'expenses'} will be deleted too.`
        : '';

    const confirmed = await confirmAction({
        title: 'Delete this car?',
        message: `${vehicleName(car)} (${car.id}) will be permanently deleted.${linkedExpenseText} This can't be undone.`
    });
    if (!confirmed) return;

    cars = cars.filter(c => c.id !== carId);
    expenses = expenses.filter(e => e.carId !== carId);
    saveState();
    refreshUI();

    // Delete child expenses first so this also works if a foreign key is added later.
    for (const expId of relatedExpenseIds) {
        await runOrQueueCloudOp({ kind: 'delete_expense', id: expId });
    }
    await runOrQueueCloudOp({ kind: 'delete_car', id: carId }, 'Car deleted.');
}

async function deleteExpense(expId) {
    const exp = expenses.find(e => e.id === expId);
    if (!exp) return;

    const description = [exp.category, formatCurrency(exp.amount)].filter(Boolean).join(', ');
    const confirmed = await confirmAction({
        title: 'Delete this expense?',
        message: `${description} will be permanently deleted. This can't be undone.`
    });
    if (!confirmed) return;

    expenses = expenses.filter(e => e.id !== expId);
    saveState();
    refreshUI();
    await runOrQueueCloudOp({ kind: 'delete_expense', id: expId }, 'Expense deleted.');
}

function acquisitionFormNumber(id) {
    return Number(document.getElementById(id)?.value || 0);
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
    const safeEl = document.getElementById('acq-safe-bid-preview');
    const profitEl = document.getElementById('acq-profit-preview');

    if (safeEl) safeEl.textContent = formatCurrency(safe);
    if (profitEl) {
        profitEl.textContent = formatCurrency(projected);
        profitEl.className = `min-h-[42px] flex items-center rounded-xl px-3 py-2 text-sm font-semibold num bg-slate-800 ${
            projected >= Number(preview.desiredProfit || 0) ? 'text-emerald-400'
            : projected >= 0 ? 'text-amber-400'
            : 'text-rose-400'
        }`;
    }
}

function setAcquisitionModalTitle(text, icon) {
    document.getElementById('acquisition-modal-title').innerHTML = `<i class="fa-solid ${icon} text-blue-400" aria-hidden="true"></i> ${esc(text)}`;
}

function resetAcquisitionForm() {
    document.getElementById('form-acquisition')?.reset();
    document.getElementById('acq-id').value = '';
    document.getElementById('acq-desired-profit').value = '3000';
    setAcquisitionModalTitle('Add car to watch', 'fa-gavel');
    updateAcquisitionCalculator();
}

function openAcquisitionModal() {
    resetAcquisitionForm();
    openModal('modal-acquisition');
}

function toDatetimeLocal(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function editAcquisition(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;

    const set = (fieldId, value) => { document.getElementById(fieldId).value = value ?? ''; };
    set('acq-id', acq.id);
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
    setAcquisitionModalTitle('Edit watched car', 'fa-pen');

    updateAcquisitionCalculator();
    openModal('modal-acquisition');
}

async function handleSaveAcquisition(event) {
    event.preventDefault();

    const existingId = document.getElementById('acq-id').value;
    const existing = acquisitions.find(a => a.id === existingId);
    const urlRaw = document.getElementById('acq-source-url').value.trim();
    if (urlRaw && !safeUrl(urlRaw)) {
        showToast('Listing link must start with http:// or https://', 'error');
        document.getElementById('acq-source-url').focus();
        return;
    }
    const auctionRaw = document.getElementById('acq-auction-at').value;

    const acq = {
        id: existingId || `ACQ-${Date.now()}-${randomToken(4)}`,
        stage: existing?.stage || 'WATCHLIST',
        year: Number(document.getElementById('acq-year').value),
        make: document.getElementById('acq-make').value.trim(),
        model: document.getElementById('acq-model').value.trim(),
        vehicleType: document.getElementById('acq-vehicle-type').value,
        vin: document.getElementById('acq-vin').value.trim().toUpperCase(),
        mileage: acquisitionFormNumber('acq-mileage'),
        source: document.getElementById('acq-source').value,
        sourceUrl: safeUrl(urlRaw),
        auctionAt: auctionRaw ? new Date(auctionRaw).toISOString() : '',
        currentBid: acquisitionFormNumber('acq-current-bid'),
        maxBid: document.getElementById('acq-max-bid').value ? acquisitionFormNumber('acq-max-bid') : null,
        expectedSalePrice: acquisitionFormNumber('acq-expected-sale'),
        desiredProfit: acquisitionFormNumber('acq-desired-profit'),
        estimatedFees: acquisitionFormNumber('acq-est-fees'),
        estimatedTransport: acquisitionFormNumber('acq-est-transport'),
        estimatedRepairs: acquisitionFormNumber('acq-est-repairs'),
        purchasePrice: existing?.purchasePrice ?? null,
        purchaseDate: existing?.purchaseDate || '',
        transportEta: existing?.transportEta || '',
        notes: document.getElementById('acq-notes').value.trim(),
        createdAt: existing?.createdAt || new Date().toISOString()
    };

    const index = acquisitions.findIndex(a => a.id === acq.id);
    if (index >= 0) acquisitions[index] = acq;
    else acquisitions.unshift(acq);

    saveState();
    refreshUI();
    closeModal('modal-acquisition');
    await runOrQueueCloudOp({ kind: 'upsert_acquisition', payload: acquisitionToDb(acq) }, existingId ? 'Changes saved.' : 'Added to your watchlist.');
}

function openMarkWonModal(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;

    document.getElementById('acq-won-id').value = acq.id;
    document.getElementById('acq-won-vehicle').textContent = `${vehicleName(acq)} · ${acq.source}`;
    document.getElementById('acq-won-price').value = Number(acq.currentBid || acq.maxBid || 0) || '';
    document.getElementById('acq-won-date').value = localDateISO();
    document.getElementById('acq-transport-eta').value = acq.transportEta || '';
    openModal('modal-acquisition-won');
}

async function handleMarkAcquisitionWon(event) {
    event.preventDefault();
    const id = document.getElementById('acq-won-id').value;
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;

    acq.stage = 'TRANSIT';
    acq.purchasePrice = Number(document.getElementById('acq-won-price').value || 0);
    acq.currentBid = acq.purchasePrice;
    acq.purchaseDate = document.getElementById('acq-won-date').value;
    acq.transportEta = document.getElementById('acq-transport-eta').value;

    saveState();
    refreshUI();
    closeModal('modal-acquisition-won');
    await runOrQueueCloudOp({ kind: 'upsert_acquisition', payload: acquisitionToDb(acq) }, 'Won. Moved to In transport.');
}

async function markAcquisitionArrived(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;

    const ok = await confirmAction({
        title: 'Mark as arrived?',
        message: `${vehicleName(acq)} will be added to Inventory as In prep.`,
        confirmLabel: 'Add to Inventory',
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
        notes: [acq.notes, `From sourcing: ${acq.source || 'Source'}`].filter(Boolean).join(' · '),
        salePrice: null,
        saleDate: null,
        buyer: null
    });

    cars.unshift(car);
    acquisitions = acquisitions.filter(a => a.id !== id);
    saveState();
    refreshUI();

    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) });
    await runOrQueueCloudOp({ kind: 'delete_acquisition', id }, 'Added to Inventory.');
}

async function markCarReadyForSale(carId) {
    const car = cars.find(c => c.id === carId);
    if (!car) return;

    car.status = 'FOR_SALE';
    if (!car.listedDate) car.listedDate = localDateISO();

    saveState();
    refreshUI();
    await runOrQueueCloudOp({ kind: 'upsert_car', payload: carToDb(car) }, 'Marked for sale.');
}

async function deleteAcquisition(id) {
    const acq = acquisitions.find(a => a.id === id);
    if (!acq) return;

    const confirmed = await confirmAction({
        title: 'Remove from sourcing?',
        message: `${vehicleName(acq)} will be permanently removed. This can't be undone.`,
        confirmLabel: 'Remove'
    });
    if (!confirmed) return;

    acquisitions = acquisitions.filter(a => a.id !== id);
    saveState();
    refreshUI();
    await runOrQueueCloudOp({ kind: 'delete_acquisition', id }, 'Removed.');
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
    showToast('Inventory exported.');
}

// ---------------------------------------------------------------------------
// Navigation, modals, toasts
// ---------------------------------------------------------------------------

function switchTab(tabId, { focus = true } = {}) {
    if (!TAB_TITLES[tabId]) tabId = 'dashboard';
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`).classList.remove('hidden');

    document.querySelectorAll('.nav-link[data-tab], .tab-bar [data-tab]').forEach(el => {
        if (el.dataset.tab === tabId) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });

    const title = TAB_TITLES[tabId];
    document.getElementById('page-title').textContent = title;
    document.title = `${title} · AutoMedusa`;

    const main = document.getElementById('app-main');
    if (main) main.scrollTop = 0;
    if (focus) document.getElementById('page-title')?.focus?.({ preventScroll: true });

    try { sessionStorage.setItem('automedusa_tab', tabId); } catch { /* storage unavailable */ }
}

function toggleExpenseVehicleSelect() {
    const type = document.getElementById('expense-type').value;
    document.getElementById('expense-vehicle-container').classList.toggle('hidden', type === 'OVERHEAD');
}

const modalReturnFocus = new Map();

function focusableIn(container) {
    return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
}

function trapFocus(event, container) {
    const items = focusableIn(container);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    if (modalId === 'modal-add-expense') prepareExpenseForm();

    const heading = modal.querySelector('h3');
    if (heading) {
        if (!heading.id) heading.id = `${modalId}-title`;
        modal.setAttribute('aria-labelledby', heading.id);
    }
    modalReturnFocus.set(modalId, document.activeElement);
    modal.classList.remove('hidden');

    // Focus the first field so typing can start straight away (but not on touch,
    // where it would pop the keyboard over the sheet).
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const target = (!touch && modal.querySelector('form input:not([type="hidden"]), form select, form textarea')) || modal.querySelector('button');
    setTimeout(() => target?.focus(), 0);
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('hidden');
    modalReturnFocus.get(modalId)?.focus?.();
    modalReturnFocus.delete(modalId);
}

function topOpenModal() {
    return [...document.querySelectorAll('.app-modal')].reverse().find(m => !m.classList.contains('hidden')) || null;
}

function setMobileNavOpen(open) {
    const nav = document.getElementById('mobile-nav');
    const button = document.getElementById('mobile-menu-button');
    if (!nav) return;

    nav.classList.toggle('is-open', open);
    nav.setAttribute('aria-hidden', open ? 'false' : 'true');
    button?.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('mobile-menu-open', open);
    if (open) setTimeout(() => nav.querySelector('button')?.focus(), 0);
    else if (nav.contains(document.activeElement)) button?.focus();
}

function openMobileNav() { setMobileNavOpen(true); }
function closeMobileNav() { setMobileNavOpen(false); }
function toggleMobileNav() {
    const nav = document.getElementById('mobile-nav');
    if (nav) setMobileNavOpen(!nav.classList.contains('is-open'));
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const tone = type === 'error' ? 'bg-rose-600' : 'bg-slate-800';

    toast.className = `${tone} text-white text-[15px] px-4 py-3 rounded-2xl shadow-xl flex items-start gap-2 transition-all duration-300 pointer-events-auto`;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-check text-emerald-400'} mt-1`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4');
        setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 6000 : 3000);
}

// One delegated handler for every button rendered from data. IDs travel in
// data-id attributes, never inside inline JavaScript, so a value can't break out.
const ACTIONS = {
    'view-car': id => viewCarDetail(id),
    'sell-car': id => openRecordSaleModal(id),
    'delete-car': id => deleteCar(id),
    'delete-expense': id => deleteExpense(id),
    'ready-car': id => markCarReadyForSale(id),
    'add-acq': () => openAcquisitionModal(),
    'edit-acq': id => editAcquisition(id),
    'delete-acq': id => deleteAcquisition(id),
    'won-acq': id => openMarkWonModal(id),
    'arrived': id => markAcquisitionArrived(id)
};

document.addEventListener('click', event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
        switchTab(tabButton.dataset.tab);
        return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton && ACTIONS[actionButton.dataset.action]) {
        ACTIONS[actionButton.dataset.action](actionButton.dataset.id);
        return;
    }
    // Clicking the dimmed backdrop closes a modal.
    if (event.target.classList?.contains('app-modal')) closeModal(event.target.id);
    if (event.target.id === 'mobile-nav') closeMobileNav();
});

document.addEventListener('keydown', event => {
    const modal = topOpenModal();
    const sheetOpen = document.getElementById('mobile-nav')?.classList.contains('is-open');
    if (event.key === 'Escape') {
        if (modal) closeModal(modal.id);
        else if (sheetOpen) closeMobileNav();
    } else if (event.key === 'Tab') {
        if (modal) trapFocus(event, modal);
        else if (sheetOpen) trapFocus(event, document.getElementById('mobile-nav'));
    }
});

window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) closeMobileNav();
});

// Initialize on page load
window.addEventListener('load', () => { initApp(); });

// Inline onclick/onsubmit handlers in index.html call these by name.
Object.assign(window, {
    closeMobileNav,
    closeModal,
    diagnoseCloud,
    exportCarsCSV,
    handleAddCar,
    handleAddExpense,
    handleAuthSubmit,
    handleMarkAcquisitionWon,
    handleRecordSale,
    handleSaveAcquisition,
    openAcquisitionModal,
    openModal,
    refreshCloudData,
    renderExpensesTable,
    renderInventoryTable,
    resetInventoryFilters,
    signOutAutoMedusa,
    toggleAuthMode,
    toggleExpenseVehicleSelect,
    toggleInventoryFilters,
    toggleMobileNav,
    updateAcquisitionCalculator,
});
