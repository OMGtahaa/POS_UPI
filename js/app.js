/* ==========================================================================
   POS UPI PAY TERMINAL - SIMPLIFIED CORE LOGIC WITH HASH ROUTING
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // --- Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
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

  // Default Seed Data for Merchant Settings (Telegram removed)
  const DEFAULT_MERCHANT = {
    name: 'POS Merchant'
  };

  // State loaded from LocalStorage
  let bankAccounts = JSON.parse(localStorage.getItem('pos_banks')) || DEFAULT_BANKS;
  let merchantProfile = JSON.parse(localStorage.getItem('pos_merchant')) || DEFAULT_MERCHANT;
  let transactionHistory = JSON.parse(localStorage.getItem('pos_history')) || [];

  // If local storage is empty, initialize it
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
  
  // Sales Log inside Settings Elements
  const historyListContainer = document.getElementById('history-list-container');
  const statsTotalVal = document.getElementById('stats-total-val');
  const statsCountVal = document.getElementById('stats-count-val');
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

  // Bind hashchange listener to handle back buttons and state shifts
  window.addEventListener('hashchange', router);
  
  // Set default hash on start
  if (!window.location.hash) {
    window.location.hash = '#/pos';
  } else {
    router(); // Trigger router on reload if hash exists
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
      // Append period if no decimal point exists
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
            // Already has 2 decimals, ignore new numbers
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
    // Mandatory fields:
    // pa = Payee UPI VPA
    // pn = Payee Name
    // am = Amount
    // cu = Currency (INR)
    // NOTE: We omit 'tn' (notes) and 'tr' (ref) because P2P personal VPAs throw 
    // "payment mode error" on Google Pay & PhonePe when dynamic business fields are present.
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
        level: 'M', // Medium error correction is best for speed and scanning reliability
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
  }

  // ==========================================================================
  // SETTINGS & LOGS VIEW LOGIC (CONSOLIDATED HUB)
  // ==========================================================================
  function initSettingsView() {
    // Load profile
    merchantNameInput.value = merchantProfile.name;
    
    // Clear forms & re-render lists
    resetBankForm();
    renderSavedBanksList();
    renderSalesLogs();
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
  saveBankBtn.addEventListener('click', () => {
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

    if (activeEditBankId) {
      // Edit Account details
      bankAccounts = bankAccounts.map(bank => {
        if (bank.id === activeEditBankId) {
          return { id: activeEditBankId, name, upiId, holderName, color: activeCardColor };
        }
        return bank;
      });
      activeEditBankId = null;
    } else {
      // Add new account
      const newBank = {
        id: 'bank_' + Date.now(),
        name,
        upiId,
        holderName,
        color: activeCardColor
      };
      bankAccounts.push(newBank);
    }

    localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
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
          
          // Scroll and focus on forms
          bankNameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          bankNameInput.focus();
        }
      });

      // Bind delete triggers
      row.querySelector('.bank-item-btn-delete').addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.id;
        if (confirm('Are you sure you want to delete this bank account?')) {
          bankAccounts = bankAccounts.filter(b => b.id !== id);
          localStorage.setItem('pos_banks', JSON.stringify(bankAccounts));
          renderSavedBanksList();
        }
      });

      savedBanksListContainer.appendChild(row);
    });
  }

  // Render sales logs inside settings screen (Category 1)
  function renderSalesLogs() {
    historyListContainer.innerHTML = '';

    // Calculate sum metrics
    let totalSales = 0;
    transactionHistory.forEach(tx => {
      if (tx.status === 'paid') {
        totalSales += parseFloat(tx.amount);
      }
    });

    statsTotalVal.innerText = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2
    }).format(totalSales);

    statsCountVal.innerText = transactionHistory.length;

    if (transactionHistory.length === 0) {
      historyListContainer.innerHTML = `<div class="no-history-prompt">No transaction logs recorded.</div>`;
      return;
    }

    transactionHistory.forEach(tx => {
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

  // Clear logs histories
  clearHistoryBtn.addEventListener('click', () => {
    if (transactionHistory.length === 0) return;
    
    if (confirm('Are you sure you want to clear ALL transaction history logs? This cannot be undone.')) {
      transactionHistory = [];
      localStorage.setItem('pos_history', JSON.stringify(transactionHistory));
      renderSalesLogs();
    }
  });

});
