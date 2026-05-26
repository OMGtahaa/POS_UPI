/* ==========================================================================
   POS UPI PAY TERMINAL - SIMPLIFIED CORE LOGIC WITH REALTIME SYNC & LOGS
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // HTML escaping helper for XSS security
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=1.9.1')
        .then((reg) => {
          console.log('[Service Worker] Registered successfully:', reg.scope);
          
          // Force update check on load to prevent stale caching
          reg.update();
          
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

  // --- PWA Installation & Ambient Prompt Handler ---
  let deferredPrompt = null;
  const pwaInstallBanner = document.getElementById('pwa-install-banner');
  const pwaInstallBtn = document.getElementById('pwa-install-btn');
  const pwaDismissBtn = document.getElementById('pwa-dismiss-btn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!sessionStorage.getItem('pwa_install_dismissed') && pwaInstallBanner) {
      pwaInstallBanner.style.display = 'flex';
    }
  });

  if (pwaInstallBtn) {
    pwaInstallBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`[PWA Install] User outcome: ${outcome}`);
      deferredPrompt = null;
      if (pwaInstallBanner) {
        pwaInstallBanner.style.display = 'none';
      }
    });
  }

  if (pwaDismissBtn) {
    pwaDismissBtn.addEventListener('click', () => {
      sessionStorage.setItem('pwa_install_dismissed', 'true');
      if (pwaInstallBanner) {
        pwaInstallBanner.style.display = 'none';
      }
    });
  }

  window.addEventListener('appinstalled', (evt) => {
    console.log('[PWA] POS UPI Pay Terminal was successfully installed.');
    if (pwaInstallBanner) {
      pwaInstallBanner.style.display = 'none';
    }
  });

  // --- State Variables ---
  let currentAmountStr = '0'; // Raw string entered on keypad
  let showSyncLoadingBar = false; // Flag to play the loading bar only for user-facing actions
  let activeSelectedBank = null; // Currently chosen bank for QR generation
  let activeEditBankId = null;
  let activeCardColor = 'card-color-hdfc';
  
  // Custom Merchant Upgrades (v1.8.0)
  const CASH_PAYMENT = { id: 'bank_cash', name: 'Cash Payment', upiId: 'cash', holderName: 'CASH', color: 'card-color-cash' };
  let isAdminModeActive = false;
  let enteredPin = '';

  // Helper utility to safely resolve a bank by ID (including built-in Cash mode)
  function getBankById(id) {
    if (id === CASH_PAYMENT.id) return CASH_PAYMENT;
    return bankAccounts.find(b => b.id === id) || null;
  }
  
  // --- Invoice Counter State Initialization ---
  if (!localStorage.getItem('pos_invoice_counter')) {
    localStorage.setItem('pos_invoice_counter', '1');
  }
  
  // --- Bill Maker State Variables ---
  let activeBillItems = [];
  let isBillModeActive = false;
  
  // Default Seed Data for Bank Accounts with dynamically assigned unique IDs to prevent DB RLS conflicts
  const DEFAULT_BANKS = [
    { id: 'bank_hdfc_' + Math.random().toString(36).substr(2, 9), name: 'HDFC Bank', upiId: 'merchant@okhdfcbank', holderName: 'POS MERCHANT', color: 'card-color-hdfc' },
    { id: 'bank_sbi_' + Math.random().toString(36).substr(2, 9), name: 'State Bank of India', upiId: 'merchant@oksbi', holderName: 'POS MERCHANT', color: 'card-color-sbi' },
    { id: 'bank_icici_' + Math.random().toString(36).substr(2, 9), name: 'ICICI Bank', upiId: 'merchant@okicici', holderName: 'POS MERCHANT', color: 'card-color-icici' }
  ];

  // Default Seed Data for Merchant Settings
  const DEFAULT_MERCHANT = {
    name: 'Shop Name',
    address: 'Shop Address',
    phone: '0000000000'
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
    '#/bill': document.getElementById('view-bill'),
    '#/reset-password': document.getElementById('view-reset-password')
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
  const billPrintBtn = document.getElementById('bill-print-btn');
  const billResetBtn = document.getElementById('bill-reset-btn');
  const headerBillBtn = document.getElementById('header-bill-btn');
  const qrWhatsappBtn = document.getElementById('qr-whatsapp-btn');
  const qrPrintBtn = document.getElementById('qr-print-btn');
  const billBankSelect = document.getElementById('bill-bank-select');
  const billInvoiceNum = document.getElementById('bill-invoice-num');
  
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
  const merchantAddressInput = document.getElementById('settings-merchant-address');
  const merchantPhoneInput = document.getElementById('settings-merchant-phone');
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
  const filterSearchName = document.getElementById('filter-search-name');
  const statsDailyVal = document.getElementById('stats-daily-val');
  const statsMonthlyVal = document.getElementById('stats-monthly-val');
  const statsMonthlyLabel = document.getElementById('stats-monthly-label');
  const statsTotalVal = document.getElementById('stats-total-val');
  const statsCountVal = document.getElementById('stats-count-val');
  const historyListContainer = document.getElementById('history-list-container');
  const deleteFilteredBtn = document.getElementById('delete-filtered-btn');
  const clearAllHistoryBtn = document.getElementById('clear-all-history-btn');
  
  let currentQr = null; // QRious QR code instance

  // --- Hash-based Router ---
  function router() {
    // Dismiss mobile keyboard and release active input focus on routing changes
    if (document.activeElement) document.activeElement.blur();
    document.querySelectorAll('input, textarea').forEach(el => el.blur());
    
    let hash = window.location.hash || '#/pos';
    
    // Automatically intercept Supabase password recovery landing URL redirects
    if (hash.includes('type=recovery') || hash.includes('access_token=')) {
      hash = '#/reset-password';
      window.location.hash = '#/reset-password';
    }
    
    // Automatically lock admin mode when navigating away from settings
    if (hash !== '#/settings' && hash !== '#/reset-password') {
      isAdminModeActive = false;
    }
    
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
    } else if (hash === '#/reset-password') {
      initResetPasswordView();
    }
    
    // Auto-scroll to top when screen switches
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', router);

  // --- Sync Status UI ---
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

  // --- Supabase Cloud Sync ---
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

            if (loggedInEmailDisplay) loggedInEmailDisplay.value = session.user.email;
            if (authFormLoggedOut) authFormLoggedOut.style.display = 'none';
            if (authFormLoggedIn) authFormLoggedIn.style.display = 'block';
            const pwdSection = document.getElementById('settings-security-password-section');
            if (pwdSection) pwdSection.style.display = 'block';
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
            const pwdSection = document.getElementById('settings-security-password-section');
            if (pwdSection) pwdSection.style.display = 'none';
            if (loggedInEmailDisplay) loggedInEmailDisplay.value = '';
            
            // Centralized Clean Slate Reset on Sign Out
            localStorage.removeItem('pos_initial_sync_done');
            localStorage.removeItem('pos_sync_queue');
            
            // Reset to default seed banks & clear history from LocalStorage
            localStorage.setItem('pos_banks', JSON.stringify(DEFAULT_BANKS));
            localStorage.setItem('pos_history', JSON.stringify([]));
            localStorage.setItem('pos_merchant', JSON.stringify(DEFAULT_MERCHANT));
            localStorage.setItem('pos_invoice_counter', '1');
            
            // Reset local memory state variables
            bankAccounts = DEFAULT_BANKS;
            transactionHistory = [];
            merchantProfile = DEFAULT_MERCHANT;
            
            // Clear all text inputs from settings UI
            if (authEmailInput) authEmailInput.value = '';
            if (authPasswordInput) authPasswordInput.value = '';
            if (merchantNameInput) merchantNameInput.value = '';
            if (merchantAddressInput) merchantAddressInput.value = '';
            if (merchantPhoneInput) merchantPhoneInput.value = '';
            
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
          // Intercept settings metadata row
          const metaRow = cloudHistory.find(h => h.id === 'settings_meta');
          if (metaRow) {
            try {
              const meta = JSON.parse(metaRow.note);
              if (meta && meta.merchantProfile) {
                merchantProfile = meta.merchantProfile;
                localStorage.setItem('pos_merchant', JSON.stringify(merchantProfile));
                loadSettingsForms(); // Update settings input forms & view
              }
              if (meta && meta.invoice_counter !== undefined) {
                const localCounter = parseInt(localStorage.getItem('pos_invoice_counter') || '1', 10);
                const cloudCounter = parseInt(meta.invoice_counter, 10);
                const maxCounter = Math.max(localCounter, cloudCounter);
                localStorage.setItem('pos_invoice_counter', maxCounter.toString());
              }
            } catch (e) {
              console.error('[Supabase Pull] Error parsing settings metadata:', e);
            }
          } else {
            // Push current local profile and counter to cloud since cloud has none
            pushSettingsMetaToCloud();
          }

          transactionHistory = cloudHistory
            .filter(h => h.id !== 'settings_meta')
            .map(h => ({
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
        } else {
          // Cloud history is completely empty (fresh account), push local metadata row
          pushSettingsMetaToCloud();
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

      })
      .subscribe();

    historyRealtimeChannel = supabase
      .channel('public:pos_history')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_history' }, async (payload) => {

        
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const cloudTx = payload.new;
          
          // Intercept settings metadata row
          if (cloudTx.id === 'settings_meta') {
            try {
              const meta = JSON.parse(cloudTx.note);
              if (meta && meta.merchantProfile) {
                merchantProfile = meta.merchantProfile;
                localStorage.setItem('pos_merchant', JSON.stringify(merchantProfile));
                loadSettingsForms(); // Update settings input forms & view
              }
              if (meta && meta.invoice_counter !== undefined) {
                const localCounter = parseInt(localStorage.getItem('pos_invoice_counter') || '1', 10);
                const cloudCounter = parseInt(meta.invoice_counter, 10);
                const maxCounter = Math.max(localCounter, cloudCounter);
                localStorage.setItem('pos_invoice_counter', maxCounter.toString());
              }
            } catch (e) {
              console.error('[Supabase Realtime] Error parsing settings metadata:', e);
            }
            return; // Skip adding settings_meta to transactionHistory array
          }

          const localIndex = transactionHistory.findIndex(t => t.id === cloudTx.id);
          const formattedTx = {
            id: cloudTx.id,
            amount: parseFloat(cloudTx.amount),
            bankName: cloudTx.bank_name,
            upiId: cloudTx.upi_id,
            note: cloudTx.note,
            status: cloudTx.status,
            timestamp: cloudTx.timestamp
          };
          
          if (localIndex >= 0) {
            transactionHistory[localIndex] = formattedTx;
          } else {
            transactionHistory.unshift(formattedTx);
          }
          localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
          renderSalesLogs();
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

  // --- Offline Sync Queue ---
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

  function pushSettingsMetaToCloud() {
    if (!supabase || !userSession) return;
    
    const currentCounter = localStorage.getItem('pos_invoice_counter') || '1';
    const payload = {
      id: 'settings_meta',
      amount: 0,
      bankName: 'settings_meta',
      upiId: 'settings_meta',
      note: JSON.stringify({
        merchantProfile: merchantProfile,
        invoice_counter: currentCounter
      }),
      status: 'settings_meta',
      timestamp: new Date().toISOString()
    };
    
    console.log('[Supabase Sync] Syncing settings & counter to cloud...');
    enqueueSyncTask('pos_history', 'upsert', payload);
  }

  function openWhatsAppTextFallback(custPhone, text) {
    let url = `https://wa.me/`;
    const cleanPhone = custPhone.replace(/\D/g, '');
    if (cleanPhone.length === 10) {
      url += `91${cleanPhone}`;
    } else if (cleanPhone.length > 10) {
      url += cleanPhone;
    }
    url += `?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
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

  function isPersistentError(error) {
    if (!error) return false;
    
    // HTTP Status codes 400-499 indicate permission/validation/request failures that will not resolve on retry
    if (error.status && error.status >= 400 && error.status < 500) {
      return true;
    }
    
    // Postgres/PostgREST error codes (42501 RLS, 23xxx constraints, 22xxx data exceptions, Pxxxx syntax)
    if (error.code) {
      const codeStr = String(error.code);
      if (codeStr === '42501' || codeStr.startsWith('22') || codeStr.startsWith('23') || codeStr.startsWith('P0')) {
        return true;
      }
    }
    
    return false;
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

    isProcessingQueue = true;
    updateSyncStatusUI('syncing');
    if (showSyncLoadingBar && loadingBar) loadingBar.classList.add('active');

    try {
      while (true) {
        // Read the freshest queue on each iteration to prevent memory overwrite race conditions
        const freshestQueue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
        if (freshestQueue.length === 0) {
          break;
        }

        const task = freshestQueue[0];

        let success = false;
        let discardTask = false;
        
        try {
          if (task.table === 'pos_banks') {
            if (task.action === 'delete') {
              const { error } = await withTimeout(supabase
                .from('pos_banks')
                .delete()
                .eq('id', task.payload.id), 6000);
              if (!error) {
                success = true;
              } else {
                console.error('[Sync Queue] Bank delete error:', error);
                if (isPersistentError(error)) discardTask = true;
              }
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
              if (!error) {
                success = true;
              } else {
                console.error('[Sync Queue] Bank upsert error:', error);
                if (isPersistentError(error)) discardTask = true;
              }
            }
          } else if (task.table === 'pos_history') {
            if (task.action === 'delete') {
              const { error } = await withTimeout(supabase
                .from('pos_history')
                .delete()
                .eq('id', task.payload.id), 6000);
              if (!error) {
                success = true;
              } else {
                console.error('[Sync Queue] Transaction delete error:', error);
                if (isPersistentError(error)) discardTask = true;
              }
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
              if (!error) {
                success = true;
              } else {
                console.error('[Sync Queue] Transaction upsert error:', error);
                if (isPersistentError(error)) discardTask = true;
              }
            }
          }

          if (success || discardTask) {
            if (discardTask) {
              console.warn('[Sync Queue] Discarding failing task to prevent blocking sync queue:', task);
            }
            // Read, shift, and save back the freshest queue to prevent losing items enqueued during the await
            const finalQueue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
            if (finalQueue.length > 0 && finalQueue[0].id === task.id) {
              finalQueue.shift();
              localStorage.setItem('pos_sync_queue', JSON.stringify(finalQueue));
            }
          } else {
            console.warn('[Sync Queue] Task failed to write (transient error), pausing queue retry.');
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
  















  // --- POS Keypad & Display ---
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

  // Physical keyboard support for direct POS screen keypad entry
  document.addEventListener('keydown', (e) => {
    if (window.location.hash !== '#/pos') return;

    // Guard: If any modal is active, do not handle keys here
    const activeModals = document.querySelectorAll('.modal, .pin-modal, #admin-pin-modal, #pin-recovery-modal, #pin-offline-modal');
    for (const m of activeModals) {
      if (m.style.display === 'flex' || m.style.display === 'block' || m.classList.contains('active')) {
        return;
      }
    }

    // Avoid hijacking events when inputs or forms are focused
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' || 
      document.activeElement.tagName === 'TEXTAREA' || 
      document.activeElement.isContentEditable
    )) {
      return;
    }

    const key = e.key;
    let handled = false;

    if (/^[0-9]$/.test(key)) {
      handled = true;
      if ('vibrate' in navigator) {
        navigator.vibrate(15);
      }
      if (currentAmountStr === '0') {
        currentAmountStr = key;
      } else {
        if (currentAmountStr.includes('.')) {
          let decimalPart = currentAmountStr.split('.')[1];
          if (decimalPart && decimalPart.length >= 2) {
            e.preventDefault();
            return;
          }
        }
        if (currentAmountStr.replace('.', '').length < 8) {
          currentAmountStr += key;
        }
      }
    } else if (key === '.' || key === 'Decimal') {
      handled = true;
      if ('vibrate' in navigator) {
        navigator.vibrate(15);
      }
      if (!currentAmountStr.includes('.')) {
        currentAmountStr += '.';
      }
    } else if (key === 'Backspace') {
      handled = true;
      if ('vibrate' in navigator) {
        navigator.vibrate(15);
      }
      if (currentAmountStr.length > 1) {
        currentAmountStr = currentAmountStr.slice(0, -1);
      } else {
        currentAmountStr = '0';
      }
    } else if (key === 'Enter') {
      handled = true;
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
    }

    if (handled) {
      e.preventDefault();
      updateAmountDisplay();
    }
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

  // --- Bank Selector ---
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
    
    // Prepend built-in Cash Payment row
    const cashRow = document.createElement('div');
    cashRow.className = `bank-option-row ${CASH_PAYMENT.color}`;
    cashRow.innerHTML = `
      <div class="bank-option-details">
        <div class="bank-option-name">${CASH_PAYMENT.name}</div>
        <div class="bank-option-upi">${CASH_PAYMENT.upiId}</div>
      </div>
      <div class="bank-option-arrow">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    `;
    
    cashRow.addEventListener('click', () => {
      activeSelectedBank = CASH_PAYMENT;
      window.location.hash = '#/qr'; // Progress to QR display view
    });
    
    selectBankListContainer.appendChild(cashRow);
    
    if (bankAccounts.length === 0) {
      const helpDiv = document.createElement('div');
      helpDiv.className = 'no-banks-configured';
      helpDiv.style.marginTop = '15px';
      helpDiv.innerHTML = `
        No UPI bank accounts configured yet.<br>
        <a href="#/settings" style="color: var(--color-emerald); font-weight:600; text-decoration:none; display:inline-block; margin-top:8px;">Configure Banks in Settings</a>
      `;
      selectBankListContainer.appendChild(helpDiv);
    } else {
      bankAccounts.forEach(bank => {
        const row = document.createElement('div');
        row.className = `bank-option-row ${bank.color}`;
        row.innerHTML = `
          <div class="bank-option-details">
            <div class="bank-option-name">${escapeHTML(bank.name)}</div>
            <div class="bank-option-upi">${escapeHTML(bank.upiId)}</div>
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
  }



  // --- UPI QR Screen ---
  function initQRView() {
    if (!activeSelectedBank) {
      window.location.hash = '#/select-bank';
      return;
    }

    const amount = parseFloat(currentAmountStr);
    
    // Ensure amount display wrapper is visible
    const amtWrapper = document.querySelector('.modal-amt-wrapper');
    if (amtWrapper) amtWrapper.style.display = 'flex';

    // Display textual labels
    qrDisplayAmt.innerText = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
    
    // Handle Cash Payment View Mode vs UPI QR Mode
    const qrCanvasWrapper = document.getElementById('qr-canvas-wrapper');
    const qrCashDisplay = document.getElementById('qr-cash-display');
    const statusTextSpan = document.querySelector('.modal-status-bar span');
    
    if (activeSelectedBank.id === 'bank_cash') {
      if (qrCanvasWrapper) qrCanvasWrapper.style.display = 'none';
      if (qrCashDisplay) qrCashDisplay.style.display = 'flex';
      if (statusTextSpan) statusTextSpan.innerText = 'Collect cash and tap confirm below';
      
      qrDisplayPayeeBank.innerText = 'Cash Transaction';
      qrDisplayPayeeId.innerText = 'PHYSICAL CASH';
    } else {
      if (qrCanvasWrapper) qrCanvasWrapper.style.display = 'flex';
      if (qrCashDisplay) qrCashDisplay.style.display = 'none';
      if (statusTextSpan) statusTextSpan.innerText = 'Customer can scan and pay now';
      
      qrDisplayPayeeBank.innerText = activeSelectedBank.name;
      qrDisplayPayeeId.innerText = activeSelectedBank.upiId;

      // --- Standard NPCI-Compliant P2P UPI deep link ---
      let payeeNameEncoded = encodeURIComponent(merchantProfile.name);
      let npciUpiUrl = `upi://pay?pa=${activeSelectedBank.upiId}&pn=${payeeNameEncoded}&am=${amount.toFixed(2)}&cu=INR`;
      


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
    }

    // Toggle WhatsApp Invoice button on QR screen - always visible for both direct POS and Bill Mode!
    if (qrWhatsappBtn) {
      qrWhatsappBtn.style.display = 'flex';
    }
    if (qrPrintBtn) {
      qrPrintBtn.style.display = 'flex';
    }

    // Trigger save on manual confirmation click
    qrConfirmPaidBtn.onclick = () => {
      const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
      let billData;

      if (isBillModeActive) {
        const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
        const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
        const discInputVal = parseFloat(billDiscountInput.value) || 0;
        const totals = calculateBillTotals();
        
        billData = {
          type: 'bill',
          invoiceNum: currentInvoiceNum,
          custName: custName,
          custPhone: custPhone,
          items: [...activeBillItems], // Clone active items array
          discount: discInputVal,
          discountType: billDiscountType.value,
          grandTotal: totals.grandTotal,
          subtotal: totals.subtotal,
          savings: totals.savings,
          itemCount: totals.itemCount
        };
      } else {
        billData = {
          type: 'flat',
          invoiceNum: currentInvoiceNum,
          custName: '-',
          custPhone: '-',
          items: [{ name: 'TOTAL', qty: 1, price: amount }],
          discount: 0,
          discountType: 'flat',
          grandTotal: amount,
          subtotal: amount,
          savings: 0,
          itemCount: 1
        };
      }
      
      const transactionNote = JSON.stringify(billData);
      
      // Increment global invoice counter in localStorage sequentially!
      const nextInvoiceNum = parseInt(currentInvoiceNum) + 1;
      localStorage.setItem('pos_invoice_counter', nextInvoiceNum.toString());
      
      // Synchronize sequential invoice counter increments to cloud database in real-time
      pushSettingsMetaToCloud();
      
      addTransaction(amount, activeSelectedBank, transactionNote, 'paid');
      
      // Reset values & redirect
      if (isBillModeActive) {
        clearActiveBill();
        isBillModeActive = false;
      }
      currentAmountStr = '0';
      activeSelectedBank = null;
      window.location.hash = '#/pos'; // Go to main POS home keypad view
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

  // --- Bill Maker ---
  
  function initBillView() {
    // Blur to hide keyboard initially on enter
    if (document.activeElement) document.activeElement.blur();
    
    renderBillItems();
    populateBillBankSelector(); // Dynamic bank selector
    
    // Display current sequence number in the header
    const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
    if (billInvoiceNum) billInvoiceNum.innerText = '#' + currentInvoiceNum;
    
    // Auto-focus on Name input with small delay for transition
    setTimeout(() => {
      if (billItemNameInput) billItemNameInput.focus();
    }, 250);
  }

  function populateBillBankSelector() {
    if (!billBankSelect) return;
    billBankSelect.innerHTML = '';
    
    // Prepend built-in Cash Payment option
    const cashOpt = document.createElement('option');
    cashOpt.value = CASH_PAYMENT.id;
    cashOpt.innerText = '💵 Cash Payment';
    billBankSelect.appendChild(cashOpt);

    bankAccounts.forEach(bank => {
      const opt = document.createElement('option');
      opt.value = bank.id;
      opt.innerText = bank.name;
      billBankSelect.appendChild(opt);
    });
    
    // Set selection to current activeSelectedBank if set, else fallback to Cash
    if (activeSelectedBank) {
      billBankSelect.value = activeSelectedBank.id;
    } else {
      billBankSelect.value = CASH_PAYMENT.id;
      activeSelectedBank = CASH_PAYMENT;
    }
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
        <td style="padding: 8px 4px; font-weight: 500; text-align: left;">${escapeHTML(item.name)}</td>
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
    billItemQtyInput.value = '';
    
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
    if (billItemQtyInput) billItemQtyInput.value = '';
    if (billDiscountInput) billDiscountInput.value = '';
    if (billDiscountType) billDiscountType.value = 'percent';
    
    renderBillItems();
  }
  
    // Format WhatsApp invoice string
  function generateWhatsAppInvoiceText(bank, billData) {
    if (!bank || !billData) return '';
    
    const custName = billData.custName || '-';
    const shopName = merchantProfile.name || 'Shop Name';
    const invoiceNum = billData.invoiceNum || '1';
    const grandTotal = billData.grandTotal || 0;
    
    let msg = `Hi ${custName !== '-' ? custName : 'Customer'},\n\n`;
    msg += `Thank you for visiting *${shopName}*!\n`;
    msg += `Your invoice *#${invoiceNum}* of *₹${grandTotal.toFixed(2)}* has been successfully generated.\n\n`;
    
    if (bank.id !== 'bank_cash') {
      // UPI Deep Link Generation
      const upiLink = `upi://pay?pa=${encodeURIComponent(bank.upiId)}&pn=${encodeURIComponent(shopName)}&am=${grandTotal.toFixed(2)}&cu=INR`;
      msg += `💳 *Tap to Pay via UPI link:*\n${upiLink}\n\n`;
    } else {
      msg += `💵 *Payment Mode:* Physical Cash Collected\n\n`;
    }
    msg += `*(Please check the attached receipt image for full details)*`;
    
    return msg;
  }

  function triggerBrowserPrint(bank, billData, format) {
    const isAndroid = /android/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    
    // On Android, window.print() produces blank pages in WebAPK/TWA context.
    // Instead, render the receipt as a high-quality image and use the native Share sheet.
    if (isAndroid) {
      if (!isStandalone) {
        // Show install suggestion as a non-blocking toast instead of ugly alert()
        showInstallSuggestionToast();
      }
      shareReceiptAsImage(bank, billData, true, format);
      return;
    }

    // Desktop / iOS path: use window.print() with the HTML print layout
    const printLayout = document.getElementById('print-invoice-layout');
    if (!printLayout) return;
    
    const shopName = merchantProfile.name || 'Shop Name';
    const shopAddress = merchantProfile.address || 'Shop Address';
    const shopPhone = merchantProfile.phone || '0000000000';
    const invoiceNum = billData.invoiceNum || '1';
    const custName = billData.custName || '-';
    const custPhone = billData.custPhone || '-';
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    const itemsHtml = (billData.items || []).map(item => `
      <tr>
        <td style="padding: ${format === '80mm' ? '4px 0' : '10px 12px'}; text-align: left;">${escapeHTML(item.name)}</td>
        <td style="text-align: center; padding: ${format === '80mm' ? '4px 0' : '10px 12px'};">${item.qty}</td>
        <td style="text-align: center; padding: ${format === '80mm' ? '4px 0' : '10px 12px'};">₹${item.price.toFixed(2)}</td>
        <td style="text-align: right; padding: ${format === '80mm' ? '4px 0' : '10px 12px'}; font-weight: bold;">₹${(item.qty * item.price).toFixed(2)}</td>
      </tr>
    `).join('');
    
    let discountHtml = '';
    if (billData.savings > 0) {
      const discSymbol = billData.discountType === 'percent' ? `${billData.discount}%` : `₹${billData.discount}`;
      discountHtml = `
        <div class="summary-row" style="display: flex; justify-content: space-between; font-size: ${format === '80mm' ? '11px' : '13px'}; color: #333333; margin-top: 4px;">
          <span>Discount (${discSymbol}):</span>
          <span>-₹${billData.savings.toFixed(2)}</span>
        </div>
      `;
    }
    
    if (format === '80mm') {
      printLayout.className = 'receipt-80mm';
      printLayout.innerHTML = `
        <div class="receipt-header">
          <h1 class="shop-name">${escapeHTML(shopName.toUpperCase())}</h1>
          <p class="shop-meta">${escapeHTML(shopAddress)}</p>
          <p class="shop-meta">Ph: ${escapeHTML(shopPhone)}</p>
        </div>
        <div class="receipt-divider"></div>
        <div class="invoice-info">
          <strong>Invoice #:</strong> ${escapeHTML(invoiceNum)}<br>
          <strong>Date:</strong> ${dateStr}, ${timeStr}<br>
          <strong>Customer:</strong> ${escapeHTML(custName)}<br>
          <strong>Phone:</strong> ${escapeHTML(custPhone)}
        </div>
        <div class="receipt-divider"></div>
        <table class="receipt-table">
          <thead>
            <tr>
              <th style="text-align: left;">ITEM</th>
              <th style="text-align: center; width: 30px;">QTY</th>
              <th style="text-align: center; width: 50px;">PRICE</th>
              <th style="text-align: right; width: 60px;">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        <div class="receipt-divider"></div>
        <div class="receipt-summary">
          <div class="summary-row">
             <span>Subtotal (${billData.itemCount} items):</span>
             <span>₹${billData.subtotal.toFixed(2)}</span>
          </div>
          ${discountHtml}
          <div class="summary-row grand-total-row">
            <strong>GRAND TOTAL:</strong>
            <strong>₹${billData.grandTotal.toFixed(2)}</strong>
          </div>
        </div>
        
        <div class="receipt-footer-text">
          THANK YOU FOR YOUR VISIT!
        </div>
      `;
    } else {
      // A4 Document format
      printLayout.className = 'invoice-a4';
      printLayout.innerHTML = `
        <div class="header-row">
          <div class="company-section">
            <h1 class="company-name">${escapeHTML(shopName.toUpperCase())}</h1>
            <p class="company-address">${escapeHTML(shopAddress)}<br>Phone: ${escapeHTML(shopPhone)}</p>
          </div>
          <div class="invoice-title-section">
            <h2 class="invoice-heading">INVOICE</h2>
            <span class="invoice-number">Invoice No: ${escapeHTML(invoiceNum)}</span>
          </div>
        </div>
        
        <div class="invoice-details-grid">
          <div class="details-column">
            <p><strong>Billed To (Customer Detail):</strong></p>
            <p>Customer Name: ${escapeHTML(custName)}</p>
            <p>Customer Phone: ${escapeHTML(custPhone)}</p>
          </div>
          <div class="details-column" style="text-align: right;">
            <p><strong>Invoice Details:</strong></p>
            <p>Date: ${dateStr}</p>
            <p>Time: ${timeStr}</p>
            <p>Status: </p>
          </div>
        </div>
        
        <div class="table-container">
          <table class="invoice-table">
            <thead>
              <tr>
                <th style="text-align: left;">Item Description</th>
                <th style="text-align: center; width: 80px;">Qty</th>
                <th style="text-align: center; width: 120px;">Unit Price (₹)</th>
                <th style="text-align: right; width: 150px;">Total Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
        </div>
        
        <div class="bottom-grid">
          <div></div>
          
          <div class="totals-section">
            <div class="totals-row">
              <span>Subtotal:</span>
              <span>₹${billData.subtotal.toFixed(2)}</span>
            </div>
            ${billData.savings > 0 ? `
              <div class="totals-row">
                <span>Discount:</span>
                <span>-₹${billData.savings.toFixed(2)}</span>
              </div>
            ` : ''}
            <div class="totals-row grand-total">
               <span>Grand Total:</span>
               <span>₹${billData.grandTotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
        
        <div class="invoice-footer">
          Thank you for your visit
        </div>
      `;
    }
    
    // Small timeout to allow styling to resolve before printing
    setTimeout(() => {
      const cleanupPrint = () => {
        printLayout.innerHTML = '';
        printLayout.className = 'print-only';
        window.removeEventListener('afterprint', cleanupPrint);
      };
      window.addEventListener('afterprint', cleanupPrint);
      window.print();
    }, 250);
  }
  
  // Non-blocking install suggestion toast for Android Chrome users
  function showInstallSuggestionToast() {
    // Only show once per session
    if (window._installToastShown) return;
    window._installToastShown = true;
    
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(30,41,59,0.95);color:#e2e8f0;padding:14px 22px;border-radius:14px;font-size:13px;z-index:99999;max-width:90vw;text-align:center;backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 32px rgba(0,0,0,0.4);animation:fadeInUp 0.3s ease-out;';
    toast.innerHTML = '💡 <strong>Tip:</strong> Install this app to your home screen for the best printing experience! <em>(⋮ menu → Install app)</em>';
    document.body.appendChild(toast);
    
    // Add animation keyframes if not present
    if (!document.getElementById('toast-anim-style')) {
      const style = document.createElement('style');
      style.id = 'toast-anim-style';
      style.textContent = '@keyframes fadeInUp{from{opacity:0;transform:translateX(-50%) translateY(20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
      document.head.appendChild(style);
    }
    
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.5s'; }, 5000);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5500);
  }

  function showPrintLayoutModal(bank, billData) {
    const modal = document.getElementById('print-layout-modal');
    const btn80 = document.getElementById('print-format-80mm-btn');
    const btnA4 = document.getElementById('print-format-a4-btn');
    const btnCancel = document.getElementById('print-format-cancel-btn');
    
    if (!modal) return;
    modal.style.display = 'flex';
    
    const cleanup = () => {
      modal.style.display = 'none';
      btn80.onclick = null;
      btnA4.onclick = null;
      btnCancel.onclick = null;
    };
    
    btn80.onclick = () => {
      cleanup();
      triggerBrowserPrint(bank, billData, '80mm');
    };
    
    btnA4.onclick = () => {
      cleanup();
      triggerBrowserPrint(bank, billData, 'a4');
    };
    
    btnCancel.onclick = () => {
      cleanup();
    };
  }
  
  function showCustomerPromptModal(initialName, initialPhone, onConfirm) {
    const modal = document.getElementById('customer-details-modal');
    const nameInput = document.getElementById('prompt-cust-name');
    const phoneInput = document.getElementById('prompt-cust-phone');
    const saveBtn = document.getElementById('prompt-save-btn');
    const cancelBtn = document.getElementById('prompt-cancel-btn');
    
    if (!modal || !nameInput || !phoneInput) return;
    
    nameInput.value = (initialName && initialName !== '-') ? initialName : '';
    phoneInput.value = (initialPhone && initialPhone !== '-') ? initialPhone : '';
    
    modal.style.display = 'flex';
    nameInput.focus();
    
    const cleanup = () => {
      modal.style.display = 'none';
      saveBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    
    saveBtn.onclick = () => {
      const finalName = nameInput.value.trim() || '-';
      const finalPhone = phoneInput.value.trim() || '-';
      cleanup();
      onConfirm(finalName, finalPhone);
    };
    
    cancelBtn.onclick = () => {
      cleanup();
    };
  }

  // =====================================================================
  //  UNIFIED RECEIPT IMAGE GENERATOR
  //  Used for: Android print fallback, WhatsApp sharing, History resend
  //  Two modes: '80mm' (thermal receipt) and 'a4' (professional invoice)
  // =====================================================================
  
  function shareReceiptAsImage(bank, billData, isPrintShare = false, format = '80mm') {
    if (!bank || !billData) return;
    
    const custName = billData.custName || '-';
    const custPhone = billData.custPhone || '-';
    const shopName = merchantProfile.name || 'Shop Name';
    const shopAddress = merchantProfile.address || 'Shop Address';
    const shopPhone = merchantProfile.phone || '0000000000';
    const invoiceNum = billData.invoiceNum || '1';
    const isCash = bank.id === 'bank_cash';
    const items = billData.items || [];
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (format === 'a4') {
      drawInvoiceA4(canvas, ctx, { shopName, shopAddress, shopPhone, invoiceNum, custName, custPhone, isCash, items, billData, bank });
    } else {
      drawReceipt80mm(canvas, ctx, { shopName, shopAddress, shopPhone, invoiceNum, custName, custPhone, isCash, items, billData, bank });
    }
    
    // Convert canvas to PNG blob and share
    canvas.toBlob((blob) => {
      if (!blob) return;
      
      const file = new File([blob], `invoice_${custName !== '-' ? custName : 'customer'}.png`, { type: 'image/png' });
      const text = generateWhatsAppInvoiceText(bank, billData);
      const cleanPhone = custPhone.replace(/\D/g, '');
      
      let isShareSupported = false;
      try {
        isShareSupported = navigator.canShare && navigator.canShare({ files: [file] });
      } catch (e) {
        console.warn('[Web Share] capability check failed:', e);
      }
      
      if (isShareSupported) {
        const shareData = { title: `Receipt from ${shopName}`, files: [file] };
        if (!isPrintShare) {
          shareData.text = text;
        }
        navigator.share(shareData)
          .then(() => console.log('[Web Share] Shared receipt image successfully'))
          .catch((err) => {
            console.warn('[Web Share] Image sharing failed or rejected:', err);
            // Avoid triggering WhatsApp Web fallback if user explicitly aborted/cancelled the share sheet
            if (err && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort') || err.message.toLowerCase().includes('cancel'))) {
              console.log('[Web Share] Share was cancelled/aborted by the user.');
              return;
            }
            if (!isPrintShare) openWhatsAppTextFallback(cleanPhone, text);
          });
      } else {
        if (!isPrintShare) openWhatsAppTextFallback(cleanPhone, text);
        else alert('Sharing is not supported on this device/browser.');
      }
    }, 'image/png');
  }
  
  // ------------------------------------------------------------------
  //  80mm THERMAL RECEIPT DRAWING
  //  576px wide at 1x (native 203 DPI thermal printer resolution)
  //  Pure monochrome output with 1-bit threshold for crisp thermal print
  // ------------------------------------------------------------------
  function drawReceipt80mm(canvas, ctx, d) {
    const W = 576;
    const pad = 30;
    const itemH = 45;
    
    // Calculate the height dynamically based on the exact same layout rules!
    let calcH = 272; // Items start at y = 272
    calcH += d.items.length * itemH;
    calcH += 38; // Subtotal spacing
    if (d.billData.savings > 0) {
      calcH += 24; // Discount spacing
    }
    calcH += 56; // Grand total spacing
    
    if (!d.isCash) {
      calcH += 180; // QR size (qrSize = 180)
      calcH += 28;  // Spacing after QR
      calcH += 28;  // Spacing to THANK YOU
      calcH += 40;  // Bottom safety padding
    } else {
      calcH += 16;  // Spacing to cash THANK YOU
      calcH += 18;  // Spacing to THANK YOU
      calcH += 40;  // Bottom safety padding
    }
    
    const H = calcH;
    canvas.width = W;
    canvas.height = H;
    ctx.imageSmoothingEnabled = false;
    
    // White background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    
    // --- Header ---
    ctx.font = 'bold 32px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d.shopName.toUpperCase(), W / 2, 48);
    
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillText(`${d.shopAddress} | Ph: ${d.shopPhone}`, W / 2, 78);
    
    // Divider
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pad, 98); ctx.lineTo(W - pad, 98); ctx.stroke();
    
    // --- Invoice info ---
    ctx.textAlign = 'left';
    ctx.font = '18px "Inter", sans-serif';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    ctx.fillText(`Invoice #: ${d.invoiceNum}`, pad, 122);
    ctx.fillText(`Date: ${dateStr}, ${timeStr}`, pad, 147);
    ctx.fillText(`Customer: ${d.custName}`, pad, 172);
    ctx.fillText(`Phone: ${d.custPhone}`, pad, 197);
    
    // --- Table header ---
    ctx.beginPath(); ctx.moveTo(pad, 212); ctx.lineTo(W - pad, 212); ctx.stroke();
    
    ctx.font = 'bold 16px "Inter", sans-serif';
    ctx.fillText('ITEM', pad, 232);
    ctx.textAlign = 'center';
    ctx.fillText('QTY x PRICE', W / 2 + pad, 232);
    ctx.textAlign = 'right';
    ctx.fillText('AMOUNT', W - pad, 232);
    
    ctx.beginPath(); ctx.moveTo(pad, 242); ctx.lineTo(W - pad, 242); ctx.stroke();
    
    // --- Items ---
    let y = 272;
    d.items.forEach(item => {
      ctx.textAlign = 'left';
      ctx.font = '18px "Inter", sans-serif';
      ctx.fillText(item.name, pad, y);
      ctx.textAlign = 'center';
      ctx.fillText(`${item.qty} x ₹${item.price.toFixed(2)}`, W / 2 + pad, y);
      ctx.textAlign = 'right';
      ctx.font = 'bold 18px "Inter", sans-serif';
      ctx.fillText(`₹${(item.price * item.qty).toFixed(2)}`, W - pad, y);
      y += itemH;
    });
    
    // Bottom divider
    ctx.beginPath(); ctx.moveTo(pad, y - 14); ctx.lineTo(W - pad, y - 14); ctx.stroke();
    
    // --- Totals ---
    ctx.font = '18px "Inter", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Subtotal (${d.billData.itemCount} items):`, pad, y + 14);
    ctx.textAlign = 'right';
    ctx.fillText(`₹${d.billData.subtotal.toFixed(2)}`, W - pad, y + 14);
    y += 38;
    
    if (d.billData.savings > 0) {
      const sym = d.billData.discountType === 'percent' ? `${d.billData.discount}%` : `₹${d.billData.discount}`;
      ctx.textAlign = 'left';
      ctx.fillText(`Discount (${sym}):`, pad, y);
      ctx.textAlign = 'right';
      ctx.fillText(`-₹${d.billData.savings.toFixed(2)}`, W - pad, y);
      y += 24;
    }
    
    ctx.beginPath(); ctx.moveTo(pad, y - 4); ctx.lineTo(W - pad, y - 4); ctx.stroke();
    
    ctx.textAlign = 'left';
    ctx.font = 'bold 22px "Inter", sans-serif';
    ctx.fillText('GRAND TOTAL:', pad, y + 24);
    ctx.textAlign = 'right';
    ctx.font = 'bold 26px "Inter", sans-serif';
    ctx.fillText(`₹${d.billData.grandTotal.toFixed(2)}`, W - pad, y + 24);
    y += 56;
    
    // --- Footer: UPI QR or Thank You ---
    if (!d.isCash) {
      const upiLink = `upi://pay?pa=${d.bank.upiId}&pn=${encodeURIComponent(d.shopName)}&am=${d.billData.grandTotal.toFixed(2)}&cu=INR`;
      const tempCanvas = document.createElement('canvas');
      new QRious({ element: tempCanvas, value: upiLink, size: 260, background: '#ffffff', foreground: '#000000', level: 'M' });
      
      const qrSize = 180;
      const qrX = (W - qrSize) / 2;
      ctx.fillStyle = '#fff';
      ctx.fillRect(qrX - 10, y - 10, qrSize + 20, qrSize + 20);
      ctx.drawImage(tempCanvas, qrX, y, qrSize, qrSize);
      tempCanvas.width = 0; tempCanvas.height = 0; // release canvas buffer memory immediately
      y += qrSize + 28;
      
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.font = '14px "Inter", sans-serif';
      ctx.fillText('Scan this QR code with your UPI app to pay', W / 2, y);
      ctx.font = 'bold 16px "Inter", sans-serif';
      ctx.fillText('THANK YOU FOR YOUR VISIT!', W / 2, y + 28);
    } else {
      y += 16;
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px "Inter", sans-serif';
      ctx.fillText('THANK YOU FOR YOUR VISIT!', W / 2, y + 18);
    }
    
    // --- 1-bit monochrome threshold for thermal printers ---
    try {
      const imgData = ctx.getImageData(0, 0, W, H);
      const px = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        const avg = (px[i] + px[i+1] + px[i+2]) / 3;
        const c = avg < 180 ? 0 : 255;
        px[i] = c; px[i+1] = c; px[i+2] = c; px[i+3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
    } catch (e) {
      console.warn('[Thermal] Pixel threshold blocked:', e);
    }
  }
  
  // ------------------------------------------------------------------
  //  A4 PROFESSIONAL INVOICE DRAWING
  //  1240px wide, matching the desktop/iOS HTML A4 layout exactly:
  //  - "INVOICE" heading on top-right, shop name on top-left
  //  - Customer/Invoice details in a split grid
  //  - Full-width item table
  //  - Grand total section aligned to the right
  // ------------------------------------------------------------------
  function drawInvoiceA4(canvas, ctx, d) {
    const W = 1240;
    const padX = 90;  // 15mm left/right margin
    const padY = 120; // 20mm top margin
    const itemH = 50;
    
    const contentH = padY + 620 + (d.items.length * itemH);
    const H = Math.max(1754, contentH);
    
    canvas.width = W;
    canvas.height = H;
    
    // White background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    
    // --- Nested Spacing/Rupee Helpers ---
    function drawRupeeAmount(ctx, amount, x, y, align = 'right', isBold = false, fontSize = 18, isNegative = false) {
      const absAmt = Math.abs(amount);
      const amtStr = absAmt.toFixed(2);
      ctx.font = `${isBold ? 'bold ' : ''}${fontSize}px "Inter", sans-serif`;
      
      ctx.save();
      
      const minusW = isNegative ? ctx.measureText('-').width : 0;
      const rupeeW = ctx.measureText('₹').width;
      const amtW = ctx.measureText(amtStr).width;
      const totalW = minusW + rupeeW + amtW;
      
      let currentX;
      if (align === 'right') {
        currentX = x - totalW;
      } else if (align === 'center') {
        currentX = x - totalW / 2;
      } else {
        currentX = x;
      }
      
      ctx.textAlign = 'left';
      
      if (isNegative) {
        ctx.fillStyle = '#0f172a';
        ctx.fillText('-', currentX, y);
        currentX += minusW;
      }
      
      // Restore Rupee Symbol color to solid black
      ctx.fillStyle = '#0f172a';
      ctx.fillText('₹', currentX, y);
      currentX += rupeeW;
      
      ctx.fillStyle = '#0f172a';
      ctx.fillText(amtStr, currentX, y);
      
      ctx.restore();
    }
    
    function drawHeaderWithRupee(ctx, baseText, x, y) {
      ctx.save();
      ctx.font = 'bold 16px "Inter", sans-serif';
      
      const baseW = ctx.measureText(baseText + ' (').width;
      const rupeeW = ctx.measureText('₹').width;
      const closeW = ctx.measureText(')').width;
      const totalW = baseW + rupeeW + closeW;
      
      const startX = x - totalW / 2;
      
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(baseText + ' (', startX, y);
      ctx.fillStyle = '#0f172a';
      ctx.fillText('₹', startX + baseW, y);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(')', startX + baseW + rupeeW, y);
      ctx.restore();
    }
    
    function drawHeaderWithRupeeRight(ctx, baseText, x, y) {
      ctx.save();
      ctx.font = 'bold 16px "Inter", sans-serif';
      
      const baseW = ctx.measureText(baseText + ' (').width;
      const rupeeW = ctx.measureText('₹').width;
      const closeW = ctx.measureText(')').width;
      const totalW = baseW + rupeeW + closeW;
      
      const startX = x - totalW;
      
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(baseText + ' (', startX, y);
      ctx.fillStyle = '#0f172a';
      ctx.fillText('₹', startX + baseW, y);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(')', startX + baseW + rupeeW, y);
      ctx.restore();
    }
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    
    // Parse time in exact lowercase format like desktop (e.g. 10:03 am)
    const hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    const displayHours = hours % 12 || 12;
    const timeStr = `${displayHours}:${minutes} ${ampm}`;
    
    // === TOP ROW: Shop Name (left) + INVOICE heading (right) ===
    ctx.font = 'bold 36px "Inter", sans-serif';
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'left';
    ctx.fillText(d.shopName.toUpperCase(), padX, padY + 36);
    
    // INVOICE title (right side)
    ctx.textAlign = 'right';
    ctx.font = 'bold 44px "Inter", sans-serif';
    ctx.fillText('INVOICE', W - padX, padY + 36);
    
    // Sub-header details
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'left';
    ctx.fillText(d.shopAddress, padX, padY + 70);
    ctx.fillText(`Phone: ${d.shopPhone}`, padX, padY + 95);
    
    ctx.textAlign = 'right';
    ctx.font = 'bold 20px "Inter", sans-serif';
    ctx.fillText(`Invoice No: ${d.invoiceNum}`, W - padX, padY + 70);
    
    // === CUSTOMER/INVOICE DETAILS GRID ===
    const gridTop = padY + 130;
    const gridBottom = padY + 270;
    
    // Grid top boundary line
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padX, gridTop); ctx.lineTo(W - padX, gridTop); ctx.stroke();
    
    // Grid Details text
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px "Inter", sans-serif';
    ctx.fillText('Billed To (Customer Detail):', padX, gridTop + 36);
    
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillStyle = '#475569';
    ctx.fillText(`Customer Name: ${d.custName}`, padX, gridTop + 68);
    ctx.fillText(`Customer Phone: ${d.custPhone}`, padX, gridTop + 94);
    
    ctx.textAlign = 'right';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px "Inter", sans-serif';
    ctx.fillText('Invoice Details:', W - padX, gridTop + 36);
    
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillStyle = '#475569';
    ctx.fillText(`Date: ${dateStr}`, W - padX, gridTop + 68);
    ctx.fillText(`Time: ${timeStr}`, W - padX, gridTop + 94);
    ctx.fillText('Status: ', W - padX, gridTop + 120); // matching desktop layout exactly
    
    // Grid bottom boundary line
    ctx.beginPath(); ctx.moveTo(padX, gridBottom); ctx.lineTo(W - padX, gridBottom); ctx.stroke();
    
    // === TABLE HEADER ===
    const tableTop = gridBottom + 45;
    
    // Background fill (very light desktop th background)
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(padX, tableTop, W - (padX * 2), 42);
    
    // Header borders (exactly mimicking the browser table th styling)
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padX, tableTop); ctx.lineTo(W - padX, tableTop); ctx.stroke();
    
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(padX, tableTop + 42); ctx.lineTo(W - padX, tableTop + 42); ctx.stroke();
    
    // Header column labels
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 16px "Inter", sans-serif';
    ctx.fillText('ITEM DESCRIPTION', padX + 16, tableTop + 28);
    
    ctx.textAlign = 'center';
    ctx.fillText('QTY', W / 2 - 80, tableTop + 28);
    
    // Custom blue Rupee in header columns
    drawHeaderWithRupee(ctx, 'UNIT PRICE', W / 2 + 100, tableTop + 28);
    drawHeaderWithRupeeRight(ctx, 'TOTAL AMOUNT', W - padX - 16, tableTop + 28);
    
    // === TABLE ROWS ===
    let y = tableTop + 42;
    d.items.forEach((item) => {
      // Background remains transparent/white for rows as in desktop print

      ctx.fillStyle = '#334155';
      ctx.font = '18px "Inter", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(item.name, padX + 16, y + 32);
      
      ctx.textAlign = 'center';
      ctx.fillText(`${item.qty}`, W / 2 - 80, y + 32);
      
      // Draw Rupee Amounts with blue symbols
      drawRupeeAmount(ctx, item.price, W / 2 + 100, y + 32, 'center', false, 18);
      drawRupeeAmount(ctx, item.price * item.qty, W - padX - 16, y + 32, 'right', true, 18);
      
      // Bottom row border
      ctx.strokeStyle = '#f1f5f9';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padX, y + itemH); ctx.lineTo(W - padX, y + itemH); ctx.stroke();
      
      y += itemH;
    });
    
    // === TOTALS & PAYMENT SECTION (Side-by-side matching desktop) ===
    y += 45;
    const totalsX = W - padX - 350;
    
    // totals section drawn on the right (UPI QR block removed as requested)
    
    // Draw Totals on the right
    ctx.textAlign = 'left';
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillStyle = '#475569';
    
    let totalsY = y;
    // Subtotal
    ctx.fillText('Subtotal:', totalsX, totalsY);
    drawRupeeAmount(ctx, d.billData.subtotal, W - padX, totalsY, 'right', false, 18);
    totalsY += 30;
    
    // Discount
    if (d.billData.savings > 0) {
      ctx.textAlign = 'left';
      ctx.fillText('Discount:', totalsX, totalsY);
      drawRupeeAmount(ctx, d.billData.savings, W - padX, totalsY, 'right', false, 18, true);
      totalsY += 30;
    }
    
    // Grand total divider line
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(totalsX, totalsY - 6);
    ctx.lineTo(W - padX, totalsY - 6);
    ctx.stroke();
    
    // Grand total
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 24px "Inter", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Grand Total:', totalsX, totalsY + 24);
    drawRupeeAmount(ctx, d.billData.grandTotal, W - padX, totalsY + 24, 'right', true, 28);
    
    // === FOOTER SECTION (At the absolute bottom matching media print) ===
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, H - 120);
    ctx.lineTo(W - padX, H - 120);
    ctx.stroke();
    
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000000';
    ctx.font = '18px "Inter", sans-serif';
    ctx.fillText('Thank you for your visit', W / 2, H - 75);
  }

  // --- Settings & Logs ---
  function loadSettingsForms() {
    // Load profile
    merchantNameInput.value = merchantProfile.name || '';
    merchantAddressInput.value = merchantProfile.address || '';
    merchantPhoneInput.value = merchantProfile.phone || '';
    
    // Clear forms & re-render lists
    resetBankForm();
    renderSavedBanksList();
    renderSalesLogs();
  }

  function initSettingsView() {
    loadSettingsForms();
    updateSettingsViewMode();
  }

  // Save Merchant Profile
  saveMerchantBtn.addEventListener('click', () => {
    const name = merchantNameInput.value.trim();
    const address = merchantAddressInput.value.trim();
    const phone = merchantPhoneInput.value.trim();

    if (!name) {
      alert('Business Payee Name is required!');
      return;
    }

    merchantProfile = { name, address, phone };
    localStorage.setItem('pos_merchant', JSON.stringify(merchantProfile));
    
    // Sync merchant settings updates to cloud metadata row
    pushSettingsMetaToCloud();
    
    // Visual indicator
    saveMerchantBtn.innerText = 'Saved Successfully!';
    saveMerchantBtn.classList.remove('btn-emerald');
    saveMerchantBtn.style.backgroundColor = '#065f46';
    
    setTimeout(() => {
      saveMerchantBtn.innerText = 'Save Profile Details';
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
            <div class="bank-item-name">${escapeHTML(bank.name)}</div>
            <div class="bank-item-upi">${escapeHTML(bank.upiId)}</div>
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



  // --- Sales Log & Filters ---
  function renderSalesLogs() {
    historyListContainer.innerHTML = '';
    
    // FILTER OUT DELETED TRANSACTIONS FOR ANALYTICS AND DISPLAY LISTS
    const activeHistory = transactionHistory.filter(tx => tx.status !== 'deleted');

    const selectedFy = filterFy.value; // "all", "FY2526", "FY2627"
    const selectedMonth = filterMonth.value; // "all", "04", "05", etc.
    const searchQuery = (filterSearchName && filterSearchName.value.trim().toLowerCase()) || '';
    
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

    // Filter transaction list based on select dropdowns, dates, and search queries
    let filteredHistory = activeHistory.filter(tx => {
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

      // 3. Filter by Search Query (Customer Name, Phone, Bank, Invoice # or Note)
      if (searchQuery) {
        let matches = false;
        let noteText = tx.note || '';
        try {
          if (noteText.startsWith('{') || noteText.startsWith('[')) {
            const billData = JSON.parse(noteText);
            if (billData) {
              const custName = (billData.custName || '').toLowerCase();
              const custPhone = (billData.custPhone || '').toLowerCase();
              const invNum = String(billData.invoiceNum || '').toLowerCase();
              if (custName.includes(searchQuery) || custPhone.includes(searchQuery) || invNum.includes(searchQuery)) {
                matches = true;
              }
            }
          }
        } catch (e) {}
        
        if (!matches && noteText.toLowerCase().includes(searchQuery)) {
          matches = true;
        }
        if (!matches && tx.bankName.toLowerCase().includes(searchQuery)) {
          matches = true;
        }
        
        if (!matches) {
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

    activeHistory.forEach(tx => {
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
    activeHistory.forEach(tx => {
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

    // Sort filteredHistory by timestamp descending to ensure perfect "sort by date" sequence
    filteredHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    filteredHistory.forEach(tx => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'stretch';
      item.style.padding = '12px';
      item.style.cursor = 'pointer';
      
      const formattedAmt = new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2
      }).format(tx.amount);

      const txDate = new Date(tx.timestamp);
      const formattedTime = txDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' | ' + txDate.toLocaleDateString([], { month: 'short', day: 'numeric' });

      // Determine note content and parse JSON bill details if applicable
      let isBill = false;
      let billData = null;
      let displayNote = tx.note || '';
      
      try {
        if (tx.note && (tx.note.startsWith('{') || tx.note.startsWith('['))) {
          const parsed = JSON.parse(tx.note);
          if (parsed && parsed.invoiceNum !== undefined) {
            billData = parsed;
            isBill = true;
          }
        }
      } catch (e) {
        console.error('[Sales Log] Error parsing transaction JSON:', e);
      }
      
      if (!billData) {
        // Synthesize structured billData on the fly for flat payments
        const shortTxId = tx.id ? tx.id.slice(-4).toUpperCase() : '0000';
        billData = {
          type: 'flat',
          invoiceNum: shortTxId,
          custName: '-',
          custPhone: '-',
          items: [{ name: 'TOTAL', qty: 1, price: tx.amount }],
          discount: 0,
          discountType: 'flat',
          grandTotal: tx.amount,
          subtotal: tx.amount,
          savings: 0,
          itemCount: 1
        };
      }

      badgeLabel = `Bill #${billData.invoiceNum}`;
      badgeClass = 'status-badge-paid';
      
      const itemsListHtml = billData.items.map(item => `
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 2px; color: var(--text-secondary);">
          <span>• ${escapeHTML(item.name)} (x${escapeHTML(item.qty)})</span>
          <span>₹${(item.price * item.qty).toFixed(2)}</span>
        </div>
      `).join('');
      
      detailsHtml = `
        <div class="history-item-details" style="display: none; margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 10px; user-select: text;">
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; line-height: 1.4;">
            <strong>Bill Details (Invoice #${escapeHTML(billData.invoiceNum)})</strong><br>
            Customer: <span style="color:#fff;" class="details-cust-name">${escapeHTML(billData.custName)}</span> | Phone: <span style="color:#fff;" class="details-cust-phone">${escapeHTML(billData.custPhone)}</span>
          </div>
          <div style="margin-bottom: 8px;">
            ${itemsListHtml}
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: bold; margin-bottom: 10px; color: #fff;">
            <span>Total Paid:</span>
            <span style="color: var(--color-emerald)">₹${billData.grandTotal.toFixed(2)}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button class="btn btn-secondary history-print-btn" style="padding: 8px 12px; font-size: 11px; width: 100%; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; border-color: rgba(59, 130, 246, 0.25); color: #93c5fd; background: rgba(59, 130, 246, 0.03);">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              Print Bill / Receipt
            </button>
            <button class="btn btn-emerald resend-whatsapp-btn" style="padding: 8px 12px; font-size: 11px; width: 100%; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <svg fill="currentColor" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.513 2.262 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.455L0 24zm6.59-4.846c1.66.986 3.292 1.48 4.957 1.48 5.397 0 9.783-4.382 9.786-9.778.001-2.614-1.015-5.07-2.861-6.918C16.68 2.087 14.225.996 11.61.996 6.21.996 1.825 5.378 1.822 10.774c-.001 1.761.472 3.42 1.368 4.949L2.2 21.066l4.447-1.912zm13.111-8.528c-.302-.152-1.791-.883-2.068-.984-.278-.102-.48-.152-.68.152-.2.304-.775.984-.95 1.186-.176.203-.351.228-.654.076-.303-.152-1.28-.471-2.438-1.503-.9-.802-1.507-1.793-1.684-2.097-.176-.304-.019-.469.132-.619.136-.134.303-.354.454-.531.152-.177.202-.304.303-.506.101-.203.05-.38-.025-.531-.076-.152-.68-1.636-.931-2.24-.246-.59-.496-.51-.68-.52-.177-.008-.38-.01-.58-.01s-.525.075-.8.38c-.275.304-1.05 1.028-1.05 2.508 0 1.48 1.075 2.913 1.225 3.116.15.203 2.115 3.23 5.125 4.53.716.31 1.275.495 1.71.635.72.23 1.375.197 1.892.12.576-.086 1.79-.73 2.043-1.436.253-.706.253-1.313.177-1.438-.076-.126-.278-.203-.58-.354z"/>
            </svg>
            Send Bill to WhatsApp
          </button>
        </div>
      </div>
      `;
 
      const isCashTx = tx.upiId === 'cash' || tx.bankName === 'Cash Payment';
      const displayBankName = isAdminModeActive ? tx.bankName : (isCashTx ? 'Cash' : 'Online');
      
      const deleteBtnHtml = isAdminModeActive ? `
        <button class="history-item-delete" data-tx-id="${tx.id}" title="Delete this transaction" style="padding: 6px; margin-left: 4px;">
          <svg viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      ` : '';
 
      const custTag = (billData && billData.custName && billData.custName !== '-') ? 
        ` <span class="history-item-cust-tag" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(99, 102, 241, 0.15); color: #818cf8; margin-left: 6px; font-weight: 500; display: inline-flex; align-items: center; vertical-align: middle; gap: 2px;">👤 ${escapeHTML(billData.custName)}</span>` : 
        '';
 
      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div class="history-item-left">
            <div class="history-item-bank" style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
              <span>${escapeHTML(displayBankName)}</span>
              ${custTag}
            </div>
            <div class="history-item-time">${formattedTime}</div>
          </div>
          <div class="history-item-right" style="display: flex; align-items: center; gap: 8px;">
            <div style="text-align: right;">
              <div class="history-item-amt">${formattedAmt}</div>
              <span class="status-badge ${badgeClass}">${escapeHTML(badgeLabel)}</span>
            </div>
            ${deleteBtnHtml}
          </div>
        </div>
        ${detailsHtml}
      `;
 
      // Collapsible toggle handler
      item.addEventListener('click', (e) => {
        // Prevent toggle if delete, print, or resend buttons are clicked
        if (e.target.closest('.history-item-delete') || e.target.closest('.resend-whatsapp-btn') || e.target.closest('.history-print-btn')) {
          return;
        }
        const detailsPanel = item.querySelector('.history-item-details');
        if (detailsPanel) {
          const isCollapsed = detailsPanel.style.display === 'none';
          detailsPanel.style.display = isCollapsed ? 'block' : 'none';
          item.style.background = isCollapsed ? 'rgba(255,255,255,0.03)' : '';
          
          // Dynamically adjust wrapper's max-height to accommodate open items!
          const wrapper = historyListContainer.closest('.history-list-wrapper');
          if (wrapper) {
            const anyExpanded = Array.from(historyListContainer.querySelectorAll('.history-item-details'))
              .some(el => el.style.display === 'block');
            wrapper.style.maxHeight = anyExpanded ? '480px' : '200px';
          }

          if (isCollapsed) {
            setTimeout(() => {
              item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 100);
          }
        }
      });
 
      // Bind Print action
      const printBtn = item.querySelector('.history-print-btn');
      if (printBtn) {
        printBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const txBank = (tx.upiId === 'cash' || tx.bankName === 'Cash Payment') ? CASH_PAYMENT : (bankAccounts.find(b => b.name === tx.bankName || b.upiId === tx.upiId) || bankAccounts[0] || CASH_PAYMENT);
          showPrintLayoutModal(txBank, billData);
        });
      }

      // Bind WhatsApp Resend action
      const resendBtn = item.querySelector('.resend-whatsapp-btn');
      if (resendBtn) {
        resendBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          
          const txBank = (tx.upiId === 'cash' || tx.bankName === 'Cash Payment') ? CASH_PAYMENT : (bankAccounts.find(b => b.name === tx.bankName || b.upiId === tx.upiId) || bankAccounts[0] || CASH_PAYMENT);
          
          const executeShare = (finalName, finalPhone) => {
            billData.custName = finalName;
            billData.custPhone = finalPhone;
            tx.note = JSON.stringify(billData);
            
            // Save updated transaction locally and queue database sync
            localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
            enqueueSyncTask('pos_history', 'upsert', tx);
            
            // Re-render UI details inline
            const nameSpan = item.querySelector('.details-cust-name');
            const phoneSpan = item.querySelector('.details-cust-phone');
            if (nameSpan) nameSpan.textContent = finalName;
            if (phoneSpan) phoneSpan.textContent = finalPhone;
            
            shareReceiptAsImage(txBank, billData);
          };
          
          if (billData.custName === '-' || billData.custPhone === '-') {
            showCustomerPromptModal(billData.custName, billData.custPhone, (finalName, finalPhone) => {
              executeShare(finalName, finalPhone);
            });
          } else {
            executeShare(billData.custName, billData.custPhone);
          }
        });
      }

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
          txToDelete.status = 'deleted'; // Mark status as deleted (Soft Delete Audit)
          enqueueSyncTask('pos_history', 'upsert', txToDelete); // Push update to Supabase
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
            tx.status = 'deleted'; // Soft Delete Audit
            enqueueSyncTask('pos_history', 'upsert', tx);
          }
        });
        localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
        renderSalesLogs();
      }
    });
  }

  // Clear ALL history logs (nuclear option)
  if (clearAllHistoryBtn) {
    clearAllHistoryBtn.addEventListener('click', () => {
      if (transactionHistory.length === 0) return;
      
      if (confirm('Are you sure you want to clear ALL transaction history logs? This will mark them as deleted in the cloud database too!')) {
        transactionHistory.forEach(tx => {
          tx.status = 'deleted'; // Soft Delete Audit
          enqueueSyncTask('pos_history', 'upsert', tx);
        });
        localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
        renderSalesLogs();
      }
    });
  }

  // --- Cloud Sync & Login UI ---
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
          alert('Registration Successful! Please check your email inbox to confirm your account before signing in.');
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
          // Immediately clear everything locally to prevent privacy leak on iOS PWA
          localStorage.removeItem('pos_initial_sync_done');
          localStorage.removeItem('pos_sync_queue');
          
          localStorage.setItem('pos_banks', JSON.stringify(DEFAULT_BANKS));
          localStorage.setItem('pos_history', JSON.stringify([]));
          localStorage.setItem('pos_merchant', JSON.stringify(DEFAULT_MERCHANT));
          localStorage.setItem('pos_invoice_counter', '1');
          
          bankAccounts = DEFAULT_BANKS;
          transactionHistory = [];
          merchantProfile = DEFAULT_MERCHANT;
          
          if (authEmailInput) authEmailInput.value = '';
          if (authPasswordInput) authPasswordInput.value = '';
          if (merchantNameInput) merchantNameInput.value = '';
          if (merchantAddressInput) merchantAddressInput.value = '';
          if (merchantPhoneInput) merchantPhoneInput.value = '';
          if (loggedInEmailDisplay) loggedInEmailDisplay.value = '';
          
          renderSavedBanksList();
          renderSalesLogs();
          resetBankForm();
          
          updateSyncStatusUI('offline');
          unsubscribeRealtimeSync();

          // Trigger signOut in background
          await supabase.auth.signOut();
        } catch (e) {
          console.error('[Supabase Auth] Sign out failed:', e);
        }
      }
    });
  }

  // --- Initialization ---
  
  // 1. Instantly display correct view to prevent page-refresh POS main-page jump!
  try {
    migrateSeededBankIds(); // Run self-healing migration to replace clashing seeded bank IDs and avoid DB RLS errors
    updateAmountDisplay();
    router();
    updatePinLockoutState();
    updateRecoveryLinkState();
  } catch (e) {
    console.error('[POS Initialization] Routing error:', e);
  }

  // 2. Load Supabase cloud connections in the background
  try {
    initSupabase();
  } catch (e) {
    console.error('[POS Initialization] Supabase startup failed:', e);
  }

  // Auto-select text inside inputs on focus for ultra-fast habit-building sequential typing
  const inputsToAutoSelect = [
    billCustNameInput,
    billCustPhoneInput,
    billItemNameInput,
    billItemPriceInput,
    billItemQtyInput,
    billDiscountInput
  ];
  inputsToAutoSelect.forEach(input => {
    if (input) {
      input.addEventListener('focus', () => {
        try {
          input.select();
        } catch (e) {}
      });
    }
  });

  // --- Bill Maker Keyboard & Form Submit Binding ---
  if (billCustNameInput && billCustPhoneInput) {
    billCustNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        billCustPhoneInput.focus();
      }
    });
  }

  if (billCustPhoneInput && billItemNameInput) {
    billCustPhoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        billItemNameInput.focus();
      }
    });
  }

  if (billItemNameInput && billItemPriceInput && billItemQtyInput) {
    billItemNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        billItemPriceInput.focus();
      }
    });
    
    billItemPriceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        billItemQtyInput.focus();
      }
    });
    
    billItemQtyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        addBillItem();
      }
    });
  }

  if (billDiscountInput && billProceedBtn) {
    billDiscountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        billProceedBtn.focus();
        billProceedBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  if (billBankSelect) {
    billBankSelect.addEventListener('change', () => {
      const selectedBankId = billBankSelect.value;
      activeSelectedBank = getBankById(selectedBankId) || CASH_PAYMENT;
    });
  }

  if (billProceedBtn) {
    billProceedBtn.onclick = () => {
      if (activeBillItems.length === 0) {
        alert('Please add at least one item to the bill first.');
        return;
      }
      
      // Ensure active selected bank is updated from the dropdown
      if (billBankSelect) {
        const selectedBankId = billBankSelect.value;
        activeSelectedBank = getBankById(selectedBankId) || CASH_PAYMENT;
      }
      
      if (!activeSelectedBank) {
        activeSelectedBank = CASH_PAYMENT;
      }
      
      const totals = calculateBillTotals();
      
      // Set payment state
      isBillModeActive = true;
      currentAmountStr = totals.grandTotal.toFixed(2);
      
      // Navigate DIRECTLY to QR display screen, bypassing bank selector view!
      window.location.hash = '#/qr';
    };
  }

  if (billWhatsappBtn) {
    billWhatsappBtn.onclick = () => {
      if (activeBillItems.length === 0) {
        alert('Please add at least one item to the bill first.');
        return;
      }
      
      let bank = activeSelectedBank;
      if (billBankSelect) {
        const selectedBankId = billBankSelect.value;
        bank = getBankById(selectedBankId) || CASH_PAYMENT;
      }
      if (!bank) bank = CASH_PAYMENT;
      
      const totals = calculateBillTotals();
      const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
      const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
      const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
      const discInputVal = parseFloat(billDiscountInput.value) || 0;
      
      const billData = {
        type: 'bill',
        invoiceNum: currentInvoiceNum,
        custName: custName,
        custPhone: custPhone,
        items: [...activeBillItems],
        discount: discInputVal,
        discountType: billDiscountType.value,
        grandTotal: totals.grandTotal,
        subtotal: totals.subtotal,
        savings: totals.savings,
        itemCount: totals.itemCount
      };
      
      const runBillShare = (finalName, finalPhone) => {
        billData.custName = finalName;
        billData.custPhone = finalPhone;
        const transactionNote = JSON.stringify(billData);
        
        shareReceiptAsImage(bank, billData);
        
        const nextInvoiceNum = parseInt(currentInvoiceNum) + 1;
        localStorage.setItem('pos_invoice_counter', nextInvoiceNum.toString());
        pushSettingsMetaToCloud();
        
        addTransaction(totals.grandTotal, bank, transactionNote, 'paid');
        clearActiveBill();
        window.location.hash = '#/pos';
      };
      
      if (custName === '-' || custPhone === '-') {
        showCustomerPromptModal(custName, custPhone, (finalName, finalPhone) => {
          // Update inputs in UI
          if (billCustNameInput && finalName !== '-') billCustNameInput.value = finalName;
          if (billCustPhoneInput && finalPhone !== '-') billCustPhoneInput.value = finalPhone;
          runBillShare(finalName, finalPhone);
        });
      } else {
        runBillShare(custName, custPhone);
      }
    };
  }

  if (billPrintBtn) {
    billPrintBtn.onclick = () => {
      if (activeBillItems.length === 0) {
        alert('Please add at least one item to the bill first.');
        return;
      }
      
      let bank = activeSelectedBank;
      if (billBankSelect) {
        const selectedBankId = billBankSelect.value;
        bank = getBankById(selectedBankId) || CASH_PAYMENT;
      }
      if (!bank) bank = CASH_PAYMENT;
      
      const totals = calculateBillTotals();
      const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
      const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
      const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
      const discInputVal = parseFloat(billDiscountInput.value) || 0;
      
      const billData = {
        type: 'bill',
        invoiceNum: currentInvoiceNum,
        custName: custName,
        custPhone: custPhone,
        items: [...activeBillItems],
        discount: discInputVal,
        discountType: billDiscountType.value,
        grandTotal: totals.grandTotal,
        subtotal: totals.subtotal,
        savings: totals.savings,
        itemCount: totals.itemCount
      };
      
      showPrintLayoutModal(bank, billData);
    };
  }

  if (qrWhatsappBtn) {
    qrWhatsappBtn.onclick = () => {
      const bank = activeSelectedBank || CASH_PAYMENT;
      const amount = parseFloat(currentAmountStr);
      const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
      
      let billData = null;
      if (isBillModeActive) {
        const totals = calculateBillTotals();
        const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
        const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
        const discInputVal = parseFloat(billDiscountInput.value) || 0;
        
        billData = {
          type: 'bill',
          invoiceNum: currentInvoiceNum,
          custName: custName,
          custPhone: custPhone,
          items: [...activeBillItems],
          discount: discInputVal,
          discountType: billDiscountType.value,
          grandTotal: totals.grandTotal,
          subtotal: totals.subtotal,
          savings: totals.savings,
          itemCount: totals.itemCount
        };
      } else {
        billData = {
          type: 'flat',
          invoiceNum: currentInvoiceNum,
          custName: '-',
          custPhone: '-',
          items: [{ name: 'TOTAL', qty: 1, price: amount }],
          discount: 0,
          discountType: 'flat',
          grandTotal: amount,
          subtotal: amount,
          savings: 0,
          itemCount: 1
        };
      }
      
      const runQrShare = (finalName, finalPhone) => {
        billData.custName = finalName;
        billData.custPhone = finalPhone;
        const transactionNote = JSON.stringify(billData);
        
        shareReceiptAsImage(bank, billData);
        
        const nextInvoiceNum = parseInt(currentInvoiceNum) + 1;
        localStorage.setItem('pos_invoice_counter', nextInvoiceNum.toString());
        pushSettingsMetaToCloud();
        
        addTransaction(billData.grandTotal, bank, transactionNote, 'paid');
        
        if (isBillModeActive) {
          clearActiveBill();
          isBillModeActive = false;
        }
        
        currentAmountStr = '0';
        activeSelectedBank = null;
        window.location.hash = '#/pos';
      };
      
      if (billData.custName === '-' || billData.custPhone === '-') {
        showCustomerPromptModal(billData.custName, billData.custPhone, (finalName, finalPhone) => {
          runQrShare(finalName, finalPhone);
        });
      } else {
        runQrShare(billData.custName, billData.custPhone);
      }
    };
  }

  if (qrPrintBtn) {
    qrPrintBtn.onclick = () => {
      const bank = activeSelectedBank || CASH_PAYMENT;
      const amount = parseFloat(currentAmountStr);
      const currentInvoiceNum = localStorage.getItem('pos_invoice_counter') || '1';
      
      let billData = null;
      if (isBillModeActive) {
        const totals = calculateBillTotals();
        const custName = (billCustNameInput && billCustNameInput.value.trim()) || '-';
        const custPhone = (billCustPhoneInput && billCustPhoneInput.value.trim()) || '-';
        const discInputVal = parseFloat(billDiscountInput.value) || 0;
        
        billData = {
          type: 'bill',
          invoiceNum: currentInvoiceNum,
          custName: custName,
          custPhone: custPhone,
          items: [...activeBillItems],
          discount: discInputVal,
          discountType: billDiscountType.value,
          grandTotal: totals.grandTotal,
          subtotal: totals.subtotal,
          savings: totals.savings,
          itemCount: totals.itemCount
        };
      } else {
        billData = {
          type: 'flat',
          invoiceNum: currentInvoiceNum,
          custName: '-',
          custPhone: '-',
          items: [{ name: 'TOTAL', qty: 1, price: amount }],
          discount: 0,
          discountType: 'flat',
          grandTotal: amount,
          subtotal: amount,
          savings: 0,
          itemCount: 1
        };
      }
      
      showPrintLayoutModal(bank, billData);
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

  // Bind real-time input event listener for dynamic search filtering
  if (filterSearchName) {
    filterSearchName.addEventListener('input', renderSalesLogs);
  }

  // --- Staff/Admin View Controller ---
  function updateSettingsViewMode() {
    const btnToggleStaff = document.getElementById('btn-toggle-staff');
    const btnToggleAdmin = document.getElementById('btn-toggle-admin');
    const btnLockAdmin = document.getElementById('btn-lock-admin');
    
    const cardSales = document.getElementById('settings-card-sales');
    const statsGrid = document.getElementById('settings-stats-grid');
    const cardProfile = document.getElementById('settings-card-profile');
    const cardBankEdit = document.getElementById('settings-card-bank-edit');
    const cardBankList = document.getElementById('settings-card-bank-list');
    const cardSync = document.getElementById('settings-card-sync');
    const cardSecurity = document.getElementById('settings-card-security');
    const deleteActions = document.querySelector('.history-delete-actions');
    
    if (isAdminModeActive) {
      if (btnToggleStaff) btnToggleStaff.classList.remove('active');
      if (btnToggleAdmin) btnToggleAdmin.classList.add('active');
      if (btnLockAdmin) btnLockAdmin.style.display = 'flex';
      
      if (statsGrid) statsGrid.style.display = 'grid';
      if (cardProfile) cardProfile.style.display = 'block';
      if (cardBankEdit) cardBankEdit.style.display = 'block';
      if (cardBankList) cardBankList.style.display = 'block';
      if (cardSync) cardSync.style.display = 'block';
      if (cardSecurity) cardSecurity.style.display = 'block';
      if (deleteActions) deleteActions.style.display = 'flex';
    } else {
      if (btnToggleStaff) btnToggleStaff.classList.add('active');
      if (btnToggleAdmin) btnToggleAdmin.classList.remove('active');
      if (btnLockAdmin) btnLockAdmin.style.display = 'none';
      
      if (statsGrid) statsGrid.style.display = 'none';
      if (cardProfile) cardProfile.style.display = 'none';
      if (cardBankEdit) cardBankEdit.style.display = 'none';
      if (cardBankList) cardBankList.style.display = 'none';
      if (cardSync) cardSync.style.display = 'none';
      if (cardSecurity) cardSecurity.style.display = 'none';
      if (deleteActions) deleteActions.style.display = 'none';
    }
    
    // Dynamically refresh sales logs to update masked bank names and delete actions
    renderSalesLogs();
  }

  // Bind settings toggle buttons
  const btnToggleStaff = document.getElementById('btn-toggle-staff');
  const btnToggleAdmin = document.getElementById('btn-toggle-admin');
  const btnLockAdmin = document.getElementById('btn-lock-admin');
  const adminPinModal = document.getElementById('admin-pin-modal');
  const btnPinCancel = document.getElementById('btn-pin-cancel');
  const btnPinClear = document.getElementById('btn-pin-clear');
  const pinDots = document.querySelectorAll('.pin-dot');
  const pinKeys = document.querySelectorAll('.pin-key[data-val]');

  // --- PIN Brute-Force lockout protection ---
  let pinLockoutTimer = null;
  function updatePinLockoutState() {
    const expiry = localStorage.getItem('pos_pin_lockout_expiry');
    const pinSubtitle = document.querySelector('#admin-pin-modal .pin-modal-subtitle');
    const pinLockIcon = document.querySelector('#admin-pin-modal .pin-modal-lock-icon');
    const pinTitle = document.querySelector('#admin-pin-modal .pin-modal-title');
    const keypadButtons = document.querySelectorAll('#admin-pin-modal .pin-key');

    if (expiry) {
      const remaining = Math.ceil((parseInt(expiry) - Date.now()) / 1000);
      if (remaining > 0) {
        // Locked Out!
        if (pinSubtitle) {
          pinSubtitle.textContent = `Too many failed attempts. Try again in ${remaining}s.`;
          pinSubtitle.style.color = '#ef4444';
        }
        if (pinLockIcon) pinLockIcon.textContent = '⏳';
        if (pinTitle) pinTitle.textContent = 'Keypad Locked';
        
        // Disable keys
        keypadButtons.forEach(btn => {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.3';
        });

        // Clear input
        enteredPin = '';
        resetPinDots();

        if (pinLockoutTimer) clearInterval(pinLockoutTimer);
        pinLockoutTimer = setInterval(() => {
          const currentRemaining = Math.ceil((parseInt(expiry) - Date.now()) / 1000);
          if (currentRemaining <= 0) {
            clearInterval(pinLockoutTimer);
            pinLockoutTimer = null;
            localStorage.removeItem('pos_pin_lockout_expiry');
            localStorage.removeItem('pos_pin_failed_attempts');
            
            // Restore active state
            if (pinSubtitle) {
              pinSubtitle.textContent = 'Access restricted to authorized personnel only.';
              pinSubtitle.style.color = 'var(--text-muted)';
            }
            if (pinLockIcon) pinLockIcon.textContent = '🔒';
            if (pinTitle) pinTitle.textContent = 'Enter Admin PIN';
            keypadButtons.forEach(btn => {
              btn.style.pointerEvents = 'auto';
              btn.style.opacity = '1';
            });
          } else {
            if (pinSubtitle) pinSubtitle.textContent = `Too many failed attempts. Try again in ${currentRemaining}s.`;
          }
        }, 1000);
        return true;
      }
    }
    
    // Not locked out (cleanup if expired)
    if (localStorage.getItem('pos_pin_lockout_expiry')) {
      localStorage.removeItem('pos_pin_lockout_expiry');
      localStorage.removeItem('pos_pin_failed_attempts');
    }
    return false;
  }

  // --- Synced Recovery Link Rate Limiting ---
  let recoveryCooldownTimer = null;
  function updateRecoveryLinkState() {
    const recoveryForgotLink = document.getElementById('recovery-forgot-password-link');
    if (!recoveryForgotLink) return;
    const expiry = localStorage.getItem('pos_recovery_cooldown_expiry');
    if (expiry) {
      const remaining = Math.ceil((parseInt(expiry) - Date.now()) / 1000);
      if (remaining > 0) {
        recoveryForgotLink.style.pointerEvents = 'none';
        recoveryForgotLink.style.opacity = '0.5';
        recoveryForgotLink.textContent = `Forgot cloud sync password? (Wait ${remaining}s)`;
        
        if (recoveryCooldownTimer) clearInterval(recoveryCooldownTimer);
        recoveryCooldownTimer = setInterval(() => {
          const currentRemaining = Math.ceil((parseInt(expiry) - Date.now()) / 1000);
          if (currentRemaining <= 0) {
            clearInterval(recoveryCooldownTimer);
            recoveryCooldownTimer = null;
            recoveryForgotLink.style.pointerEvents = 'auto';
            recoveryForgotLink.style.opacity = '1';
            recoveryForgotLink.textContent = 'Forgot cloud sync password?';
            localStorage.removeItem('pos_recovery_cooldown_expiry');
          } else {
            recoveryForgotLink.textContent = `Forgot cloud sync password? (Wait ${currentRemaining}s)`;
          }
        }, 1000);
        return;
      }
    }
    
    // Default active state
    recoveryForgotLink.style.pointerEvents = 'auto';
    recoveryForgotLink.style.opacity = '1';
    recoveryForgotLink.textContent = 'Forgot cloud sync password?';
  }

  if (btnToggleStaff) {
    btnToggleStaff.addEventListener('click', () => {
      isAdminModeActive = false;
      updateSettingsViewMode();
    });
  }

  if (btnToggleAdmin) {
    btnToggleAdmin.addEventListener('click', () => {
      if (isAdminModeActive) return;
      
      // Open Secure Indigo Pinpad modal
      if (adminPinModal) {
        adminPinModal.style.display = 'flex';
        enteredPin = '';
        resetPinDots();
        updatePinLockoutState();
      }
    });
  }

  if (btnLockAdmin) {
    btnLockAdmin.addEventListener('click', () => {
      isAdminModeActive = false;
      updateSettingsViewMode();
    });
  }

  function handlePinInput(val) {
    // Prevent entry if locked out
    if (localStorage.getItem('pos_pin_lockout_expiry')) {
      const expiry = parseInt(localStorage.getItem('pos_pin_lockout_expiry'));
      if (expiry > Date.now()) {
        return;
      }
    }

    if (enteredPin.length < 4) {
      enteredPin += val;
      updatePinDots();
      
      if (enteredPin.length === 4) {
        const correctPin = localStorage.getItem('pos_admin_pin') || '1234';
        if (enteredPin === correctPin) {
          isAdminModeActive = true;
          localStorage.removeItem('pos_pin_failed_attempts');
          localStorage.removeItem('pos_pin_lockout_expiry');
          setTimeout(() => {
            if (adminPinModal) adminPinModal.style.display = 'none';
            updateSettingsViewMode();
          }, 200);
        } else {
          // Increment failed attempts
          let failed = parseInt(localStorage.getItem('pos_pin_failed_attempts') || '0');
          failed++;
          localStorage.setItem('pos_pin_failed_attempts', failed.toString());
          
          if (failed >= 5) {
            // Trigger 30-second lockout
            localStorage.setItem('pos_pin_lockout_expiry', (Date.now() + 30000).toString());
            updatePinLockoutState();
          } else {
            // Flash error dots
            pinDots.forEach(dot => dot.classList.add('error'));
            setTimeout(() => {
              enteredPin = '';
              resetPinDots();
            }, 600);
          }
        }
      }
    }
  }

  function handlePinDelete() {
    if (localStorage.getItem('pos_pin_lockout_expiry')) {
      const expiry = parseInt(localStorage.getItem('pos_pin_lockout_expiry'));
      if (expiry > Date.now()) return;
    }
    if (enteredPin.length > 0) {
      enteredPin = enteredPin.slice(0, -1);
      updatePinDots();
    }
  }

  function handlePinCancel() {
    if (adminPinModal) adminPinModal.style.display = 'none';
    enteredPin = '';
    updateSettingsViewMode(); // Keep staff mode visually active
  }

  if (btnPinCancel) {
    btnPinCancel.addEventListener('click', handlePinCancel);
  }

  if (btnPinClear) {
    btnPinClear.addEventListener('click', handlePinDelete);
  }

  pinKeys.forEach(key => {
    key.addEventListener('click', () => {
      const val = key.getAttribute('data-val');
      handlePinInput(val);
    });
  });

  // laptop physical keyboard entry mapping
  document.addEventListener('keydown', (e) => {
    if (adminPinModal && adminPinModal.style.display === 'flex') {
      // Check lockout first
      if (localStorage.getItem('pos_pin_lockout_expiry')) {
        const expiry = parseInt(localStorage.getItem('pos_pin_lockout_expiry'));
        if (expiry > Date.now()) {
          e.preventDefault();
          return;
        }
      }
      
      const key = e.key;
      if (/^[0-9]$/.test(key)) {
        e.preventDefault();
        handlePinInput(key);
      } else if (key === 'Backspace') {
        e.preventDefault();
        handlePinDelete();
      } else if (key === 'Escape') {
        e.preventDefault();
        handlePinCancel();
      }
    }
  });

  // Recovery Custom Modals
  const pinRecoveryModal = document.getElementById('pin-recovery-modal');
  const pinOfflineModal = document.getElementById('pin-offline-modal');

  // Synced recovery step elements
  const recoveryStepVerify = document.getElementById('recovery-step-verify');
  const recoveryStepNewPin = document.getElementById('recovery-step-newpin');
  const recoveryPasswordInput = document.getElementById('recovery-password-input');
  const recoveryForgotLink = document.getElementById('recovery-forgot-password-link');
  const recoveryCancelBtn = document.getElementById('recovery-cancel-btn');
  const recoveryVerifyBtn = document.getElementById('recovery-verify-btn');
  const recoveryNewPinInput = document.getElementById('recovery-newpin-input');
  const recoveryNewPinCancelBtn = document.getElementById('recovery-newpin-cancel-btn');
  const recoveryNewPinSaveBtn = document.getElementById('recovery-newpin-save-btn');
  const recoveryModalSubtitle = document.getElementById('recovery-modal-subtitle');

  // Offline recovery elements
  const offlineCancelBtn = document.getElementById('offline-cancel-btn');
  const offlineResetBtn = document.getElementById('offline-reset-btn');

  const btnPinForgot = document.getElementById('btn-pin-forgot');
  if (btnPinForgot) {
    btnPinForgot.addEventListener('click', (e) => {
      e.preventDefault();
      
      // If user is signed in to cloud sync, recover using Supabase password verification or email recovery!
      if (userSession && userSession.user) {
        if (adminPinModal) adminPinModal.style.display = 'none';
        
        // Reset states to Step 1
        if (recoveryPasswordInput) recoveryPasswordInput.value = '';
        if (recoveryNewPinInput) recoveryNewPinInput.value = '';
        if (recoveryStepVerify) recoveryStepVerify.style.display = 'flex';
        if (recoveryStepNewPin) recoveryStepNewPin.style.display = 'none';
        if (recoveryModalSubtitle) recoveryModalSubtitle.textContent = 'Verify your identity to choose a new PIN.';
        
        if (pinRecoveryModal) {
          pinRecoveryModal.style.display = 'flex';
          updateRecoveryLinkState(); // Run the link rate limit check on open
          if (recoveryPasswordInput) recoveryPasswordInput.focus();
        }
      } else {
        if (adminPinModal) adminPinModal.style.display = 'none';
        if (pinOfflineModal) pinOfflineModal.style.display = 'flex';
      }
    });
  }

  // --- Synced Recovery Modal Event Handlers ---
  if (recoveryCancelBtn) {
    recoveryCancelBtn.addEventListener('click', () => {
      if (pinRecoveryModal) pinRecoveryModal.style.display = 'none';
      if (adminPinModal) adminPinModal.style.display = 'flex';
    });
  }

  if (recoveryNewPinCancelBtn) {
    recoveryNewPinCancelBtn.addEventListener('click', () => {
      if (pinRecoveryModal) pinRecoveryModal.style.display = 'none';
      if (adminPinModal) adminPinModal.style.display = 'flex';
    });
  }

  if (recoveryForgotLink) {
    recoveryForgotLink.addEventListener('click', async (e) => {
      e.preventDefault();
      
      // Cooldown checks
      const expiry = localStorage.getItem('pos_recovery_cooldown_expiry');
      if (expiry && parseInt(expiry) > Date.now()) return;

      try {
        if (!supabase) {
          alert('Supabase database sync is not initialized!');
          return;
        }
        
        const resetRedirectUrl = window.location.origin + window.location.pathname + '#/reset-password';
        console.log('[Forgot PIN] Recover email redirect:', resetRedirectUrl);
        
        const { error } = await supabase.auth.resetPasswordForEmail(userSession.user.email, {
          redirectTo: resetRedirectUrl
        });
        
        if (error) {
          alert('Error sending recovery email: ' + error.message);
        } else {
          // Set client-side 1-minute cooldown
          localStorage.setItem('pos_recovery_cooldown_expiry', (Date.now() + 60000).toString());
          updateRecoveryLinkState();
          alert('Recovery email sent! Please check your inbox for the link to reset your cloud password and local PIN.');
          if (pinRecoveryModal) pinRecoveryModal.style.display = 'none';
        }
      } catch (err) {
        console.error('[Forgot PIN] Recovery email dispatch exception:', err);
        alert('An unexpected error occurred during password recovery.');
      }
    });
  }

  const handleCloudVerify = async () => {
    const password = recoveryPasswordInput ? recoveryPasswordInput.value.trim() : '';
    if (!password) {
      alert('Password cannot be empty!');
      return;
    }

    try {
      if (!supabase) {
        alert('Supabase database sync is not initialized!');
        return;
      }
      
      const { error } = await supabase.auth.signInWithPassword({
        email: userSession.user.email,
        password: password
      });
      
      if (error) {
        alert('Incorrect cloud password! PIN reset denied. ' + error.message);
      } else {
        // Transition to Step 2: Choose PIN
        if (recoveryStepVerify) recoveryStepVerify.style.display = 'none';
        if (recoveryStepNewPin) recoveryStepNewPin.style.display = 'flex';
        if (recoveryModalSubtitle) recoveryModalSubtitle.textContent = 'Enter a new 4-digit Admin PIN';
        if (recoveryNewPinInput) {
          recoveryNewPinInput.value = '';
          recoveryNewPinInput.focus();
        }
      }
    } catch (err) {
      console.error('[Forgot PIN] verification exception:', err);
      alert('An unexpected error occurred during password verification.');
    }
  };

  if (recoveryVerifyBtn) {
    recoveryVerifyBtn.addEventListener('click', handleCloudVerify);
  }

  if (recoveryPasswordInput) {
    recoveryPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCloudVerify();
      }
    });
  }

  const handleSaveNewPin = () => {
    const newPin = recoveryNewPinInput ? recoveryNewPinInput.value.trim() : '';
    if (!/^\d{4}$/.test(newPin)) {
      alert('PIN must be exactly 4 digits!');
      return;
    }

    localStorage.setItem('pos_admin_pin', newPin);
    alert('Admin PIN updated successfully!');
    
    if (pinRecoveryModal) pinRecoveryModal.style.display = 'none';
    enteredPin = '';
    isAdminModeActive = true; // Auto-unlock on success!
    updateSettingsViewMode();
  };

  if (recoveryNewPinSaveBtn) {
    recoveryNewPinSaveBtn.addEventListener('click', handleSaveNewPin);
  }

  if (recoveryNewPinInput) {
    recoveryNewPinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveNewPin();
      }
    });
  }

  // --- Offline Recovery Modal Event Handlers ---
  if (offlineCancelBtn) {
    offlineCancelBtn.addEventListener('click', () => {
      if (pinOfflineModal) pinOfflineModal.style.display = 'none';
      if (adminPinModal) adminPinModal.style.display = 'flex';
    });
  }

  if (offlineResetBtn) {
    offlineResetBtn.addEventListener('click', () => {
      localStorage.setItem('pos_banks', JSON.stringify(DEFAULT_BANKS));
      localStorage.setItem('pos_history', JSON.stringify([]));
      localStorage.setItem('pos_merchant', JSON.stringify(DEFAULT_MERCHANT));
      localStorage.setItem('pos_invoice_counter', '1');
      localStorage.setItem('pos_admin_pin', '1234');
      
      bankAccounts = DEFAULT_BANKS;
      transactionHistory = [];
      merchantProfile = DEFAULT_MERCHANT;
      
      alert("Device successfully reset to defaults. Admin PIN passcode is reset to '1234'.");
      window.location.reload();
    });
  }

  function resetPinDots() {
    pinDots.forEach(dot => {
      dot.classList.remove('filled');
      dot.classList.remove('error');
    });
  }

  function updatePinDots() {
    resetPinDots();
    for (let i = 0; i < enteredPin.length; i++) {
      if (pinDots[i]) pinDots[i].classList.add('filled');
    }
  }

  // --- Account Security Credentials Save Listeners ---
  const saveSecurityPinBtn = document.getElementById('save-security-pin-btn');
  const securityPinInput = document.getElementById('settings-security-pin');
  
  if (saveSecurityPinBtn && securityPinInput) {
    saveSecurityPinBtn.addEventListener('click', () => {
      const newPin = securityPinInput.value.trim();
      if (!/^\d{4}$/.test(newPin)) {
        alert('PIN must be exactly 4 digits!');
        return;
      }
      localStorage.setItem('pos_admin_pin', newPin);
      alert('Admin PIN updated successfully!');
      securityPinInput.value = '';
    });
  }

  const saveSecurityPasswordBtn = document.getElementById('save-security-password-btn');
  const securityPasswordInput = document.getElementById('settings-security-password');
  
  if (saveSecurityPasswordBtn && securityPasswordInput) {
    saveSecurityPasswordBtn.addEventListener('click', async () => {
      const newPassword = securityPasswordInput.value.trim();
      if (newPassword.length < 6) {
        alert('Password must be at least 6 characters long!');
        return;
      }
      
      saveSecurityPasswordBtn.disabled = true;
      saveSecurityPasswordBtn.innerText = 'Updating password...';
      
      try {
        if (!supabase) {
          alert('Supabase database sync is not initialized!');
          saveSecurityPasswordBtn.disabled = false;
          saveSecurityPasswordBtn.innerText = 'Update Cloud Password';
          return;
        }
        
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) {
          alert('Error updating password: ' + error.message);
        } else {
          alert('Cloud sync password updated successfully!');
          securityPasswordInput.value = '';
        }
      } catch (err) {
        console.error('Password update exception:', err);
        alert('An unexpected error occurred during password update.');
      } finally {
        saveSecurityPasswordBtn.disabled = false;
        saveSecurityPasswordBtn.innerText = 'Update Cloud Password';
      }
    });
  }

  // Password Recovery & Reset View Controller
  function initResetPasswordView() {
    const newPwd = document.getElementById('reset-new-password');
    const confPwd = document.getElementById('reset-confirm-password');
    if (newPwd) newPwd.value = '';
    if (confPwd) confPwd.value = '';
  }

  // Bind Forgot Password email dispatcher inside settings sync card
  const btnSyncForgotPassword = document.getElementById('btn-sync-forgot-password');
  if (btnSyncForgotPassword) {
    btnSyncForgotPassword.addEventListener('click', async (e) => {
      e.preventDefault();
      
      const authEmail = document.getElementById('settings-auth-email');
      const defaultEmail = authEmail ? authEmail.value.trim() : '';
      const emailInput = prompt('Enter your Cloud Sync Account Email to receive a secure password recovery link:', defaultEmail);
      
      if (emailInput === null) return; // User cancelled
      if (emailInput.trim() === '') {
        alert('Email address cannot be empty!');
        return;
      }
      
      btnSyncForgotPassword.innerText = 'Sending email...';
      btnSyncForgotPassword.style.pointerEvents = 'none';
      
      try {
        if (!supabase) {
          alert('Supabase database sync is not initialized!');
          btnSyncForgotPassword.innerText = 'Forgot Password?';
          btnSyncForgotPassword.style.pointerEvents = 'auto';
          return;
        }
        
        const resetRedirectUrl = window.location.origin + window.location.pathname + '#/reset-password';
        console.log('[Supabase Auth] Reset password redirect link configured:', resetRedirectUrl);
        
        const { error } = await supabase.auth.resetPasswordForEmail(emailInput.trim(), {
          redirectTo: resetRedirectUrl
        });
        
        if (error) {
          alert('Error sending recovery email: ' + error.message);
        } else {
          alert('Secure password recovery email sent successfully! Please check your inbox for the link.');
        }
      } catch (err) {
        console.error('[Forgot Password] exception:', err);
        alert('An unexpected error occurred during password recovery.');
      } finally {
        btnSyncForgotPassword.innerText = 'Forgot Password?';
        btnSyncForgotPassword.style.pointerEvents = 'auto';
      }
    });
  }

  // Bind password reset form handler inside Reset Password view
  const btnResetPassword = document.getElementById('reset-password-btn');
  if (btnResetPassword) {
    btnResetPassword.addEventListener('click', async () => {
      const newPwdInput = document.getElementById('reset-new-password');
      const confPwdInput = document.getElementById('reset-confirm-password');
      
      if (!newPwdInput || !confPwdInput) return;
      
      const newPassword = newPwdInput.value.trim();
      const confirmPassword = confPwdInput.value.trim();
      
      if (newPassword.length < 6) {
        alert('Password must be at least 6 characters long!');
        return;
      }
      
      if (newPassword !== confirmPassword) {
        alert('Passwords do not match! Please check your input.');
        return;
      }
      
      btnResetPassword.disabled = true;
      btnResetPassword.innerText = 'Saving password...';
      
      try {
        if (!supabase) {
          alert('Supabase database sync is not initialized!');
          btnResetPassword.disabled = false;
          btnResetPassword.innerText = 'Save Password & Login';
          return;
        }
        
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        
        if (error) {
          alert('Error updating password: ' + error.message);
        } else {
          // Reset local PIN passcode back to default '1234' on successful recovery reset
          localStorage.setItem('pos_admin_pin', '1234');
          
          alert('Cloud sync password updated successfully, and your local Admin PIN has been reset to \'1234\'!\n\nRedirecting you to Settings...');
          
          // Clear inputs
          newPwdInput.value = '';
          confPwdInput.value = '';
          
          // Redirect user to settings screen where they can unlock using '1234'
          window.location.hash = '#/settings';
        }
      } catch (err) {
        console.error('[Reset Password] exception:', err);
        alert('An unexpected error occurred during password reset.');
      } finally {
        btnResetPassword.disabled = false;
        btnResetPassword.innerText = 'Save Password & Login';
      }
    });
  }

  window.addEventListener('online', processSyncQueue); // Queue worker hook
});
