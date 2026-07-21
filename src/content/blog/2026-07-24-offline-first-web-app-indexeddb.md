---
author: StevenPG
pubDatetime: 2026-07-24T12:00:00.000Z
title: Building an Offline-First Web App with IndexedDB (No Backend, No Account)
slug: offline-first-web-app-indexeddb
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - javascript
  - web
description: The making of CachePad — a Markdown notepad with no server, no account, and no network dependency. localStorage vs IndexedDB, autosave, storage persistence permissions, eviction, and export/import — the things you only learn the hard way.
---

# Building an Offline-First Web App with IndexedDB (No Backend, No Account)

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This is the making-of post for [CachePad](/projects/cachepad/) — a free Markdown notepad where your notes save automatically _in your browser_. No account, no server, works offline. This post is everything I learned shipping an app whose entire persistence layer is the user's browser: where the data actually lives, when the browser is allowed to delete it, and the escape hatches you owe your users.

Earlier this week I showed the [HTMX version of a notes app](/posts/htmx-spring-boot-no-frontend-framework) — server-rendered, server-owned state. CachePad is the opposite corner of the design space: **all state client-side, zero server involvement**. It's worth knowing how to build both, because the second one is the only architecture that gives users notes that are private by construction.

## Why No Backend Is a Feature

A notepad with a backend needs accounts, sessions, a database, a privacy policy that means something, and hosting costs proportional to users. A notepad without one needs a static file host. But the pitch to users is stronger than the pitch to my hosting bill: **the notes physically cannot leave your machine.** There's no server to breach and no account to leak. For quick-notes use cases, that's not a compromise — it's the product.

The cost is that the browser becomes your database, and browsers have opinions about being used that way. Those opinions are the rest of this post.

## localStorage vs IndexedDB: The Real Differences

Everyone reaches for `localStorage` first because the API is three methods. Here's the comparison that matters once you're storing something users care about:

|                        | localStorage              | IndexedDB                                        |
| ---------------------- | ------------------------- | ------------------------------------------------ |
| API                    | synchronous, strings only | async, structured objects/blobs                  |
| Practical capacity     | ~5 MB                     | large — % of disk, typically gigabytes available |
| Blocks the main thread | **yes, every call**       | no                                               |
| Queryable              | key → string              | indexes, ranges, cursors                         |
| Transactions           | none                      | real transactions                                |
| Web Worker access      | no                        | yes                                              |

The two that force the decision:

1. **Synchronous writes jank your UI.** An autosaving editor writes constantly; `localStorage.setItem` on the main thread with a multi-hundred-KB document is a visible stutter on keystroke. IndexedDB writes are async and can even move to a worker.
2. **5 MB is one enthusiastic user away.** Markdown is small until someone pastes a base64 image or keeps three years of daily notes. IndexedDB's quota is a share of the actual disk (inspect it via `navigator.storage.estimate()`).

The honest hybrid most local-first apps land on, CachePad included: **IndexedDB for the documents, localStorage for tiny UI preferences** (theme, last-open note id) where a synchronous string read at startup is exactly what you want.

## Taming the IndexedDB API

Raw IndexedDB is a 2010-era event-callback API and everyone's first hour with it is miserable. You have two sane options. Option one, the tiny [`idb`][idb] wrapper (~1 kB) that promisifies it:

```javascript
import { openDB } from "idb";

const db = await openDB("cachepad", 1, {
  upgrade(db) {
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("updatedAt", "updatedAt");
  },
});

// Write a note (one transaction)
await db.put("notes", {
  id: crypto.randomUUID(),
  title: "Untitled",
  body: "# Hello",
  updatedAt: Date.now(),
});

// Most-recently-edited list, straight off the index
const recent = await db.getAllFromIndex("notes", "updatedAt");
recent.reverse();
```

Option two is [Dexie][dexie] if you want a query builder and observable queries. Either way: the `upgrade` callback is your schema migration system — it runs when the version number bumps, and it's the only place object stores and indexes can be created. Treat version bumps with the same respect as the [Flyway migrations from yesterday](/posts/flyway-vs-liquibase-2026); it's the same job.

## Autosave That Doesn't Fight the User

The autosave loop that feels right in an editor is debounce-plus-flush:

