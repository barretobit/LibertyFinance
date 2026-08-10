# 💰 LIBERTY FINANCE

> **Wealth Management System** — Track, manage and forecast your entire financial life from one place, with a slick retro-inspired dark UI. 🎮

Liberty Finance is a **personal wealth management application** that combines a lightweight **Windows desktop shell** with a modern **web-based dashboard**. It covers everything from cash and investments to precious metals, tangible assets, debts, income, expenses, savings goals and currency-aware net worth — all with zero cloud dependency.

Current version: **v0.9** · Themed "Liberty City Network" 🌆

---

## ✨ Features

### 🖥️ Multi-Profile Management

- Create and manage **multiple independent data profiles** (e.g. personal, business, family) 🗂️
- Every profile lives in its own local file — switch between them freely
- One-click **export** to a JSON backup file and **import**/restore from any backup 📦
- Automatic **data backups** created on every app launch 🔄

### 📊 Dashboard

- **Net Worth** — the total value of everything you own, in your main currency 💵
- **Liquid Net Worth** — net worth excluding long-term/non-liquid holdings 🧊
- **Investment Performance** — computed over **YTD, 1Y, 2Y, 3Y and MAX** timeframes 📈
- **Performance Over Time** chart with selectable date ranges 📉
- **Portfolio Allocation** breakdown across your portfolios 🥧
- **Earning Performance** — your last 12 months of income, savings and investment performance in a carousel 📊
- **Yearly Performance** — net worth, liquid net worth, growth and management performance per year (last 5) 🗓️
- **Goals overview** with live waterfall allocation across funding accounts 🎯
- **Forecast** — a 12-month projection based on historical monthly ROI, with pessimistic / neutral / optimistic scenarios 🔮
- **Recent Transactions** feed for quick review 🧾

### 🗂️ Portfolios & Accounts

- Organize accounts into **portfolios** (e.g. Retirement, Growth, Emergency)
- Five account types: **Cash**, **Investment**, **Retirement Fund**, **Tangible Asset**, **Precious Metal** 🏦
- Per-account **currency**, **custodian**, **starting value & date**
- Manage your **custodians** (banks, brokers, vaults) on a dedicated page 🏦
- Granular toggles: include in **performance chart**, **net worth** and **liquid net worth** ⚙️
- Track **deposits, withdrawals and valuations** with a full **transaction history** (including running balance) 🧮
- **Realized & unrealized P&L** and **cost basis** per account

### 🥇 Precious Metals

- Gold, Silver, Platinum and Palladium, tracked in **grams** ⚖️
- Buy / Sell metal with **price per gram**, auto-calculated totals
- **Average-cost basis** accounting across buys and sells
- Quantity, current price and unrealized P&L shown per metal account
- **Live spot prices** page: one-click fetch of today's XAU/XAG/XPT/XPD prices (CHF/oz & CHF/g), stored per date 📈

### 💎 Tangible Assets

- Track valuables like cars, watches or furniture 🛋️
- **Straight-line depreciation** per year (negative % = appreciation)
- Sell assets and track **realized P&L**

### 💵 Incomes & Expenses

- **Incomes**: source, amount, currency and date — with **average monthly** and **total net income** per year
- **Expenses**: monthly or yearly, per-year breakdown with **annual cost** calculations 🧾

### 🧾 Debts

- Track what you **owe** and what is **owed to you** 🪙
- Description, person, direction, amount, date and notes

### 🎯 Goals

- Set **target values** with **priority ordering** (drag reordering via Up/Down)
- Allocate funding from specific accounts with **contribution percentages**
- **Waterfall funding engine**: available balance is claimed by goals in priority order automatically ⛲
- Live progress bars with "SHORT BY / EXCEED BY / TARGET REACHED" status

### 💱 Exchange Rates

- Fully **date-based**: rates are stored per day, so historical values convert correctly 🗓️
- Currency conversion for all amounts into your **main currency** (CHF/EUR/USD/GBP/JPY)
- **Auto-fill** from the free **Frankfurter API** with one click (only foreign currencies actually used are fetched) 🔄
- **Startup sync**: today's FX snapshot is silently refreshed for the currencies your accounts actually use
- Manual save of rates for any date

