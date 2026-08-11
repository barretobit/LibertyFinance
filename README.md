# 💰 LIBERTY FINANCE

> **Wealth Management System**: Track, manage and forecast your entire financial life from one place, with a slick retro inspired dark UI. 🎮

[![Open WebApp](https://img.shields.io/badge/Open_WebApp-Liberty_Finance-brightgreen.svg)](https://barretobit.github.io/LibertyFinance/)

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![HTML5](https://img.shields.io/badge/HTML-5-orange.svg)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2020+-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Bootstrap Version](https://img.shields.io/badge/Bootstrap-5.3.0+-blueviolet.svg)](https://getbootstrap.com/)

Liberty Finance is a **personal wealth management application** that runs **entirely in your browser**. No install, no `.exe`, no server: a pure static web app that reads and writes your data as **plain JSON files in a folder you choose**. Works on **Windows, macOS and Linux**, in Chrome, Edge, Firefox and Safari.

Current version: **v1.0** · Themed "Liberty City Network" 🌆

---

## ✨ Features

### 🖥️ MultiProfile Management

- Create and manage **multiple independent data profiles** (e.g. personal, business, family) 🗂️
- Every profile lives in its own JSON file; switch between them freely
- One click **export** to a JSON backup file and **import**/restore from any backup 📦
- Automatic **data backups** created every time you open a profile 🔄

### 📊 Dashboard

- **Net Worth**: the total value of everything you own, in your main currency 💵
- **Liquid Net Worth**: net worth excluding long term/non liquid holdings 🧊
- **Investment Performance**: computed over **YTD, 1Y, 2Y, 3Y and MAX** timeframes 📈
- **Performance Over Time** chart with selectable date ranges 📉
- **Portfolio Allocation** breakdown across your portfolios 🥧
- **Earning Performance**: your last 12 months of income, savings and investment performance in a carousel 📊
- **Yearly Performance**: net worth, liquid net worth, growth and management performance per year (last 5) 🗓️
- **Goals overview** with live waterfall allocation across funding accounts 🎯
- **Forecast**: a 12 month projection based on historical monthly ROI, with pessimistic / neutral / optimistic scenarios 🔮
- **Recent Transactions** feed for quick review 🧾

### 🗂️ Portfolios & Accounts

- Organize accounts into **portfolios** (e.g. Retirement, Growth, Emergency)
- Five account types: **Cash**, **Investment**, **Retirement Fund**, **Tangible Asset**, **Precious Metal** 🏦
- Per account **currency**, **custodian**, **starting value & date**
- Manage your **custodians** (banks, brokers, vaults) on a dedicated page 🏦
- Granular toggles: include in **performance chart**, **net worth** and **liquid net worth** ⚙️
- Track **deposits, withdrawals and valuations** with a full **transaction history** (including running balance) 🧮
- **Realized & unrealized P&L** and **cost basis** per account

### 🥇 Precious Metals

- Gold, Silver, Platinum and Palladium, tracked in **grams** ⚖️
- Buy / Sell metal with **price per gram**, auto calculated totals
- **Average cost basis** accounting across buys and sells
- Quantity, current price and unrealized P&L shown per metal account
- **Live spot prices** page: one click fetch of today's XAU/XAG/XPT/XPD prices (CHF/oz & CHF/g), stored per date 📈

### 💎 Tangible Assets

- Track valuables like cars, watches or furniture 🛋️
- **Straight line depreciation** per year (negative % = appreciation)
- Sell assets and track **realized P&L**

### 💵 Incomes & Expenses

- **Incomes**: source, amount, currency and date, with **average monthly** and **total net income** per year
- **Expenses**: monthly or yearly, per year breakdown with **annual cost** calculations 🧾

### 🧾 Debts

- Track what you **owe** and what is **owed to you** 🪙
- Description, person, direction, amount, date and notes

### 🎯 Goals

- Set **target values** with **priority ordering** (drag reordering via Up/Down)
- Allocate funding from specific accounts with **contribution percentages**
- **Waterfall funding engine**: available balance is claimed by goals in priority order automatically ⛲
- Live progress bars with "SHORT BY / EXCEED BY / TARGET REACHED" status

### 💱 Exchange Rates

- Fully **date based**: rates are stored per day, so historical values convert correctly 🗓️
- Currency conversion for all amounts into your **main currency** (CHF/EUR/USD/GBP/JPY)
- **Autofill** from the free **Frankfurter API** with one click (only foreign currencies actually used are fetched) 🔄
- **Startup sync**: today's FX snapshot is silently refreshed for the currencies your accounts actually use
- Manual save of rates for any date

---

## 🏗️ Architecture

> A simple, layered design: **static frontend + plain file storage**. No database, no server, no external services required.

```
┌───────────────────────────────────────────────────────────────┐
│                     LIBERTY FINANCE (WEB)                     │
│                    served by GitHub Pages / static host       │
│                                                               │
│  ┌───────────────┐   ┌───────────────────────────────────┐    │
│  │  index.html   │   │  app.html (dashboard + modules)   │    │
│  │  profile pick │──>│  js/db.js · Data Layer (DB.* API) │    │
│  └───────────────┘   └──────────┬────────────────────────┘    │
│                                 │ reads / writes via          │
│                                 v                             │
│  ┌───────────────────────────────────────────────────┐        │
│  │             js/storage.js · 2 adapters             │       │
│  │   Folder mode (Chrome/Edge/Opera)                  │       │
│  │     File System Access API → real files on disk    │       │
│  │   File mode (Firefox/Safari/all)                   │       │
│  │     open/download + in browser mirror              │       │
│  └──────────────────────┬─────────────────────────────┘       │
│                         │                                     │
│         YOUR DATA:  <profile>.json · market.json · Backups/   │
│                     (in a folder you choose; see below)       │
└───────────────────────────────────────────────────────────────┘
```

### 🧩 Components

- `index.html`: the profile picker / landing page 🚪
- `app.html`: the main dashboard (hash based routing: `#dashboard`, `#portfolios`, …)
- `js/db.js`: the **data layer**: a file backed CRUD API (`DB.*`) that the whole UI uses. It talks to the active storage adapter, so nothing else knows or cares where files live 📄
- `js/storage.js`: the **storage layer**: two interchangeable adapters plus a small IndexedDB helper (see below) 📂
- `js/utils.js`: currency formatting, **date based FX conversion**, asset depreciation math
- `js/app.js`: router, modals and CRUD orchestration
- `js/pages.js`: all page renderers: dashboard, portfolios, accounts, metals, assets, incomes, expenses, debts, goals, custodians, exchange rates, metal prices
- `server.js`: **local preview only** (static files; GitHub Pages serves the same files in production)

**Data storage**: plain JSON, one file per profile (plus a shared `market.json` for FX rates & metal prices). Zero SQL, zero cloud. 📄

---

## 📂 Storage & Compatibility

Your data always lives in **plain JSON files**. _How_ those files are read and written depends on your browser: browsers intentionally sandbox websites away from your hard drive, so the app can only touch files **you** pick.

### Folder mode (Chrome, Edge, Opera)

- Click **OPEN DATA FOLDER** and pick your data folder once. The app remembers it and reconnects automatically on your next visit.
- The button becomes **CHANGE DATA FOLDER** once connected. Click it anytime to switch to a different folder (e.g. if you picked the wrong one).
- Profiles are listed from that folder; **every save writes directly to the real `.json` file** on disk.
- A `Backups/` subfolder is created next to your data; every time you open a profile, a timestamped snapshot is saved (newest 30 kept).
- FX rates & metal prices are stored in `market.json` in the same folder, shared by all profiles.
- **Your files are just files**: copy them, back them up, open them in another device, anything.

### File mode (Firefox, Safari, and any other browser)

- Click **OPEN PROFILE FILE** to open a single `.json` profile.
- Edits are kept safe in an in browser mirror (IndexedDB), so nothing is lost between visits.
- Use **SAVE FILE** (settings menu inside the app) to **download** the current profile. That's how you keep a real updated file on disk.
- Backups and market data live in the browser's own storage, not on disk.
- **EXPORT** (settings menu) gives you a JSON backup file you can carry anywhere; **IMPORT** restores it.

### Same app, same data, everywhere

- All features, calculations and the JSON format are **identical in both modes**.
- Profiles are fully interchangeable between browsers and devices via EXPORT/IMPORT, or in folder mode, by copying the files themselves.
- The app never requires you to switch browsers; it simply adapts to what yours allows.

| Aspect      | Folder mode (Chrome/Edge/Opera)              | File mode (Firefox/Safari/…)         |
| ----------- | -------------------------------------------- | ------------------------------------ |
| Opening     | Pick a **folder** once → all profiles listed | Open **one `.json` file** at a time  |
| Saving      | Silent write back into that folder           | **SAVE FILE** downloads the profile  |
| Backups     | Real `Backups/` folder next to your data     | Inside browser storage (invisible)   |
| Market data | `market.json` in your folder                 | Inside browser storage               |
| Next visit  | Autoreconnects to your folder               | Reopens profile from browser storage |
| Moving data | Copy the files directly                      | Use EXPORT / IMPORT                  |

---

## 🔒 PRIVACY: Your Data Never Leaves Your Machine

- ✅ **All your financial data is stored as local files** (or, in file mode, in your browser's private storage), never in a database, never on a server
- ✅ **No accounts, no sign up, no tracking, no telemetry** in this app
- ✅ GitHub Pages only serves the static files; it has **no access** to your data and no code runs on their servers
- ✅ The app keeps working offline once the page is loaded

The **only** online activities are a few one click market data refreshes, and none involve your data:

| Activity          | What it does                                   | Your data?                                 |
| ----------------- | ---------------------------------------------- | ------------------------------------------ |
| 💱 Exchange rates | Downloads public FX rates from Frankfurter     | ❌ Only currency codes (e.g. EUR, USD)     |
| 🥇 Metal prices   | Downloads public spot prices from gold-api.com | ❌ Only metal symbols (XAU, XAG, XPT, XPD) |
| 🎨 UI styling     | Bootstrap / fonts / charts loaded from CDNs    | ❌ Never sent                              |

> 🔒 **Not critical data:** The requests that fetch **gold prices** and **FX rates** only transmit public, non sensitive identifiers: **currency codes** (e.g. `EUR`, `USD`) and **metal symbols** (e.g. `XAU`, `XAG`). No account balances, transaction amounts or personal data are ever sent.

Delete your data folder (or clear browser storage) and nobody can ever recover it. **What's yours stays yours.** 🔐

---

## 🚀 Getting Started

### Just use it

The app is hosted on GitHub Pages, no installation:

```
https://barretobit.github.io/LibertyFinance/
```

Open the link, choose a data folder or file, and you're in. Bookmark it.

---

## 🧰 Tech Stack

| Layer            | Technology                                            |
| ---------------- | ----------------------------------------------------- |
| 🏠 Hosting       | GitHub Pages (static, free, HTTPS)                    |
| 🎨 Frontend      | HTML5 · CSS3 · Vanilla JavaScript                     |
| 📦 UI Library    | Bootstrap 5 · Chart.js                                |
| 📂 Storage       | File System Access API + IndexedDB / plain JSON files |
| 💱 FX Data       | Frankfurter API (optional, userinitiated)            |
| 🥇 Metal Data    | gold-api.com (optional, user initiated)                   |
| 🧪 Local preview | `server.js` (static only) or any static file server   |

---

## 📁 Repository Layout

```
LibertyFinance/
├── index.html              # profile picker (landing page)
├── app.html                # main dashboard SPA
├── css/style.css           # retro theme
├── js/
│   ├── storage.js          # storage layer (folder + file adapters)
│   ├── db.js               # data layer (DB.* API on top of storage)
│   ├── utils.js            # FX conversion, formatting, depreciation
│   ├── app.js              # router, modals, CRUD orchestration
│   └── pages.js            # all page renderers
├── logo.png
├── version.txt             # web UI version tag
├── server.js               # static dev server (local preview only)
└── .nojekyll               # tells GitHub Pages to serve files asis
```

---

## 📜 License & Disclaimer

This is a **personal finance tool**, not investment, tax or legal advice. 🚫
The app provides a 12 month **forecast based on historical performance only**; past performance does not guarantee future results. Always keep a separate copy of your data folder (or an EXPORT backup) if it matters to you. 🛟

---

Made with 💚 by João Barreto (linkedin.com/in/barretobit). **Stay golden.** ✨