```javascript
let pending = null;

function scheduleSave(note) {
  clearTimeout(pending);
  pending = setTimeout(() => save(note), 400);
}

// Flush on tab hide/close — the debounce timer won't fire if the tab dies
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pending) {
    clearTimeout(pending);
    saveNow();
  }
});
```

The `visibilitychange` flush is the part people miss: `beforeunload` is unreliable on mobile (and increasingly on desktop), while `visibilitychange → hidden` fires on tab switches, app switches, _and_ closes. Rule of thumb for local-first apps: **hidden means save.**

One more wrinkle: the same user can have your app open in two tabs. A [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) ping on save ("note X changed, reload if you're showing it") is a ten-line fix for last-write-wins surprises between a user's own tabs.

## The Part Nobody Tells You: Your Data Is "Best Effort"

Here's the hard-won section. Everything in browser storage is, by default, **evictable**. Under storage pressure the browser may wipe an origin's storage entirely — least-recently-used origins first. Safari is the aggressive one: ITP can delete all script-writable storage for a site you haven't visited in **seven days** (Safari exempts web apps saved to the Home Screen, which is the real answer on iOS). Your user's notes surviving is a probability you engineer, not a guarantee you get.

Three layers of defense:

**1. Ask for persistence.** One call flips the origin from "best effort" to "persistent" — exempt from automatic eviction:

```javascript
if (navigator.storage && navigator.storage.persist) {
  const persisted =
    (await navigator.storage.persisted()) ||
    (await navigator.storage.persist());
}
```

Chromium grants it heuristically (no prompt — more likely if the user has bookmarked or installed the site or visits often); Firefox prompts the user. It can resolve `false`; handle that honestly, which leads to…

**2. Tell users where their data lives.** CachePad's model — notes live in _this browser on this device_ — has real consequences: clearing site data deletes the notes, private windows are amnesiac, and notes don't follow you to another machine. A visible one-liner in the UI saying exactly that converts "your app ate my notes" into an informed choice. Silence converts it into a support email.

**3. Export/import — the feature that is actually a promise.** If you don't run the server, the user _is_ the backup admin, so hand them the tools:

```javascript
async function exportAll(db) {
  const notes = await db.getAll("notes");
  const blob = new Blob(
    [JSON.stringify({ version: 1, exportedAt: Date.now(), notes }, null, 2)],
    { type: "application/json" }
  );
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `cachepad-export-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
```

Import is the reverse with a version check and an id-collision policy (keep-newer is the sane default). The `version` field is your future self's migration path when the schema changes. Export/import also quietly solves "move to a new laptop" and "share between browsers" without ever building sync.

## Working Offline Is the Easy Part

Ironically, the "offline" in offline-first is the least code: a service worker that precaches the app shell (static HTML/JS/CSS — there's no API to cache, because there's no API):

```javascript
self.addEventListener("install", e =>
  e.waitUntil(
    caches.open("shell-v1").then(c => c.addAll(["/", "/app.js", "/app.css"]))
  )
);

self.addEventListener("fetch", e =>
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)))
);
```

Once the shell is cached and the data is in IndexedDB, airplane mode is indistinguishable from Wi-Fi. Add a manifest and the app is installable — which, notably, also strengthens the storage story (home-screen apps escape Safari's seven-day rule, and installation boosts Chromium's persistence heuristic). The PWA checklist isn't vanity here; it's part of the durability engineering.

## Summary

Building CachePad taught me that "no backend" doesn't mean "no persistence engineering" — it means the persistence engineering moves into territory most web developers never visit. The map of that territory:

1. **IndexedDB for documents, localStorage for preferences** — the thread-blocking and 5 MB walls are real
2. Wrap IndexedDB (`idb` or Dexie) and treat version upgrades as schema migrations
3. Autosave = debounce + flush on `visibilitychange: hidden`
4. Call `navigator.storage.persist()` — and design for it resolving `false`
5. Say out loud that data lives in this browser; browsers are allowed to evict it
6. **Ship export/import before shipping anything else** — it's the user's backup, migration, and sync story in one feature
7. Service worker + manifest last: offline shell is easy once the data layer is right

Try the result at [CachePad](/projects/cachepad/) — then open devtools → Application → IndexedDB and watch your notes land exactly where this post said they would.

[idb]: https://github.com/jakearchibald/idb
[dexie]: https://dexie.org/
[storage-api]: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API
