/* ==========================================================================
   POS UPI PAY TERMINAL - SIMPLIFIED CORE LOGIC WITH REALTIME SYNC & LOGS
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // --- Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=7')
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
  }

  // --- State Variables ---
  let currentAmountStr = '0'; // Raw string entered on keypad
  let activeSelectedBank = null; // Currently chosen bank for QR generation
  let activeEditBankId = null;
  let activeCardColor = 'card-color-hdfc';
  
  // Default Seed Data for Bank Accounts
  const DEFAULT_BANKS = [
    { id: '1', name: 'HDFC Bank', upiId: 'merchant@okhdfcbank', holderName: 'POS MERCHANT', color: 'card-color-hdfc' },
    { id: '2', name: 'State Bank of India', upiId: 'merchant@oksbi', holderName: 'POS MERCHANT', color: 'card-color-sbi' },
    { id: '3', name: 'ICICI Bank', upiId: 'merchant@okicici', holderName: 'POS MERCHANT', color: 'card-color-icici' }
  ];

  // Default Seed Data for Merchant Settings (Telegram is fully automated now)
  const DEFAULT_MERCHANT = {
    name: 'POS Merchant'
  };

  // State loaded from LocalStorage
  let bankAccounts = JSON.parse(localStorage.getItem('pos_banks')) || DEFAULT_BANKS;
  let merchantProfile = JSON.parse(localStorage.getItem('pos_merchant')) || DEFAULT_MERCHANT;
  let transactionHistory = JSON.parse(localStorage.getItem('pos_history')) || [];

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
    '#/settings': document.getElementById('view-settings')
  };

  const amountDisplay = document.getElementById('pos-amount-val');
  const keypad = document.getElementById('pos-keypad');

  // POS Header Sync Elements
  const headerSyncIndicator = document.getElementById('header-sync-indicator');
  const syncIndicatorText = document.getElementById('sync-indicator-text');
  

  
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
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  
  let currentQr = null; // QRious QR code instance

  // ==========================================================================
  // HASH-BASED ROUTER
  // ==========================================================================
  function router() {
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
      updateAmountDisplay();
    } else if (hash === '#/select-bank') {
      initBankSelectorView();
    } else if (hash === '#/qr') {
      initQRView();
    } else if (hash === '#/settings') {
      initSettingsView();
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
            await pullCloudDatabase();
            subscribeRealtimeSync();
            processSyncQueue();
          } else {
            console.log('[Supabase Auth] User signed out');
            if (authFormLoggedOut) authFormLoggedOut.style.display = 'block';
            if (authFormLoggedIn) authFormLoggedIn.style.display = 'none';
            if (loggedInEmailDisplay) loggedInEmailDisplay.value = '';
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
    
    try {
      // 1. Pull Banks
      const { data: cloudBanks, error: banksError } = await supabase
        .from('pos_banks')
        .select('*');
        
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
      const { data: cloudHistory, error: historyError } = await supabase
        .from('pos_history')
        .select('*')
        .order('timestamp', { ascending: false });
        
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
    }
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
    
    // Attempt processing
    processSyncQueue();
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

    console.log(`[Sync Queue] Processing ${queue.length} pending task(s)...`);

    while (queue.length > 0) {
      const task = queue[0];
      try {
        let success = false;
        
        if (task.table === 'pos_banks') {
          if (task.action === 'delete') {
            const { error } = await supabase
              .from('pos_banks')
              .delete()
              .eq('id', task.payload.id);
            if (!error) success = true;
            else console.error('[Sync Queue] Bank delete error:', error);
          } else {
            const { error } = await supabase
              .from('pos_banks')
              .upsert({
                id: task.payload.id,
                name: task.payload.name,
                upi_id: task.payload.upiId,
                holder_name: task.payload.holderName,
                color: task.payload.color,
                user_id: userSession.user.id
              });
            if (!error) success = true;
            else console.error('[Sync Queue] Bank upsert error:', error);
          }
        } else if (task.table === 'pos_history') {
          if (task.action === 'delete') {
            const { error } = await supabase
              .from('pos_history')
              .delete()
              .eq('id', task.payload.id);
            if (!error) success = true;
            else console.error('[Sync Queue] Transaction delete error:', error);
          } else {
            const { error } = await supabase
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
              });
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

    isProcessingQueue = false;
    
    const finalQueue = JSON.parse(localStorage.getItem('pos_sync_queue')) || [];
    if (finalQueue.length === 0) {
      updateSyncStatusUI('online');
    } else {
      updateSyncStatusUI('connecting');
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
      renderBankSwiper();
    } else if (screenKey === '#/settings') {
      loadSettingsForms();
    } else if (screenKey === '#/select-bank') {
      initBankSelectorView();
    } else if (screenKey === '#/qr') {
      initQRView();
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

    // Trigger save on manual confirmation click
    qrConfirmPaidBtn.onclick = () => {
      let transactionNote = 'POS' + Math.floor(Math.random() * 1000000);
      addTransaction(amount, activeSelectedBank, transactionNote, 'paid');
      
      // Reset values & redirect
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
        <div class="history-item-right">
          <div class="history-item-amt">${formattedAmt}</div>
          <span class="status-badge status-badge-paid">${tx.status}</span>
        </div>
      `;

      historyListContainer.appendChild(item);
    });
  }

  // Bind change listeners to reporting filters
  filterFy.addEventListener('change', renderSalesLogs);
  filterMonth.addEventListener('change', renderSalesLogs);

  // Clear logs histories
  clearHistoryBtn.addEventListener('click', () => {
    if (transactionHistory.length === 0) return;
    
    if (confirm('Are you sure you want to clear ALL transaction history logs? This will delete them from the cloud database too!')) {
      // Add delete jobs for all active transactions to sync queue
      transactionHistory.forEach(tx => {
        enqueueSyncTask('pos_history', 'delete', tx);
      });

      transactionHistory = [];
      localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
      renderSalesLogs();
    }
  });

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
      
      if (confirm('Are you sure you want to sign out of Cloud Sync? Local backup will be preserved.')) {
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
  initSupabase(); // Load sync connections
  window.addEventListener('online', processSyncQueue); // Queue worker hook
  updateAmountDisplay();
  switchScreen('#/pos'); // Load main POS interface
});
