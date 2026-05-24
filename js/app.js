/* ==========================================================================
   POS UPI PAY TERMINAL - SIMPLIFIED CORE LOGIC WITH REALTIME SYNC & LOGS
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // --- Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=14')
        .then((reg) => {
          console.log('[Service Worker] Registered successfully:', reg.scope);
          
          // Auto-detect service worker updates and trigger an instant page refresh
          reg.onupdatefound = () => {
            const installingWorker = reg.installing;
            if (installingWorker == null) return;
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed') {
                if (navigator.serviceWorker.controller) {
                  console.log('[Service Worker] New update activated! Auto-refreshing...');
                  window.location.reload();
                }
              }
            };
          };
        })
        .catch((err) => console.error('[Service Worker] Registration failed:', err));
    });

    // Ultimate robust PWA auto-refresh trigger on controller change
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      console.log('[PWA Update] New service worker took control! Auto-refreshing page...');
      window.location.reload();
    });
  }

  // --- State Variables ---
  let currentAmountStr = '0'; // Raw string entered on keypad
  let showSyncLoadingBar = false; // Flag to play the loading bar only for user-facing actions
  let activeSelectedBank = null; // Currently chosen bank for QR generation
  let activeEditBankId = null;
  let activeCardColor = 'card-color-hdfc';
  
  // --- Bill Maker State Variables ---
  let activeBillItems = [];
  let isBillModeActive = false;
  
  // Default Seed Data for Bank Accounts with dynamically assigned unique IDs to prevent DB RLS conflicts
  const DEFAULT_BANKS = [
    { id: 'bank_hdfc_' + Math.random().toString(36).substr(2, 9), name: 'HDFC Bank', upiId: 'merchant@okhdfcbank', holderName: 'POS MERCHANT', color: 'card-color-hdfc' },
    { id: 'bank_sbi_' + Math.random().toString(36).substr(2, 9), name: 'State Bank of India', upiId: 'merchant@oksbi', holderName: 'POS MERCHANT', color: 'card-color-sbi' },
    { id: 'bank_icici_' + Math.random().toString(36).substr(2, 9), name: 'ICICI Bank', upiId: 'merchant@okicici', holderName: 'POS MERCHANT', color: 'card-color-icici' }
  ];

  // Default Seed Data for Merchant Settings (Telegram is fully automated now)
  const DEFAULT_MERCHANT = {
    name: 'POS Merchant'
  };

  // Migration utility to dynamically replace static/clashing seed bank IDs with unique IDs
  function migrateSeededBankIds() {
    let migrated = false;
    const clashingIds = ['1', '2', '3', 'bank_hdfc_init', 'bank_sbi_init', 'bank_icici_init'];
    
    bankAccounts = bankAccounts.map(bank => {
      if (clashingIds.includes(bank.id)) {
        const typeMap = {
          '1': 'hdfc', 'bank_hdfc_init': 'hdfc',
          '2': 'sbi', 'bank_sbi_init': 'sbi',
          '3': 'icici', 'bank_icici_init': 'icici'
        };
        const uniqueId = `bank_${typeMap[bank.id] || 'seed'}_` + Math.random().toString(36).substr(2, 9);
        console.log(`[Migration] Replacing clashing seeded bank ID ${bank.id} with ${uniqueId}`);

        // Update any tasks in the local sync queue referencing the old clashing ID
        const queueStr = localStorage.getItem('pos_sync_queue');
        if (queueStr) {
          try {
            let queue = JSON.parse(queueStr);
            if (Array.isArray(queue)) {
              let queueChanged = false;
              queue = queue.map(task => {
                if (task.payload && task.payload.id === bank.id) {
                  task.payload.id = uniqueId;
                  queueChanged = true;
                }
                return task;
              });
              if (queueChanged) {
                localStorage.setItem('pos_sync_queue', JSON.stringify(queue));
              }
            }
          } catch (e) {
            console.error('[Migration] Sync queue mapping failed:', e);
          }
        }

        bank.id = uniqueId;
        migrated = true;
      }
      return bank;
    });

    if (migrated) {
      localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
    }
  }

  // State loaded defensively from LocalStorage to prevent syntax errors
  let bankAccounts = DEFAULT_BANKS;
  try {
    const localBanks = localStorage.getItem('pos_banks');
    if (localBanks) {
      const parsedBanks = JSON.parse(localBanks);
      if (Array.isArray(parsedBanks)) {
        bankAccounts = parsedBanks;
      }
    }
  } catch (e) {
    console.error('[LocalStorage Load] Error parsing banks:', e);
  }

  let merchantProfile = DEFAULT_MERCHANT;
  try {
    const localMerchant = localStorage.getItem('pos_merchant');
    if (localMerchant) {
      const parsedMerchant = JSON.parse(localMerchant);
      if (parsedMerchant && typeof parsedMerchant === 'object') {
        merchantProfile = parsedMerchant;
      }
    }
  } catch (e) {
    console.error('[LocalStorage Load] Error parsing merchant:', e);
  }

  let transactionHistory = [];
  try {
    const localHistory = localStorage.getItem('pos_history');
    if (localHistory) {
      const parsedHistory = JSON.parse(localHistory);
      if (Array.isArray(parsedHistory)) {
        transactionHistory = parsedHistory;
      }
    }
  } catch (e) {
    console.error('[LocalStorage Load] Error parsing history:', e);
  }

  // Supabase Hardcoded Sync Credentials & State
  const SUPABASE_URL = 'https://tcpbpvdrnaydvyxxrkwj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjcGJwdmRybmF5ZHZ5eHhya3dqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDg0NzMsImV4cCI6MjA5NTEyNDQ3M30.0pRHjD0j2cE8ZAW2LiS6Eh_O1MtWMuBGUqLnIYwtNs4';
  let supabase = null;
  let userSession = null;
  let bankRealtimeChannel = null;
  let historyRealtimeChannel = null;
  if (!localStorage.getItem('pos_banks')) localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
  if (!localStorage.getItem('pos_merchant')) localStorage.setItem('pos_merchant', JSON.stringify(merchantProfile));

  // --- DOM Elements Cache ---
  const views = {
    '#/pos': document.getElementById('view-pos'),
    '#/select-bank': document.getElementById('view-select-bank'),
    '#/qr': document.getElementById('view-qr'),
    '#/settings': document.getElementById('view-settings'),
    '#/bill': document.getElementById('view-bill')
  };

  const amountDisplay = document.getElementById('pos-amount-val');
  const keypad = document.getElementById('pos-keypad');

  // POS Header Sync Elements
  const headerSyncIndicator = document.getElementById('header-sync-indicator');
  const syncIndicatorText = document.getElementById('sync-indicator-text');
  const headerRefreshBtn = document.getElementById('header-refresh-btn');
  const loadingBar = document.getElementById('loading-bar');
  
  // Bill Maker Screen Elements
  const viewBill = document.getElementById('view-bill');
  const billCustNameInput = document.getElementById('bill-cust-name');
  const billCustPhoneInput = document.getElementById('bill-cust-phone');
  const billItemNameInput = document.getElementById('bill-item-name');
  const billItemPriceInput = document.getElementById('bill-item-price');
  const billItemQtyInput = document.getElementById('bill-item-qty');
  const billItemAddBtn = document.getElementById('bill-item-add-btn');
  const billAddItemForm = document.getElementById('bill-add-item-form');
  const billItemsBody = document.getElementById('bill-items-body');
  const billEmptyState = document.getElementById('bill-empty-state');
  const billSummaryCount = document.getElementById('bill-summary-count');
  const billSummarySubtotal = document.getElementById('bill-summary-subtotal');
  const billDiscountInput = document.getElementById('bill-discount-input');
  const billDiscountType = document.getElementById('bill-discount-type');
  const billSavingsLine = document.getElementById('bill-savings-line');
  const billSummaryTotal = document.getElementById('bill-summary-total');
  const billProceedBtn = document.getElementById('bill-proceed-btn');
  const billWhatsappBtn = document.getElementById('bill-whatsapp-btn');
  const billResetBtn = document.getElementById('bill-reset-btn');
  const headerBillBtn = document.getElementById('header-bill-btn');
  const qrWhatsappBtn = document.getElementById('qr-whatsapp-btn');
  
  // Bank Selector View Elements
  const selectBankAmountVal = document.getElementById('select-bank-amount-val');
  const selectBankListContainer = document.getElementById('select-bank-list-container');
  
  // QR View Elements
  const qrCanvas = document.getElementById('qr-canvas');
  const qrDisplayAmt = document.getElementById('qr-display-amt');
  const qrDisplayPayeeBank = document.getElementById('qr-display-payee-bank');
  const qrDisplayPayeeId = document.getElementById('qr-display-payee-id');
  const qrConfirmPaidBtn = document.getElementById('qr-confirm-paid-btn');

  // Settings View Forms
  const merchantNameInput = document.getElementById('settings-merchant-name');
  const saveMerchantBtn = document.getElementById('save-merchant-btn');
  
  const bankNameInput = document.getElementById('settings-bank-name');
  const bankUpiInput = document.getElementById('settings-bank-upi');
  const bankHolderInput = document.getElementById('settings-bank-holder');
  const colorOptions = document.querySelectorAll('.color-option');
  const saveBankBtn = document.getElementById('save-bank-btn');
  const cancelBankBtn = document.getElementById('cancel-bank-btn');
  const savedBanksListContainer = document.getElementById('saved-banks-list-container');

  // Cloud Database Sync Login Inputs
  const authEmailInput = document.getElementById('settings-auth-email');
  const authPasswordInput = document.getElementById('settings-auth-password');
  const authLoginBtn = document.getElementById('auth-login-btn');
  const authSignupBtn = document.getElementById('auth-signup-btn');
  const authLogoutBtn = document.getElementById('auth-logout-btn');
  const authStatusContainer = document.getElementById('auth-status-container');
  const authFormLoggedOut = document.getElementById('auth-form-logged-out');
  const authFormLoggedIn = document.getElementById('auth-form-logged-in');
  const loggedInEmailDisplay = document.getElementById('logged-in-email-display');


  
  // Reporting Dashboard Elements
  const filterFy = document.getElementById('filter-fy');
  const filterMonth = document.getElementById('filter-month');
  const statsDailyVal = document.getElementById('stats-daily-val');
  const statsMonthlyVal = document.getElementById('stats-monthly-val');
  const statsMonthlyLabel = document.getElementById('stats-monthly-label');
  const statsTotalVal = document.getElementById('stats-total-val');
  const statsCountVal = document.getElementById('stats-count-val');
  const historyListContainer = document.getElementById('history-list-container');
  const deleteFilteredBtn = document.getElementById('delete-filtered-btn');
  const clearAllHistoryBtn = document.getElementById('clear-all-history-btn');
  
  let currentQr = null; // QRious QR code instance

  // ==========================================================================
  // HASH-BASED ROUTER
  // ==========================================================================
  function router() {
    // Dismiss mobile keyboard on any routing change
    if (document.activeElement) document.activeElement.blur();
    
    let hash = window.location.hash || '#/pos';
    
    // Validate hash, fallback if invalid
    if (!views[hash]) {
      hash = '#/pos';
      window.location.hash = '#/pos';
      return;
    }

    // State routing guards
    const currentAmt = parseFloat(currentAmountStr);
    
    if (hash === '#/select-bank' && (isNaN(currentAmt) || currentAmt <= 0)) {
      alert('Please enter a valid amount greater than ₹0.00 first.');
      window.location.hash = '#/pos';
      return;
    }
    
    if (hash === '#/qr' && (!activeSelectedBank || isNaN(currentAmt) || currentAmt <= 0)) {
      window.location.hash = '#/select-bank';
      return;
    }

    // Switch view visibility
    Object.keys(views).forEach(key => {
      if (key === hash) {
        views[key].classList.add('active');
      } else {
        views[key].classList.remove('active');
      }
    });

    // Run view initialization
    if (hash === '#/pos') {
      // If we came back to pos, let's reset bill mode and amount if it was a bill
      if (isBillModeActive) {
        isBillModeActive = false;
        currentAmountStr = '0';
      }
      updateAmountDisplay();
    } else if (hash === '#/select-bank') {
      initBankSelectorView();
    } else if (hash === '#/qr') {
      initQRView();
    } else if (hash === '#/settings') {
      initSettingsView();
    } else if (hash === '#/bill') {
      initBillView();
    }
    
    // Auto-scroll to top when screen switches
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', router);

  // ==========================================================================
  // SYNC STATUS UI MANAGER
  // ==========================================================================
  function updateSyncStatusUI(status) {
    if (!headerSyncIndicator || !syncIndicatorText || !authStatusContainer) return;

    if (status === 'online') {
      headerSyncIndicator.className = 'sync-indicator-header sync-indicator-online';
      headerSyncIndicator.style.backgroundColor = '';
      headerSyncIndicator.style.color = '';
      headerSyncIndicator.style.borderColor = '';
      syncIndicatorText.innerText = 'Cloud Synced';
      const dot = headerSyncIndicator.querySelector('.sync-dot');
      if (dot) dot.classList.add('sync-dot-active');
      
      authStatusContainer.innerText = '🔒 Synced & Logged In (Realtime Active)';
      authStatusContainer.style.background = 'rgba(16, 185, 129, 0.1)';
      authStatusContainer.style.color = 'var(--color-emerald)';
      authStatusContainer.style.borderColor = 'rgba(16, 185, 129, 0.2)';
    } else if (status === 'syncing') {
      headerSyncIndicator.className = 'sync-indicator-header sync-indicator-offline';
      headerSyncIndicator.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
      headerSyncIndicator.style.color = '#f59e0b';
      headerSyncIndicator.style.borderColor = 'rgba(245, 158, 11, 0.2)';
      syncIndicatorText.innerText = 'Syncing...';
      const dot = headerSyncIndicator.querySelector('.sync-dot');
      if (dot) dot.classList.add('sync-dot-active');
      
      authStatusContainer.innerText = '🔄 Syncing Queue Transactions...';
      authStatusContainer.style.background = 'rgba(245, 158, 11, 0.1)';
      authStatusContainer.style.color = '#f59e0b';
      authStatusContainer.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    } else if (status === 'connecting') {
      headerSyncIndicator.className = 'sync-indicator-header sync-indicator-offline';
      headerSyncIndicator.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
      headerSyncIndicator.style.color = '#f59e0b';
      headerSyncIndicator.style.borderColor = 'rgba(245, 158, 11, 0.2)';
      syncIndicatorText.innerText = 'Pending Sync';
      const dot = headerSyncIndicator.querySelector('.sync-dot');
      if (dot) dot.classList.add('sync-dot-active');
      
      authStatusContainer.innerText = '🔄 Connection Idle. Waiting to sync queue...';
      authStatusContainer.style.background = 'rgba(245, 158, 11, 0.1)';
      authStatusContainer.style.color = '#f59e0b';
      authStatusContainer.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    } else {
      headerSyncIndicator.className = 'sync-indicator-header sync-indicator-offline';
      headerSyncIndicator.style.backgroundColor = '';
      headerSyncIndicator.style.color = '';
      headerSyncIndicator.style.borderColor = '';
      syncIndicatorText.innerText = 'Local Only';
      const dot = headerSyncIndicator.querySelector('.sync-dot');
      if (dot) dot.classList.remove('sync-dot-active');
      
      authStatusContainer.innerText = 'Offline Mode (Saving on device only)';
      authStatusContainer.style.background = '';
      authStatusContainer.style.color = '';
      authStatusContainer.style.borderColor = '';
    }
  }

  // ==========================================================================
  // SUPABASE REALTIME CLOUD SYNC ENGINE WITH OFFLINE QUEUE
  // ==========================================================================
  function initSupabase() {
    if (supabase) return true; // Already initialized!

    if (SUPABASE_URL && SUPABASE_KEY && window.supabase) {
      try {
        updateSyncStatusUI('connecting');
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        // Listen to Auth State Changes
        supabase.auth.onAuthStateChange(async (event, session) => {
          userSession = session;
          if (session && session.user) {
            console.log('[Supabase Auth] User signed in:', session.user.email);
            if (loggedInEmailDisplay) loggedInEmailDisplay.value = session.user.email;
            if (authFormLoggedOut) authFormLoggedOut.style.display = 'none';
            if (authFormLoggedIn) authFormLoggedIn.style.display = 'block';
            updateSyncStatusUI('online');
            
            // Sync database files with localStorage on first login
            showSyncLoadingBar = true;
            await pullCloudDatabase();
            syncPreExistingLocalData(); // Upload pre-existing local banks/transactions
            subscribeRealtimeSync();
            processSyncQueue();
          } else {
            console.log('[Supabase Auth] User signed out');
            if (authFormLoggedOut) authFormLoggedOut.style.display = 'block';
            if (authFormLoggedIn) authFormLoggedIn.style.display = 'none';
            if (loggedInEmailDisplay) loggedInEmailDisplay.value = '';
            
            // Centralized Clean Slate Reset on Sign Out
            localStorage.removeItem('pos_initial_sync_done');
            localStorage.removeItem('pos_sync_queue');
            
            // Reset to default seed banks & clear history from LocalStorage
            localStorage.setItem('pos_banks', JSON.stringify(DEFAULT_BANKS));
            localStorage.setItem('pos_history', JSON.stringify([]));
            
            // Reset local memory state variables
            bankAccounts = DEFAULT_BANKS;
            transactionHistory = [];
            
            // Re-render UI views immediately
            renderSavedBanksList();
            renderSalesLogs();
            resetBankForm();
            
            updateSyncStatusUI('offline');
            unsubscribeRealtimeSync();
          }
        });
        return true;
      } catch (e) {
        console.error('[Supabase Init] Error:', e);
      }
    }
    supabase = null;
    updateSyncStatusUI('offline');
    return false;
  }

  async function pullCloudDatabase() {
    if (!supabase || !userSession) return;
    
    // Show loading bar during cloud pull
    if (showSyncLoadingBar && loadingBar) loadingBar.classList.add('active');
    
    try {
      // 1. Pull Banks
      const { data: cloudBanks, error: banksError } = await withTimeout(supabase
        .from('pos_banks')
        .select('*'), 6000);
        
      if (!banksError && cloudBanks) {
        if (cloudBanks.length > 0) {
          // Format cloud columns to JS state variables
          bankAccounts = cloudBanks.map(b => ({
            id: b.id,
            name: b.name,
            upiId: b.upi_id,
            holderName: b.holder_name,
            color: b.color
          }));
          localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
          renderSavedBanksList();
          renderBankSwiper();
        }
      } else {
        console.error('[Supabase Pull] Banks error:', banksError);
      }

      // 2. Pull History Logs
      const { data: cloudHistory, error: historyError } = await withTimeout(supabase
        .from('pos_history')
        .select('*')
        .order('timestamp', { ascending: false }), 6000);
        
      if (!historyError && cloudHistory) {
        if (cloudHistory.length > 0) {
          transactionHistory = cloudHistory.map(h => ({
            id: h.id,
            amount: parseFloat(h.amount),
            bankName: h.bank_name,
            upiId: h.upi_id,
            note: h.note,
            status: h.status,
            timestamp: h.timestamp
          }));
          localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
          renderSalesLogs();
        }
      } else {
        console.error('[Supabase Pull] History error:', historyError);
      }
    } catch (e) {
      console.error('[Supabase Pull] Sync failed:', e);
    } finally {
      // Hide loading bar after pull completes
      if (loadingBar) loadingBar.classList.remove('active');
    }
  }

  // Upload all pre-existing local data to Supabase upon first login
  function syncPreExistingLocalData() {
    if (!supabase || !userSession) return;

    // Check if initial sync has already been processed for this login session
    if (localStorage.getItem('pos_initial_sync_done') === 'true') {
      console.log('[Supabase Sync] Initial sync already processed. Skipping redundant uploads.');
      return;
    }
    
    console.log('[Supabase Sync] Enqueuing pre-existing local data for sync...');
    
    // 1. Enqueue all local banks
    bankAccounts.forEach(bank => {
      const queue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
      if (!queue.some(t => t.table === 'pos_banks' && t.payload.id === bank.id)) {
        enqueueSyncTask('pos_banks', 'upsert', bank);
      }
    });

    // 2. Enqueue all local transactions
    transactionHistory.forEach(tx => {
      const queue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
      if (!queue.some(t => t.table === 'pos_history' && t.payload.id === tx.id)) {
        enqueueSyncTask('pos_history', 'upsert', tx);
      }
    });

    // Mark initial sync as completed successfully so it never loops
    localStorage.setItem('pos_initial_sync_done', 'true');
  }

  function subscribeRealtimeSync() {
    if (!supabase || !userSession) return;
    
    unsubscribeRealtimeSync();

    console.log('[Supabase Realtime] Subscribing to database updates...');
    
    bankRealtimeChannel = supabase
      .channel('public:pos_banks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_banks' }, async (payload) => {
        console.log('[Supabase Realtime] Bank change received:', payload);
        
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const cloudBank = payload.new;
          const localBankIndex = bankAccounts.findIndex(b => b.id === cloudBank.id);
          const formattedBank = {
            id: cloudBank.id,
            name: cloudBank.name,
            upiId: cloudBank.upi_id,
            holderName: cloudBank.holder_name,
            color: cloudBank.color
          };

          if (localBankIndex >= 0) {
            bankAccounts[localBankIndex] = formattedBank;
          } else {
            bankAccounts.push(formattedBank);
          }
        } else if (payload.eventType === 'DELETE') {
          bankAccounts = bankAccounts.filter(b => b.id !== payload.old.id);
        }
        
        localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
        renderSavedBanksList();
        renderBankSwiper();
      })
      .subscribe();

    historyRealtimeChannel = supabase
      .channel('public:pos_history')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_history' }, async (payload) => {
        console.log('[Supabase Realtime] Sales log change received:', payload);
        
        if (payload.eventType === 'INSERT') {
          const cloudTx = payload.new;
          if (!transactionHistory.some(t => t.id === cloudTx.id)) {
            transactionHistory.unshift({
              id: cloudTx.id,
              amount: parseFloat(cloudTx.amount),
              bankName: cloudTx.bank_name,
              upiId: cloudTx.upi_id,
              note: cloudTx.note,
              status: cloudTx.status,
              timestamp: cloudTx.timestamp
            });
            localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
            renderSalesLogs();
          }
        } else if (payload.eventType === 'DELETE') {
          transactionHistory = transactionHistory.filter(t => t.id !== payload.old.id);
          localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
          renderSalesLogs();
        }
      })
      .subscribe();
  }

  function unsubscribeRealtimeSync() {
    if (supabase) {
      if (bankRealtimeChannel) supabase.removeChannel(bankRealtimeChannel);
      if (historyRealtimeChannel) supabase.removeChannel(historyRealtimeChannel);
    }
    bankRealtimeChannel = null;
    historyRealtimeChannel = null;
  }

  // ==========================================================================
  // OFFLINE SYNC QUEUE MANAGEMENT
  // ==========================================================================
  function enqueueSyncTask(table, action, payload) {
    const queue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
    const taskId = 'sq_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    
    // Add task to local queue
    queue.push({ id: taskId, table, action, payload });
    localStorage.setItem('pos_sync_queue', JSON.stringify(queue));
    
    // Play loading bar for user-initiated write changes
    showSyncLoadingBar = true;
    
    // Attempt processing
    processSyncQueue();
  }

  // Helper to wrap promises in a standard timeout to prevent infinite hangs in locked web sandboxes
  function withTimeout(promise, timeoutMs = 6000) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Request Timeout'));
      }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
  }

  let isProcessingQueue = false;
  async function processSyncQueue() {
    if (isProcessingQueue) return;
    if (!supabase || !userSession) {
      updateSyncStatusUI('offline');
      return;
    }
    if (!navigator.onLine) {
      updateSyncStatusUI('offline');
      return;
    }

    const queue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
    if (queue.length === 0) {
      updateSyncStatusUI('online');
      return;
    }

    isProcessingQueue = true;
    updateSyncStatusUI('syncing');
    if (showSyncLoadingBar && loadingBar) loadingBar.classList.add('active');

    console.log(`[Sync Queue] Processing ${queue.length} pending task(s)...`);

    try {
      while (queue.length > 0) {
        const task = queue[0];
        try {
          let success = false;
          
          if (task.table === 'pos_banks') {
            if (task.action === 'delete') {
              const { error } = await withTimeout(supabase
                .from('pos_banks')
                .delete()
                .eq('id', task.payload.id), 6000);
              if (!error) success = true;
              else console.error('[Sync Queue] Bank delete error:', error);
            } else {
              const { error } = await withTimeout(supabase
                .from('pos_banks')
                .upsert({
                  id: task.payload.id,
                  name: task.payload.name,
                  upi_id: task.payload.upiId,
                  holder_name: task.payload.holderName,
                  color: task.payload.color,
                  user_id: userSession.user.id
                }), 6000);
              if (!error) success = true;
              else console.error('[Sync Queue] Bank upsert error:', error);
            }
          } else if (task.table === 'pos_history') {
            if (task.action === 'delete') {
              const { error } = await withTimeout(supabase
                .from('pos_history')
                .delete()
                .eq('id', task.payload.id), 6000);
              if (!error) success = true;
              else console.error('[Sync Queue] Transaction delete error:', error);
            } else {
              const { error } = await withTimeout(supabase
                .from('pos_history')
                .upsert({
                  id: task.payload.id,
                  amount: task.payload.amount,
                  bank_name: task.payload.bankName,
                  upi_id: task.payload.upiId,
                  note: task.payload.note,
                  status: task.payload.status,
                  timestamp: task.payload.timestamp,
                  user_id: userSession.user.id
                }), 6000);
              if (!error) success = true;
              else console.error('[Sync Queue] Transaction upsert error:', error);
            }
          }

          if (success) {
            queue.shift(); // Remove completed task
            localStorage.setItem('pos_sync_queue', JSON.stringify(queue));
          } else {
            console.warn('[Sync Queue] Task failed to write, pausing queue retry.');
            break;
          }
        } catch (e) {
          console.warn('[Sync Queue] Network drop during sync processing:', e);
          break;
        }
      }
    } finally {
      isProcessingQueue = false;
      if (loadingBar) loadingBar.classList.remove('active');
      showSyncLoadingBar = false; // Reset flag after sync queue processing completes
      
      const finalQueue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
      if (finalQueue.length === 0) {
        updateSyncStatusUI('online');
      } else {
        updateSyncStatusUI('connecting');
      }
    }
  }
  
















  // ==========================================================================
  // NAVIGATION CONTROLLER
  // ==========================================================================
  function switchScreen(screenKey) {
    // Set active screens
    Object.keys(views).forEach(key => {
      if (key === screenKey) {
        views[key].classList.add('active');
      } else {
        views[key].classList.remove('active');
      }
    });

    // Run screen-specific render initialization
    if (screenKey === '#/pos') {
      // If we came back to pos, let's reset bill mode and amount if it was a bill
      if (isBillModeActive) {
        isBillModeActive = false;
        currentAmountStr = '0';
      }
      renderBankSwiper();
    } else if (screenKey === '#/settings') {
      loadSettingsForms();
    } else if (screenKey === '#/select-bank') {
      initBankSelectorView();
    } else if (screenKey === '#/qr') {
      initQRView();
    } else if (screenKey === '#/bill') {
      initBillView();
    }
  }

  // ==========================================================================
  // POS SCREEN KEYPAD & DISPLAY LOGIC (DIRECT CALCULATOR STYLE)
  // ==========================================================================
  function updateAmountDisplay() {
    if (currentAmountStr === '') {
      currentAmountStr = '0';
    }

    // Format display output: split integer and decimals to format integer with thousands comma separator
    let parts = currentAmountStr.split('.');
    let integerPart = parts[0];
    let decimalPart = parts.length > 1 ? parts[1] : null;

    let formattedInteger = integerPart;
    if (integerPart !== '' && !isNaN(integerPart)) {
      formattedInteger = Number(integerPart).toLocaleString('en-IN');
    }

    let displayText = formattedInteger;
    if (decimalPart !== null) {
      displayText += '.' + decimalPart;
    }

    amountDisplay.innerText = displayText;
  }

  // Keypad processing (Direct price entry)
  keypad.addEventListener('click', (e) => {
    const btn = e.target.closest('.keypad-btn');
    if (!btn) return;
    
    const value = btn.dataset.val;

    // Vibrate device on tap (haptic feel)
    if ('vibrate' in navigator) {
      navigator.vibrate(15);
    }

    if (value === 'decimal') {
      if (!currentAmountStr.includes('.')) {
        currentAmountStr += '.';
      }
    } else if (value === 'backspace') {
      if (currentAmountStr.length > 1) {
        currentAmountStr = currentAmountStr.slice(0, -1);
      } else {
        currentAmountStr = '0';
      }
    } else {
      // Input numeric digit
      if (currentAmountStr === '0') {
        currentAmountStr = value;
      } else {
        // Enforce maximum 2 decimal places
        if (currentAmountStr.includes('.')) {
          let decimalPart = currentAmountStr.split('.')[1];
          if (decimalPart && decimalPart.length >= 2) {
            return;
          }
        }
        
        // Max limit of 8 characters for sanity
        if (currentAmountStr.replace('.', '').length < 8) {
          currentAmountStr += value;
        }
      }
    }

    updateAmountDisplay();
  });

  // Proceed button click
  document.getElementById('pos-proceed-btn').addEventListener('click', () => {
    const amt = parseFloat(currentAmountStr);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid amount greater than ₹0.00');
      return;
    }
    
    if (bankAccounts.length === 0) {
      alert('Please configure at least one bank account in the Settings.');
      window.location.hash = '#/settings';
      return;
    }

    window.location.hash = '#/select-bank';
  });

  // ==========================================================================
  // BANK SELECTOR SCREEN LOGIC
  // ==========================================================================
  function initBankSelectorView() {
    const amt = parseFloat(currentAmountStr);
    
    // Display summary banner
    selectBankAmountVal.innerText = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2
    }).format(amt);

    // Populate vertical bank list
    selectBankListContainer.innerHTML = '';
    
    if (bankAccounts.length === 0) {
      selectBankListContainer.innerHTML = `
        <div class="no-banks-configured">
          No bank accounts configured yet.<br>
          <a href="#/settings" style="color: var(--color-emerald); font-weight:600; text-decoration:none; display:inline-block; margin-top:8px;">Configure Banks in Settings</a>
        </div>
      `;
      return;
    }

    bankAccounts.forEach(bank => {
      const row = document.createElement('div');
      row.className = `bank-option-row ${bank.color}`;
      row.innerHTML = `
        <div class="bank-option-details">
          <div class="bank-option-name">${bank.name}</div>
          <div class="bank-option-upi">${bank.upiId}</div>
        </div>
        <div class="bank-option-arrow">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      `;
      
      row.addEventListener('click', () => {
        activeSelectedBank = bank;
        window.location.hash = '#/qr'; // Progress to QR display view
      });

      selectBankListContainer.appendChild(row);
    });
  }

  // Dummy swiper renderer function for backward compatibility
  function renderBankSwiper() {}

  // ==========================================================================
  // NPCI UPI QR SCREEN LOGIC (P2P COMPLIANT STRING BUILDER)
  // ==========================================================================
  function initQRView() {
    if (!activeSelectedBank) {
      window.location.hash = '#/select-bank';
      return;
    }

    const amount = parseFloat(currentAmountStr);
    
    // Display textual labels
    qrDisplayAmt.innerText = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
    
    qrDisplayPayeeBank.innerText = activeSelectedBank.name;
    qrDisplayPayeeId.innerText = activeSelectedBank.upiId;

    // --- Standard NPCI-Compliant P2P UPI deep link ---
    let payeeNameEncoded = encodeURIComponent(merchantProfile.name);
    let npciUpiUrl = `upi://pay?pa=${activeSelectedBank.upiId}&pn=${payeeNameEncoded}&am=${amount.toFixed(2)}&cu=INR`;
    
    console.log('[POS] NPCI Compliant UPI Deep Link:', npciUpiUrl);

    // Instanciate or Update QRious
    if (currentQr === null) {
      currentQr = new QRious({
        element: qrCanvas,
        size: 240,
        background: '#ffffff',
        foreground: '#0f172a',
        level: 'M',
        value: npciUpiUrl
      });
    } else {
      currentQr.value = npciUpiUrl;
    }

    // Toggle WhatsApp Invoice button on QR screen based on Bill Mode
    if (qrWhatsappBtn) {
      if (isBillModeActive) {
        qrWhatsappBtn.style.display = 'flex';
      } else {
        qrWhatsappBtn.style.display = 'none';
      }
    }

    // Trigger save on manual confirmation click
    qrConfirmPaidBtn.onclick = () => {
      let transactionNote = 'POS' + Math.floor(Math.random() * 1000000);
      if (isBillModeActive) {
        const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
        const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
        const itemsSummary = activeBillItems.map(item => `${item.name} x${item.qty}`).join(', ');
        transactionNote = `[Bill] Cust: ${custName} | Ph: ${custPhone} | Items: ${itemsSummary}`;
      }
      
      addTransaction(amount, activeSelectedBank, transactionNote, 'paid');
      
      // Reset values & redirect
      if (isBillModeActive) {
        clearActiveBill();
        isBillModeActive = false;
      }
      currentAmountStr = '0';
      activeSelectedBank = null;
      window.location.hash = '#/settings'; // Go to sales log inside settings
    };
  }

  function addTransaction(amount, bank, note, status) {
    const tx = {
      id: 'tx_' + Date.now(),
      amount: amount,
      bankName: bank.name,
      upiId: bank.upiId,
      note: note,
      status: status,
      timestamp: new Date().toISOString()
    };

    transactionHistory.unshift(tx);
    localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
    
    // Add to Sync Queue
    enqueueSyncTask('pos_history', 'upsert', tx);
  }

  // ==========================================================================
  // BILL MAKER SCREEN CONTROLLER
  // ==========================================================================
  
  function initBillView() {
    // Blur to hide keyboard initially on enter
    if (document.activeElement) document.activeElement.blur();
    
    renderBillItems();
    
    // Auto-focus on Name input with small delay for transition
    setTimeout(() => {
      if (billItemNameInput) billItemNameInput.focus();
    }, 250);
  }
  
  function calculateBillTotals() {
    let subtotal = 0;
    let itemCount = 0;
    
    activeBillItems.forEach(item => {
      subtotal += item.price * item.qty;
      itemCount += item.qty;
    });
    
    const discInputVal = parseFloat(billDiscountInput.value) || 0;
    const discType = billDiscountType.value;
    let savings = 0;
    
    if (discType === 'percent') {
      savings = subtotal * (discInputVal / 100);
    } else {
      savings = discInputVal;
    }
    
    // Cap savings at subtotal
    if (savings > subtotal) savings = subtotal;
    if (savings < 0) savings = 0;
    
    const grandTotal = subtotal - savings;
    
    // Update DOM
    if (billSummaryCount) billSummaryCount.innerText = itemCount;
    if (billSummarySubtotal) billSummarySubtotal.innerText = '₹' + subtotal.toFixed(2);
    
    if (billSavingsLine) {
      if (savings > 0) {
        billSavingsLine.style.display = 'block';
        billSavingsLine.innerText = 'You save: ₹' + savings.toFixed(2);
      } else {
        billSavingsLine.style.display = 'none';
      }
    }
    
    if (billSummaryTotal) billSummaryTotal.innerText = '₹' + grandTotal.toFixed(2);
    
    return {
      subtotal,
      itemCount,
      savings,
      grandTotal
    };
  }
  
  function renderBillItems() {
    if (!billItemsBody || !billEmptyState) return;
    
    billItemsBody.innerHTML = '';
    
    if (activeBillItems.length === 0) {
      billEmptyState.style.display = 'block';
      calculateBillTotals();
      return;
    }
    
    billEmptyState.style.display = 'none';
    
    activeBillItems.forEach((item, index) => {
      const amount = item.price * item.qty;
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      
      row.innerHTML = `
        <td style="padding: 8px 4px; font-weight: 500; text-align: left;">${item.name}</td>
        <td style="padding: 8px 4px; text-align: center; color: var(--text-secondary);">₹${item.price.toFixed(2)}</td>
        <td style="padding: 8px 4px; text-align: center; color: var(--text-secondary); font-weight: 600;">${item.qty}</td>
        <td style="padding: 8px 4px; text-align: right; font-weight: 700;">₹${amount.toFixed(2)}</td>
        <td style="padding: 8px 4px; text-align: center;">
          <button class="bill-item-del-btn" data-index="${index}" title="Remove Item">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </td>
      `;
      
      // Bind delete button
      row.querySelector('.bill-item-del-btn').addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-index'));
        activeBillItems.splice(idx, 1);
        renderBillItems();
      });
      
      billItemsBody.appendChild(row);
    });
    
    calculateBillTotals();
  }
  
  function addBillItem() {
    const name = billItemNameInput.value.trim();
    const price = parseFloat(billItemPriceInput.value);
    const qty = parseInt(billItemQtyInput.value) || 1;
    
    if (!name) {
      alert('Please enter a valid item name.');
      billItemNameInput.focus();
      return;
    }
    if (isNaN(price) || price <= 0) {
      alert('Please enter a valid price greater than 0.');
      billItemPriceInput.focus();
      return;
    }
    if (qty < 1) {
      alert('Quantity must be 1 or more.');
      billItemQtyInput.focus();
      return;
    }
    
    // Add to active items
    activeBillItems.push({
      id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name,
      price,
      qty
    });
    
    // Clear inputs and refocus
    billItemNameInput.value = '';
    billItemPriceInput.value = '';
    billItemQtyInput.value = '1';
    
    renderBillItems();
    
    // Focus back on Name input for high speed sequential typing
    billItemNameInput.focus();
  }
  
  function clearActiveBill() {
    activeBillItems = [];
    if (billCustNameInput) billCustNameInput.value = '';
    if (billCustPhoneInput) billCustPhoneInput.value = '';
    if (billItemNameInput) billItemNameInput.value = '';
    if (billItemPriceInput) billItemPriceInput.value = '';
    if (billItemQtyInput) billItemQtyInput.value = '1';
    if (billDiscountInput) billDiscountInput.value = '0';
    if (billDiscountType) billDiscountType.value = 'percent';
    
    renderBillItems();
  }
  
  // Format WhatsApp invoice string
  function generateWhatsAppInvoiceText(bank) {
    if (!bank) return '';
    
    const totals = calculateBillTotals();
    const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
    const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
    const shopName = merchantProfile.name || 'Huzaifa Traders';
    
    // Date formatting (DD/MM/YYYY, HH:MM AM/PM)
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    let msg = `Hi ${custName !== '-' ? custName : 'Customer'},\n`;
    msg += `Thank you for visiting *${shopName}*!\n`;
    msg += `Your invoice of *₹${totals.grandTotal.toFixed(2)}* has been successfully generated.\n\n`;
    
    msg += `*${shopName.toUpperCase()}*\n`;
    msg += `Date: ${dateStr}, ${timeStr}\n`;
    msg += `-----------------------------\n`;
    msg += `*Customer:* ${custName}\n`;
    msg += `*Phone:* ${custPhone}\n`;
    msg += `-----------------------------\n\n`;
    
    msg += `*ITEMS SOLD:*\n`;
    activeBillItems.forEach(item => {
      const amt = item.price * item.qty;
      msg += `• ${item.name}\n`;
      msg += `  ${item.qty} × ₹${item.price.toFixed(2)} = *₹${amt.toFixed(2)}*\n`;
    });
    msg += `\n-----------------------------\n`;
    msg += `Subtotal (${totals.itemCount} items): ₹${totals.subtotal.toFixed(2)}\n`;
    
    const discInputVal = parseFloat(billDiscountInput.value) || 0;
    if (totals.savings > 0) {
      const discSymbol = billDiscountType.value === 'percent' ? `${discInputVal}%` : `₹${discInputVal}`;
      msg += `Discount (${discSymbol}): -₹${totals.savings.toFixed(2)}\n`;
    }
    msg += `-----------------------------\n`;
    msg += `*TOTAL TO PAY: ₹${totals.grandTotal.toFixed(2)}*\n`;
    msg += `-----------------------------\n\n`;
    
    // UPI Deep Link Generation
    const upiLink = `upi://pay?pa=${encodeURIComponent(bank.upiId)}&pn=${encodeURIComponent(shopName)}&am=${totals.grandTotal.toFixed(2)}&cu=INR`;
    
    msg += `💳 *Tap to Pay via UPI link:*\n`;
    msg += `${upiLink}\n\n`;
    msg += `Thank you for your purchase!\n`;
    msg += `Powered by POS Terminal`;
    
    return msg;
  }

  // Draw invoice on an offline canvas and share it as an image with text fallback
  function shareReceiptAsImage(bank) {
    if (activeBillItems.length === 0) return;
    
    const totals = calculateBillTotals();
    const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
    const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
    const shopName = merchantProfile.name || 'Huzaifa Traders';
    
    // Create an offline canvas and render details
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Estimate receipt height dynamically based on items count
    const headerHeight = 180;
    const itemHeight = 40;
    const footerHeight = 340;
    canvas.width = 450;
    canvas.height = headerHeight + (activeBillItems.length * itemHeight) + footerHeight;
    
    // Background (slate dark theme)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Card border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    
    // Shop header
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(shopName.toUpperCase(), canvas.width / 2, 45);
    
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px "Inter", sans-serif';
    ctx.fillText('Station Road, Malkapur | Ph: 9420562352', canvas.width / 2, 68);
    
    // Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 85);
    ctx.lineTo(canvas.width - 30, 85);
    ctx.stroke();
    
    // Date & Customer details
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px "Inter", sans-serif';
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    ctx.fillText(`Date: ${dateStr}, ${timeStr}`, 30, 110);
    ctx.fillText(`Customer: ${custName}`, 30, 130);
    ctx.fillText(`Phone: ${custPhone}`, 30, 150);
    
    // Table Headers divider
    ctx.beginPath();
    ctx.moveTo(30, 168);
    ctx.lineTo(canvas.width - 30, 168);
    ctx.stroke();
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.fillText('ITEM', 30, 185);
    ctx.textAlign = 'center';
    ctx.fillText('QTY x PRICE', canvas.width / 2 + 25, 185);
    ctx.textAlign = 'right';
    ctx.fillText('AMOUNT', canvas.width - 30, 185);
    
    ctx.beginPath();
    ctx.moveTo(30, 195);
    ctx.lineTo(canvas.width - 30, 195);
    ctx.stroke();
    
    // Print items list
    let currentY = 220;
    ctx.font = '13px "Inter", sans-serif';
    
    activeBillItems.forEach(item => {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(item.name, 30, currentY);
      
      ctx.textAlign = 'center';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${item.qty} x ₹${item.price.toFixed(2)}`, canvas.width / 2 + 25, currentY);
      
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px "Inter", sans-serif';
      ctx.fillText(`₹${(item.price * item.qty).toFixed(2)}`, canvas.width - 30, currentY);
      
      ctx.font = '13px "Inter", sans-serif';
      currentY += itemHeight;
    });
    
    // Bottom item divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.beginPath();
    ctx.moveTo(30, currentY - 12);
    ctx.lineTo(canvas.width - 30, currentY - 12);
    ctx.stroke();
    
    // Subtotal and Savings
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px "Inter", sans-serif';
    ctx.fillText(`Subtotal (${totals.itemCount} items):`, 30, currentY + 12);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`₹${totals.subtotal.toFixed(2)}`, canvas.width - 30, currentY + 12);
    
    currentY += 32;
    
    if (totals.savings > 0) {
      const discInputVal = parseFloat(billDiscountInput.value) || 0;
      const discSymbol = billDiscountType.value === 'percent' ? `${discInputVal}%` : `₹${discInputVal}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#10b981';
      ctx.fillText(`Discount (${discSymbol}):`, 30, currentY);
      ctx.textAlign = 'right';
      ctx.fillText(`-₹${totals.savings.toFixed(2)}`, canvas.width - 30, currentY);
      currentY += 24;
    }
    
    // Grand Total Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.beginPath();
    ctx.moveTo(30, currentY - 4);
    ctx.lineTo(canvas.width - 30, currentY - 4);
    ctx.stroke();
    
    // Grand Total
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px "Inter", sans-serif';
    ctx.fillText('GRAND TOTAL:', 30, currentY + 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 18px "Inter", sans-serif';
    ctx.fillText(`₹${totals.grandTotal.toFixed(2)}`, canvas.width - 30, currentY + 16);
    
    currentY += 45;
    
    // Draw UPI Pay QR Code right on the receipt image!
    const upiLink = `upi://pay?pa=${bank.upiId}&pn=${encodeURIComponent(shopName)}&am=${totals.grandTotal.toFixed(2)}&cu=INR`;
    const tempCanvas = document.createElement('canvas');
    const tempQr = new QRious({
      element: tempCanvas,
      value: upiLink,
      size: 130,
      background: '#ffffff',
      foreground: '#0f172a',
      level: 'M'
    });
    
    // Draw white QR card background
    ctx.fillStyle = '#ffffff';
    const qrSize = 130;
    const qrX = (canvas.width - qrSize) / 2;
    ctx.fillRect(qrX - 10, currentY - 10, qrSize + 20, qrSize + 20);
    
    // Draw QR canvas on receipt canvas
    ctx.drawImage(tempCanvas, qrX, currentY, qrSize, qrSize);
    
    currentY += qrSize + 30;
    
    // Footnotes
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'italic 10px "Inter", sans-serif';
    ctx.fillText('Scan this QR code with your UPI app to pay', canvas.width / 2, currentY);
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.fillText('THANK YOU FOR YOUR VISIT!', canvas.width / 2, currentY + 22);
    
    // Convert receipt canvas to Blob and dispatch Web Share / WhatsApp
    canvas.toBlob((blob) => {
      if (!blob) return;
      
      const file = new File([blob], `invoice_${custName !== '-' ? custName : 'customer'}.png`, { type: 'image/png' });
      const text = generateWhatsAppInvoiceText(bank);
      const custPhone = billCustPhoneInput.value.trim().replace(/\D/g, '');
      
      // Native File Sharing path (modern PWA / Android / iOS Standalone)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({
          title: `Receipt from ${shopName}`,
          text: text,
          files: [file]
        })
        .then(() => console.log('[Web Share] Shared receipt image successfully'))
        .catch((err) => console.error('[Web Share] Image sharing failed:', err));
      } else {
        // Text-only WhatsApp link Fallback path (Desktop or unsupporting browsers)
        let url = `https://wa.me/`;
        if (custPhone.length === 10) {
          url += `91${custPhone}`;
        }
        url += `?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
      }
    }, 'image/png');
  }

  // ==========================================================================
  // SETTINGS & LOGS VIEW LOGIC (CONSOLIDATED HUB)
  // ==========================================================================
  function loadSettingsForms() {
    // Load profile
    merchantNameInput.value = merchantProfile.name;
    
    // Clear forms & re-render lists
    resetBankForm();
    renderSavedBanksList();
    renderSalesLogs();
  }

  function initSettingsView() {
    loadSettingsForms();
  }

  // Save Merchant Profile Business Name
  saveMerchantBtn.addEventListener('click', () => {
    const name = merchantNameInput.value.trim();

    if (!name) {
      alert('Business Payee Name is required!');
      return;
    }

    merchantProfile = { name };
    localStorage.setItem('pos_merchant', JSON.stringify(merchantProfile));
    
    // Visual indicator
    saveMerchantBtn.innerText = 'Saved Successfully!';
    saveMerchantBtn.classList.remove('btn-emerald');
    saveMerchantBtn.style.backgroundColor = '#065f46';
    
    setTimeout(() => {
      saveMerchantBtn.innerText = 'Save Business Name';
      saveMerchantBtn.classList.add('btn-emerald');
      saveMerchantBtn.style.backgroundColor = '';
    }, 2000);
  });

  // Handle color option select in bank adding form
  colorOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      colorOptions.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      activeCardColor = opt.dataset.color;
    });
  });

  function resetBankForm() {
    bankNameInput.value = '';
    bankUpiInput.value = '';
    bankHolderInput.value = merchantProfile.name; // Defaults to Business name
    
    colorOptions.forEach(o => o.classList.remove('active'));
    colorOptions[0].classList.add('active');
    activeCardColor = 'card-color-hdfc';
    
    activeEditBankId = null;
    saveBankBtn.innerText = 'Save Bank Details';
    cancelBankBtn.style.display = 'none';
  }

  cancelBankBtn.addEventListener('click', resetBankForm);

  // Save/Edit bank accounts
  saveBankBtn.addEventListener('click', async () => {
    const name = bankNameInput.value.trim();
    const upiId = bankUpiInput.value.trim().toLowerCase();
    const holderName = bankHolderInput.value.trim() || merchantProfile.name;

    if (!name || !upiId) {
      alert('Bank Name and UPI ID are required!');
      return;
    }

    if (!upiId.includes('@') || upiId.startsWith('@') || upiId.endsWith('@')) {
      alert('Please enter a valid UPI ID (e.g. store@bank)');
      return;
    }

    let bankRecord = null;

    if (activeEditBankId) {
      // Edit Account details
      bankAccounts = bankAccounts.map(bank => {
        if (bank.id === activeEditBankId) {
          bankRecord = { id: activeEditBankId, name, upiId, holderName, color: activeCardColor };
          return bankRecord;
        }
        return bank;
      });
      activeEditBankId = null;
    } else {
      // Add new account
      bankRecord = {
        id: 'bank_' + Date.now(),
        name,
        upiId,
        holderName,
        color: activeCardColor
      };
      bankAccounts.push(bankRecord);
    }

    localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
    
    // Add upsert job to Sync Queue
    if (bankRecord) {
      enqueueSyncTask('pos_banks', 'upsert', bankRecord);
    }

    resetBankForm();
    renderSavedBanksList();
  });

  // Render Saved Banks list inside settings
  function renderSavedBanksList() {
    savedBanksListContainer.innerHTML = '';

    if (bankAccounts.length === 0) {
      savedBanksListContainer.innerHTML = `<div class="no-banks-prompt">No bank accounts configured yet.</div>`;
      return;
    }

    bankAccounts.forEach(bank => {
      const row = document.createElement('div');
      row.className = 'bank-item-row';
      row.innerHTML = `
        <div class="bank-item-info">
          <div class="bank-item-color-indicator ${bank.color}"></div>
          <div class="bank-item-details">
            <div class="bank-item-name">${bank.name}</div>
            <div class="bank-item-upi">${bank.upiId}</div>
          </div>
        </div>
        <div class="bank-item-actions">
          <button class="bank-item-btn bank-item-btn-edit" data-id="${bank.id}" title="Edit">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button class="bank-item-btn bank-item-btn-delete" data-id="${bank.id}" title="Delete">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      `;

      // Bind Edit triggers
      row.querySelector('.bank-item-btn-edit').addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.id;
        const bank = bankAccounts.find(b => b.id === id);
        if (bank) {
          activeEditBankId = bank.id;
          bankNameInput.value = bank.name;
          bankUpiInput.value = bank.upiId;
          bankHolderInput.value = bank.holderName;
          
          colorOptions.forEach(o => o.classList.remove('active'));
          const matchingOpt = Array.from(colorOptions).find(o => o.dataset.color === bank.color);
          if (matchingOpt) matchingOpt.classList.add('active');
          activeCardColor = bank.color;

          saveBankBtn.innerText = 'Update Bank Details';
          cancelBankBtn.style.display = 'block';
          
          bankNameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          bankNameInput.focus();
        }
      });

      // Bind delete triggers
      row.querySelector('.bank-item-btn-delete').addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        if (confirm('Are you sure you want to delete this bank account?')) {
          const deletedBank = bankAccounts.find(b => b.id === id);
          bankAccounts = bankAccounts.filter(b => b.id !== id);
          localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
          
          // Add delete job to Sync Queue
          if (deletedBank) {
            enqueueSyncTask('pos_banks', 'delete', deletedBank);
          }

          renderSavedBanksList();
        }
      });

      savedBanksListContainer.appendChild(row);
    });
  }



  // ==========================================================================
  // SALES LOG REPORTING & SELECTOR FILTERS
  // ==========================================================================
  function renderSalesLogs() {
    historyListContainer.innerHTML = '';

    const selectedFy = filterFy.value; // "all", "FY2526", "FY2627"
    const selectedMonth = filterMonth.value; // "all", "04", "05", etc.
    
    // --- Parse Date Bounds for Financial Years ---
    // Indian FY spans April 1st to March 31st of the next calendar year
    let startYear, endYear;
    if (selectedFy === 'FY2526') {
      startYear = 2025;
      endYear = 2026;
    } else if (selectedFy === 'FY2627') {
      startYear = 2026;
      endYear = 2027;
    }

    // Filter transaction list based on select dropdowns
    let filteredHistory = transactionHistory.filter(tx => {
      const txDate = new Date(tx.timestamp);
      const txYear = txDate.getFullYear();
      const txMonthStr = String(txDate.getMonth() + 1).padStart(2, '0'); // "01"-"12"
      
      // 1. Filter by Financial Year
      if (selectedFy !== 'all') {
        const txTime = txDate.getTime();
        const fyStart = new Date(startYear, 3, 1, 0, 0, 0, 0).getTime(); // April 1st (Month 3 = April in JS)
        const fyEnd = new Date(endYear, 2, 31, 23, 59, 59, 999).getTime(); // March 31st (Month 2 = March in JS)
        
        if (txTime < fyStart || txTime > fyEnd) {
          return false;
        }
      }

      // 2. Filter by Month
      if (selectedMonth !== 'all') {
        if (txMonthStr !== selectedMonth) {
          return false;
        }
      }

      return true;
    });

    // --- CALCULATE ANALYTICS ---
    // Daily Total: overall today's sales (independent of year dropdown selection, always today!)
    let dailyTotal = 0;
    let todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    transactionHistory.forEach(tx => {
      const txDate = new Date(tx.timestamp);
      if (txDate.getTime() >= todayStart.getTime() && txDate.getTime() <= todayEnd.getTime() && tx.status === 'paid') {
        dailyTotal += tx.amount;
      }
    });

    // Monthly Total: Sum of the selected month's sales in the selected FY.
    // If "All Months" is selected, defaults to the overall sum matching the active FY.
    let monthlyTotal = 0;
    filteredHistory.forEach(tx => {
      if (tx.status === 'paid') {
        monthlyTotal += tx.amount;
      }
    });

    // All Time Total: Absolute overall sum of all paid transactions ever logged!
    let allTimeTotal = 0;
    transactionHistory.forEach(tx => {
      if (tx.status === 'paid') {
        allTimeTotal += tx.amount;
      }
    });

    // Render Stats values formatted to Indian Rupee standards
    statsDailyVal.innerText = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(dailyTotal);

    statsMonthlyVal.innerText = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(monthlyTotal);

    statsTotalVal.innerText = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(allTimeTotal);

    // Update dynamic Monthly card label
    if (selectedMonth !== 'all') {
      const monthNames = {
        "04": "Apr", "05": "May", "06": "Jun", "07": "Jul", "08": "Aug", "09": "Sep",
        "10": "Oct", "11": "Nov", "12": "Dec", "01": "Jan", "02": "Feb", "03": "Mar"
      };
      statsMonthlyLabel.innerText = `${monthNames[selectedMonth]} Sales`;
    } else {
      statsMonthlyLabel.innerText = selectedFy !== 'all' ? 'FY Sales' : 'Filter Sum';
    }

    statsCountVal.innerText = filteredHistory.length;

    // Render filtered list rows
    if (filteredHistory.length === 0) {
      historyListContainer.innerHTML = `<div class="no-history-prompt">No transaction logs match active filters.</div>`;
      return;
    }

    filteredHistory.forEach(tx => {
      const item = document.createElement('div');
      item.className = 'history-item';
      
      const formattedAmt = new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2
      }).format(tx.amount);

      const txDate = new Date(tx.timestamp);
      const formattedTime = txDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' | ' + txDate.toLocaleDateString([], { month: 'short', day: 'numeric' });

      item.innerHTML = `
        <div class="history-item-left">
          <div class="history-item-bank">${tx.bankName}</div>
          <div class="history-item-time">${formattedTime}</div>
        </div>
        <div class="history-item-right" style="display: flex; align-items: center;">
          <div>
            <div class="history-item-amt">${formattedAmt}</div>
            <span class="status-badge status-badge-paid">${tx.status}</span>
          </div>
          <button class="history-item-delete" data-tx-id="${tx.id}" title="Delete this transaction">
            <svg viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      `;

      historyListContainer.appendChild(item);
    });

    // Bind individual delete buttons
    historyListContainer.querySelectorAll('.history-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txId = btn.getAttribute('data-tx-id');
        const txToDelete = transactionHistory.find(t => t.id === txId);
        if (!txToDelete) return;
        
        if (confirm(`Delete this ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(txToDelete.amount)} transaction?`)) {
          enqueueSyncTask('pos_history', 'delete', txToDelete);
          transactionHistory = transactionHistory.filter(t => t.id !== txId);
          localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
          renderSalesLogs();
        }
      });
    });
  }

  // Bind change listeners to reporting filters
  filterFy.addEventListener('change', renderSalesLogs);
  filterMonth.addEventListener('change', renderSalesLogs);

  // Delete only the currently filtered/shown transactions
  if (deleteFilteredBtn) {
    deleteFilteredBtn.addEventListener('click', () => {
      const selectedFy = filterFy.value;
      const selectedMonth = filterMonth.value;
      
      // Re-apply the same filter logic to get visible transactions
      let startYear, endYear;
      if (selectedFy === 'FY2526') { startYear = 2025; endYear = 2026; }
      else if (selectedFy === 'FY2627') { startYear = 2026; endYear = 2027; }
      
      const filteredIds = new Set();
      transactionHistory.forEach(tx => {
        const txDate = new Date(tx.timestamp);
        const txMonthStr = String(txDate.getMonth() + 1).padStart(2, '0');
        
        if (selectedFy !== 'all') {
          const txTime = txDate.getTime();
          const fyStart = new Date(startYear, 3, 1, 0, 0, 0, 0).getTime();
          const fyEnd = new Date(endYear, 2, 31, 23, 59, 59, 999).getTime();
          if (txTime < fyStart || txTime > fyEnd) return;
        }
        if (selectedMonth !== 'all' && txMonthStr !== selectedMonth) return;
        
        filteredIds.add(tx.id);
      });
      
      if (filteredIds.size === 0) return;
      
      const label = (selectedFy !== 'all' || selectedMonth !== 'all') 
        ? `Delete ${filteredIds.size} shown transaction(s) matching current filters?` 
        : `Delete all ${filteredIds.size} transaction(s)?`;
      
      if (confirm(label)) {
        transactionHistory.forEach(tx => {
          if (filteredIds.has(tx.id)) {
            enqueueSyncTask('pos_history', 'delete', tx);
          }
        });
        transactionHistory = transactionHistory.filter(tx => !filteredIds.has(tx.id));
        localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
        renderSalesLogs();
      }
    });
  }

  // Clear ALL history logs (nuclear option)
  if (clearAllHistoryBtn) {
    clearAllHistoryBtn.addEventListener('click', () => {
      if (transactionHistory.length === 0) return;
      
      if (confirm('Are you sure you want to clear ALL transaction history logs? This will delete them from the cloud database too!')) {
        transactionHistory.forEach(tx => {
          enqueueSyncTask('pos_history', 'delete', tx);
        });
        transactionHistory = [];
        localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
        renderSalesLogs();
      }
    });
  }

  // ==========================================================================
  // CLOUD DATABASE SYNC & ACCOUNT LOGIN UI HANDLERS
  // ==========================================================================
  if (authLoginBtn) {
    authLoginBtn.addEventListener('click', async () => {
      const email = authEmailInput.value.trim();
      const password = authPasswordInput.value.trim();

      if (!email || !password) {
        alert('Please fill out both Email and Password fields!');
        return;
      }
      
      // Re-init Supabase client
      const initOk = initSupabase();
      if (!initOk) {
        alert('Failed to connect to Supabase. Make sure your database project is active.');
        return;
      }

      try {
        authLoginBtn.innerText = 'Signing In...';
        authLoginBtn.disabled = true;

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        
        if (error) {
          alert('Authentication Failed: ' + error.message);
        } else {
          console.log('[Supabase Auth] Login successful:', data);
          // Process sync queue immediately
          processSyncQueue();
        }
      } catch(e) {
        alert('Error signing in: ' + e.message);
      } finally {
        authLoginBtn.innerText = 'Sign In';
        authLoginBtn.disabled = false;
      }
    });
  }

  if (authSignupBtn) {
    authSignupBtn.addEventListener('click', async () => {
      const email = authEmailInput.value.trim();
      const password = authPasswordInput.value.trim();

      if (!email || !password) {
        alert('Please fill out both Email and Password fields!');
        return;
      }

      const initOk = initSupabase();
      if (!initOk) {
        alert('Failed to connect to Supabase. Make sure your database project is active.');
        return;
      }

      try {
        authSignupBtn.innerText = 'Registering...';
        authSignupBtn.disabled = true;

        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) {
          alert('Registration Failed: ' + error.message);
        } else {
          alert('Registration Successful! If email confirmation is enabled on your Supabase project, check your inbox. Otherwise, you can sign in directly now.');
        }
      } catch(e) {
        alert('Error registering: ' + e.message);
      } finally {
        authSignupBtn.innerText = 'Register Account';
        authSignupBtn.disabled = false;
      }
    });
  }

  if (authLogoutBtn) {
    authLogoutBtn.addEventListener('click', async () => {
      if (!supabase) return;
      
      if (confirm('Are you sure you want to sign out? Your local device data cache will be cleared for privacy.')) {
        try {
          const { error } = await supabase.auth.signOut();
          if (error) console.error('[Supabase Auth] Logout error:', error);
        } catch (e) {
          console.error('[Supabase Auth] Sign out failed:', e);
        }
      }
    });
  }

  // ==========================================================================
  // INITIALIZE ON START
  // ==========================================================================
  
  // 1. Instantly display correct view to prevent page-refresh POS main-page jump!
  try {
    migrateSeededBankIds(); // Run self-healing migration to replace clashing seeded bank IDs and avoid DB RLS errors
    updateAmountDisplay();
    router();
  } catch (e) {
    console.error('[POS Initialization] Routing error:', e);
  }

  // 2. Load Supabase cloud connections in the background
  try {
    initSupabase();
  } catch (e) {
    console.error('[POS Initialization] Supabase startup failed:', e);
  }

  // --- Bill Maker Keyboard & Form Submit Binding ---
  if (billItemNameInput && billItemPriceInput && billItemQtyInput) {
    billItemNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        billItemPriceInput.focus();
      }
    });
    
    billItemPriceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        billItemQtyInput.focus();
      }
    });
    
    billItemQtyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBillItem();
      }
    });
  }

  if (billAddItemForm) {
    billAddItemForm.addEventListener('submit', (e) => {
      e.preventDefault();
      addBillItem();
    });
  }

  if (billDiscountInput) {
    billDiscountInput.addEventListener('input', () => {
      calculateBillTotals();
    });
  }
  
  if (billDiscountType) {
    billDiscountType.addEventListener('change', () => {
      calculateBillTotals();
    });
  }
  
  if (billResetBtn) {
    billResetBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear this entire bill?')) {
        clearActiveBill();
      }
    });
  }

  if (billProceedBtn) {
    billProceedBtn.onclick = () => {
      if (activeBillItems.length === 0) {
        alert('Please add at least one item to the bill first.');
        return;
      }
      const totals = calculateBillTotals();
      
      // Set payment state
      isBillModeActive = true;
      currentAmountStr = totals.grandTotal.toFixed(2);
      
      // Navigate to bank selection
      window.location.hash = '#/select-bank';
    };
  }

  if (billWhatsappBtn) {
    billWhatsappBtn.onclick = () => {
      if (activeBillItems.length === 0) {
        alert('Please add at least one item to the bill first.');
        return;
      }
      
      let bank = activeSelectedBank || bankAccounts[0];
      if (!bank) {
        alert('Please configure at least one bank account in Settings to generate the UPI link.');
        return;
      }
      
      // Share receipt image dynamically or fallback to WhatsApp text
      shareReceiptAsImage(bank);
    };
  }

  if (qrWhatsappBtn) {
    qrWhatsappBtn.onclick = () => {
      if (isBillModeActive && activeSelectedBank) {
        shareReceiptAsImage(activeSelectedBank);
      }
    };
  }

  const billBackBtn = document.getElementById('bill-back-btn');
  if (billBackBtn) {
    billBackBtn.addEventListener('click', () => {
      if (document.activeElement) document.activeElement.blur();
    });
  }

  // Refresh button — hard cache-busting reload
  if (headerRefreshBtn) {
    headerRefreshBtn.addEventListener('click', () => {
      showSyncLoadingBar = true;
      if (loadingBar) loadingBar.classList.add('active');
      // Small delay for visual feedback before reload
      setTimeout(() => {
        window.location.reload(true);
      }, 200);
    });
  }

  window.addEventListener('online', processSyncQueue); // Queue worker hook
});
