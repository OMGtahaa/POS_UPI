# Security Policy — POS UPI Terminal

This security policy outlines data safety requirements, client credentials handling, brute-force defense parameters, and instructions on configuring **Supabase Row Level Security (RLS)** policies to ensure your public database connection is highly secure.

---

## 1. Frontend Client Credentials Architecture

By design, this application is a serverless Single Page Web Application (SPA) deployed fully client-side. 
* The **Supabase URL** and **Supabase Anonymous Key** (`anon`) are client credentials built directly into `js/app.js`.
* **Important**: Anonymous keys are secure to distribute publicly *only* when database-level access controls are correctly enforced via Row Level Security (RLS). They restrict access strictly to database tables without giving administrative bypass access.

---

## 2. Supabase Row Level Security (RLS) Policy Guide

To prevent unauthorized read/write requests, you **must enable Row Level Security (RLS)** on all tables in your Supabase dashboard. Use the SQL Editor inside your Supabase dashboard to execute the following security rules:

### A. Enable RLS on all Tables
```sql
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_profiles ENABLE ROW LEVEL SECURITY;
```

### B. Setup User Isolation Policies (Standard templates)
Each authenticated user must only read, create, update, or delete records that belong to their specific authenticated identity:

#### 1. Bank Accounts Isolation
```sql
-- Select: Allow users to read their own bank accounts
CREATE POLICY "Allow individual select" ON bank_accounts 
    FOR SELECT USING (auth.uid() = user_id);

-- Insert: Allow users to insert their own bank accounts
CREATE POLICY "Allow individual insert" ON bank_accounts 
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Update: Allow users to edit their own bank accounts
CREATE POLICY "Allow individual update" ON bank_accounts 
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Delete: Allow users to remove their own bank accounts
CREATE POLICY "Allow individual delete" ON bank_accounts 
    FOR DELETE USING (auth.uid() = user_id);
```

#### 2. Sales History Isolation
```sql
CREATE POLICY "Allow individual select" ON sales_history 
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Allow individual insert" ON sales_history 
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow individual update" ON sales_history 
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow individual delete" ON sales_history 
    FOR DELETE USING (auth.uid() = user_id);
```

---

## 3. Server-Side Authentication Rate Limiting

To prevent automated scripts from spamming password reset emails, you must configure rate limits in your Supabase console:
1. Log in to your **Supabase Dashboard**.
2. Navigate to **Project Settings** -> **Authentication**.
3. Under the **Security & Rate Limits** section:
   * **Max Emails per Hour**: Set to `3` or `5` (default is usually 30).
   * **SMS/Email Rate Limits**: Enable brute-force lockout rules.
   * **Confirm Email**: Enable this if you require staff/admin sign-ups to confirm ownership first.

---

## 4. Reporting a Security Vulnerability

If you discover a security vulnerability in this project:
1. **Do not create a public GitHub Issue** to report a security bug.
2. Please send a detailed security report outlining reproduction steps directly to the repository maintainer.
3. We will review, patch, and release a resolution within 48 hours.