### 🛡️ Reliability

- **Self-update**: the desktop app checks the GitHub repo on launch and downloads the latest web assets automatically 🔄
- **Crash logging** to a local `Logs` folder
- Embedded server gracefully falls back to a free port if **8765** is busy

---

## 🔒 100% LOCAL & OFFLINE — Your Data Never Leaves Your Machine

This is the core promise of Liberty Finance:

- ✅ **All your financial data is stored locally** as plain JSON files on your own computer
- ✅ **No cloud, no accounts, no sign-up, no tracking, no telemetry**
- ✅ The app runs on a **local-only server** (`127.0.0.1`) — it is never reachable from the internet
- ✅ Your balances, transactions, metals, goals and backups **never leave your hard drive**
- ✅ Even if the internet goes down, the app keeps working normally

The **only** online activities are automatic update/market-data refreshes on launch and a few one-click buttons — and none involve your data:

| Activity                        | What it does                                          | Your data?                              |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| 🔄 Update check on launch       | Fetches the latest web version from GitHub            | ❌ Never sent                            |
| 💱 Exchange rates               | Downloads public FX rates from Frankfurter            | ❌ Only currency codes (e.g. EUR, USD)  |
| 🥇 Metal prices                 | Downloads public spot prices from gold-api.com        | ❌ Only metal symbols (XAU, XAG, XPT, XPD) |
| 🎨 UI styling                   | Bootstrap / fonts / charts loaded from CDNs           | ❌ Never sent                            |

> 🔒 **Not critical data:** The requests that fetch **gold prices** and **FX rates** only transmit public, non-sensitive identifiers — **currency codes** (e.g. `EUR`, `USD`) and **metal symbols** (e.g. `XAU`, `XAG`). No account balances, transaction amounts or personal data are ever sent. These lookups are purely market-data queries that reveal nothing about your finances.

Delete your data folder and nobody can ever recover it. **What's yours stays yours.** 🔐

---

## 🏗️ Architecture

> A simple, layered design — **thick client UI + thin local server + plain file storage**. No database, no external services required.

```
┌─────────────────────────────────────────────────────────────┐
│                  LIBERTY FINANCE DESKTOP APP                 │
│                      (C# .NET 10 WinForms)                   │
│                                                              │
│  ┌───────────────┐   ┌──────────────────────────────┐        │
│  │  Main Form    │   │  Embedded Server             │        │
│  │  (WebView2)   │──▶│  http://127.0.0.1:8765       │        │
│  └──────┬────────┘   │   · serves Web UI            │        │
│         │            │   · REST API (GET/POST data) │        │
│         │            └──────┬───────────────────────┘        │
│  ┌──────┴────────┐          │                                │
│  │ UpdateService │   ┌──────▼───────────────────────┐        │
│  │ BackupService │   │  LOCAL JSON DATA FILES        │        │
│  │ CrashLog      │   │  C:\LibertyFinance\Data       │        │
│  └───────────────┘   │   · <profile>.json            │        │
│                      │   · Backups\  (auto)          │        │
│                      │   · Logs\    (crash logs)     │        │
│                      └───────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ serves
              ┌───────────────┴────────────────┐
              │      WEB FRONTEND (vanilla)     │
              │  HTML · CSS · JavaScript        │
              │  Bootstrap 5 · Chart.js         │
              │  (dashboard + all modules)      │
              └─────────────────────────────────┘
```

### 🧩 Components

**Desktop Shell** (`Desktop/LibertyFinance.Shell/`) — C# .NET 10 + WinForms

