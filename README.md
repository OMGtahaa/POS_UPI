# POS UPI Terminal

An offline-first Point of Sale terminal that generates UPI QR codes for instant merchant payments. Built as a Progressive Web App — works without internet, syncs when connected.

## Features

- **Instant QR Generation** — Enter an amount, select a bank, get a scannable UPI QR code
- **Bill Maker** — Create itemized bills with customer details, discounts, and invoice tracking
- **Multi-Bank Support** — Configure multiple bank accounts with different UPI IDs
- **Cloud Sync** — Optional Supabase sync to keep data across devices
- **Offline First** — Full functionality without internet via Service Worker caching
- **Sales Log** — Track all transactions with filtering by date, financial year, and search
- **WhatsApp Receipts** — Share payment receipts directly to customers via WhatsApp
- **Cash Payments** — Record cash transactions alongside digital payments
- **Staff / Admin Mode** — PIN-protected admin settings to restrict staff access

## Tech Stack

- Vanilla HTML, CSS, JavaScript — no frameworks, no build tools
- [Supabase](https://supabase.com) for auth and real-time database sync
- [QRious](https://github.com/neocotic/qrious) for QR code generation
- Service Worker for offline caching (PWA)

## Setup

1. Clone the repo
2. Serve the files with any static server (or just open `index.html`)
3. For cloud sync, create a [Supabase](https://supabase.com) project and update the URL and anon key in `js/app.js`
4. Enable Row Level Security on your Supabase tables

## Usage

1. Open the app on any device
2. Enter the payment amount on the POS keypad
3. Select the receiving bank account
4. Show the generated QR code to the customer
5. Confirm payment and log the transaction

## License

MIT