- A borderless, dark-themed wrapper hosting the web UI inside **WebView2** 🖥️
- **EmbeddedServer**: a minimal `HttpListener` on `127.0.0.1` that serves the static UI and a small REST API (`/api/data`, `/api/files`, `/api/market`) — the single source of truth between UI and storage 🌐
- **BackupService**: snapshots all data files into `Backups\` on startup, keeping the newest N (default 30) 🗄️
- **UpdateService**: checks GitHub for a newer web build and atomically swaps the local web folder (with rollback safety) ⬆️
- **CrashLog**: unhandled exceptions are written to `Logs\crash.log` for diagnostics 📝

**Web Frontend** (`Web/`) — plain HTML/CSS/JavaScript (no framework)

- `index.html` — the profile picker / landing page 🚪
- `app.html` — the main SPA-style dashboard (hash-based routing: `#dashboard`, `#portfolios`, ...)
- `js/db.js` — a lightweight **file-backed data layer** with CRUD per entity store 📄
- `js/utils.js` — currency formatting, **date-based FX conversion**, asset depreciation math
- `js/app.js` — router, modals and CRUD orchestration
- `js/pages.js` — all page renderers: dashboard, portfolios, accounts, metals, assets, incomes, expenses, debts, goals, custodians, exchange rates, metal prices
- `css/style.css` — the full retro theme 🎨

**Data storage** — plain JSON, one file per profile (plus a shared market file for FX rates & metal prices). Zero SQL, zero cloud. 📄

---

## 🚀 Getting Started

### Requirements

- **Windows 10/11** (64-bit)
- **.NET 10 SDK** to build the desktop app
- **Microsoft Edge WebView2 Runtime** (auto-detected; install prompt on first run)

### Run in development

```powershell
# Build & run the desktop shell (it serves the Web folder from the repo in dev mode)
dotnet run --project Desktop/LibertyFinance.Shell
```

### Run the web UI standalone (browser)

```powershell
node Web/server.js
# → open http://localhost:8765
```

> ⚠️ The Node server is a dev convenience. The **desktop app** embeds the same server natively.

### Configuration (`Desktop/LibertyFinance.Shell/appsettings.json`)

```jsonc
{
  "GitHub": { "Owner": "barretobit", "Repo": "LibertyFinance", "Branch": "main", "WebFolder": "Web" },
  "Paths": { "DataRoot": "C:\\LibertyFinance\\Data" },
  "Backups": { "MaxFiles": 30 },
}
```

---

## 🧰 Tech Stack

| Layer            | Technology                                                |
| ---------------- | --------------------------------------------------------- |
| 🖥️ Desktop Shell | C# · .NET 10 · WinForms · WebView2                        |
| 🌐 Server        | Embedded HTTP server (`HttpListener`) on `127.0.0.1:8765` |
| 🎨 Frontend      | HTML5 · CSS3 · Vanilla JavaScript                         |
| 📦 UI Library    | Bootstrap 5 · Chart.js                                    |
| 🗄️ Storage       | Plain JSON files (fully local)                            |
| 💱 FX Data       | Frankfurter API (optional, user-initiated)                |
| 🥇 Metal Data    | gold-api.com (optional, user-initiated)                   |

---

## 📁 Repository Layout

```
LibertyFinance/
├── Desktop/
│   └── LibertyFinance.Shell/     # WinForms + embedded server + services
│       ├── MainForm.cs           # WebView2 host, status bar, actions
│       ├── EmbeddedServer.cs     # local HTTP server + data REST API
│       ├── BackupService.cs      # automatic startup backups
│       ├── UpdateService.cs      # self-update from GitHub
│       ├── CrashLog.cs           # local crash logging
│       └── AppConfig.cs          # appsettings.json binding
├── Web/                          # the frontend served to the app
│   ├── index.html                # profile picker
│   ├── app.html                  # main dashboard SPA
│   ├── server.js                 # Node dev server (optional)
│   ├── version.txt               # web UI version tag
│   ├── css/style.css             # retro theme
│   └── js/                       # db / utils / app / pages
└── LibertyFinance.slnx           # solution file
```

---

## 📜 License & Disclaimer

This is a **personal finance tool** — not investment, tax or legal advice. 🚫
The app provides a 12-month **forecast based on historical performance only**; past performance does not guarantee future results. Always back up your data folder (`C:\LibertyFinance\Data`) separately if it matters to you. 🛟

---

Made with 💚 by João Barreto - linkedin.com/in/barretobit. **Stay golden.** ✨
